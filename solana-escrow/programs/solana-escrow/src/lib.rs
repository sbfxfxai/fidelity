use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

// ---------------------------------------------------------------------------
// Condition program ID
//
// SECURITY: This must be hardcoded, not accepted at runtime.
// Accepting `condition_program` as a runtime UncheckedAccount and comparing
// `external_condition_state.owner == condition_program.key()` is a spoofing
// vector: an attacker passes their own program as both accounts and satisfies
// the owner check trivially.
//
// In production, set this to the deployed address of the external escrow
// condition program. Any change requires a governance-approved redeploy of
// this binary.
// ---------------------------------------------------------------------------
pub const CONDITION_PROGRAM_ID: Pubkey =
    pubkey!("ivVk3oF3Vc6LE2nAtTaRyEa6ceg8V7fkSGEkJ1Bbnv1"); // self-referential for local tests

// ---------------------------------------------------------------------------
// External program state layout
// ---------------------------------------------------------------------------

/// Mirrors the on-chain data layout of Program B's condition account.
///
/// # Owner validation
///
/// Anchor's `Account<'info, T>` enforces that the account's runtime owner
/// matches `T::owner()`, which is derived from the `#[account]` macro and
/// resolves to **the program that defined the struct** — i.e. *this* program.
///
/// That is wrong for a foreign account: if Program B owns the account,
/// `T::owner()` would point at us, and validation would always fail.
///
/// The correct approach for deserialising a *foreign* program's account is:
///   1. Use `UncheckedAccount` in the context so Anchor skips its owner check.
///   2. Verify `account.owner == expected_program_b_id` manually.
///   3. Deserialise with `AccountDeserialize::try_deserialize`, which validates
///      the 8-byte Anchor discriminator prefix.
///
/// In production you import this struct (and its `DISCRIMINATOR`) directly from
/// the third-party crate; here we replicate it to keep the repo self-contained.
#[account]
pub struct ExternalConditionAccount {
    pub initializer: Pubkey,
    pub asset_mint: Pubkey,
    /// Set to `true` by Program B when the external event is complete.
    pub is_completed: bool,
    /// The wallet that is authorised to collect the escrowed tokens.
    pub target_buyer: Pubkey,
}

declare_id!("ivVk3oF3Vc6LE2nAtTaRyEa6ceg8V7fkSGEkJ1Bbnv1");

#[program]
pub mod solana_escrow {
    use super::*;

    /// Deposits tokens from a user into a program-controlled PDA vault.
    ///
    /// The vault token account is created on the first call (init_if_needed).
    /// Its authority is set to `vault_authority` — a separate, program-controlled
    /// PDA — so only this program can authorise withdrawals.
    pub fn deposit_to_vault(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            // User signs directly for the deposit — no PDA signature needed here.
            authority: ctx.accounts.user.to_account_info(),
        };

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );

        token::transfer(cpi_ctx, amount)?;

        msg!("Deposited {} tokens into vault.", amount);
        Ok(())
    }

    /// Initialises an `ExternalConditionAccount` for testing purposes.
    ///
    /// In production this instruction lives in Program B. We include it here
    /// purely so the local test validator can create properly-owned, properly-
    /// discriminated condition accounts without deploying a second binary.
    pub fn init_condition(
        ctx: Context<InitCondition>,
        initializer: Pubkey,
        asset_mint: Pubkey,
        is_completed: bool,
        target_buyer: Pubkey,
    ) -> Result<()> {
        let state = &mut ctx.accounts.condition_state;
        state.initializer = initializer;
        state.asset_mint = asset_mint;
        state.is_completed = is_completed;
        state.target_buyer = target_buyer;
        Ok(())
    }

    /// Conditional withdrawal gated on a third-party program's state account.
    ///
    /// Program B's account is passed in as `UncheckedAccount` and then manually
    /// owner-checked and Borsh-deserialised, giving us the same safety as
    /// `Account<'info, T>` but with the correct Program B owner ID instead of
    /// our own program ID.
    pub fn conditional_withdraw(
        ctx: Context<ConditionalWithdraw>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);

        // --- Cross-program state check -----------------------------------------
        // Step 1: verify that the condition account is owned by the hardcoded
        //         CONDITION_PROGRAM_ID constant — not the runtime account key.
        //         This prevents the attack where an attacker passes their own
        //         program as both external_condition_state owner and condition_program.
        require_keys_eq!(
            *ctx.accounts.external_condition_state.owner,
            CONDITION_PROGRAM_ID,
            EscrowError::InvalidConditionOwner
        );

        // Step 2: deserialise the raw account data, validating the 8-byte
        //         Anchor discriminator in the process.
        let data = ctx.accounts.external_condition_state.try_borrow_data()?;
        let state = ExternalConditionAccount::try_deserialize(&mut data.as_ref())
            .map_err(|_| error!(EscrowError::ConditionDeserializeFailed))?;

        // Step 3: business-logic gates.
        require!(state.is_completed, EscrowError::ConditionNotMet);
        require!(
            state.target_buyer == ctx.accounts.user.key(),
            EscrowError::UnauthorizedWithdrawal
        );
        // -----------------------------------------------------------------------

        require!(
            ctx.accounts.vault_token_account.amount >= amount,
            EscrowError::InsufficientFunds
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };

        let user_key = ctx.accounts.user.key();
        let bump = ctx.bumps.vault_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault_authority",
            user_key.as_ref(),
            &[bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, amount)?;

        msg!("Conditional withdraw: cross-program state verified. Tokens released.");
        Ok(())
    }

    /// Withdraws tokens from the PDA vault back to the user.
    ///
    /// The program signs the CPI on behalf of `vault_authority` using
    /// `CpiContext::new_with_signer` and the deterministic PDA seeds.
    pub fn withdraw_from_vault(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);

        // Explicit balance guard — don't rely solely on the SPL program to reject.
        require!(
            ctx.accounts.vault_token_account.amount >= amount,
            EscrowError::InsufficientFunds
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };

        // Bump is extracted into a local binding before constructing the slice
        // to avoid a dangling reference to a temporary.
        let user_key = ctx.accounts.user.key();
        let bump = ctx.bumps.vault_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"vault_authority",
            user_key.as_ref(),
            &[bump],
        ]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, amount)?;

        msg!("Withdrew {} tokens from vault.", amount);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// The user making the deposit — must sign the transaction.
    #[account(mut)]
    pub user: Signer<'info>,

    /// The user's source token account.
    /// Validated: owner must match the signer and mint must match the vault mint.
    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ EscrowError::InvalidOwner,
        constraint = user_token_account.mint == mint.key() @ EscrowError::MintMismatch
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// The PDA token account acting as the vault.
    /// Created on first deposit; reused on subsequent ones (init_if_needed).
    /// Authority is `vault_authority`, NOT the token account itself.
    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"vault", user.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = vault_authority,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// The mint of the token being deposited.
    /// Anchor uses this account directly for token initialisation constraints.
    pub mint: Account<'info, anchor_spl::token::Mint>,

    /// A separate PDA that holds signing authority over the vault.
    /// The program can produce a valid signature for it via seeds + bump.
    ///
    /// CHECK: This account holds no data. It is validated entirely by its
    /// seeds constraint and is only used as a CPI authority signer.
    #[account(seeds = [b"vault_authority", user.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// The user reclaiming their tokens — must sign the transaction.
    #[account(mut)]
    pub user: Signer<'info>,

    /// The user's destination token account.
    /// Validated: owner AND mint must match the vault.
    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ EscrowError::InvalidOwner,
        constraint = user_token_account.mint == vault_token_account.mint @ EscrowError::MintMismatch
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// The vault PDA token account to withdraw from.
    /// `close = user` returns the rent lamports once the balance reaches zero.
    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump,
        close = user
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: Validated via seeds constraint. The program signs on behalf of
    /// this PDA using CpiContext::new_with_signer.
    #[account(seeds = [b"vault_authority", user.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitCondition<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + 32 + 32 + 1 + 32, // discriminator + fields
        seeds = [b"condition", payer.key().as_ref()],
        bump,
    )]
    pub condition_state: Account<'info, ExternalConditionAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConditionalWithdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Destination token account — owner and mint validated against vault.
    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ EscrowError::InvalidOwner,
        constraint = user_token_account.mint == vault_token_account.mint @ EscrowError::MintMismatch
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", user.key().as_ref()],
        bump,
        close = user
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA authority — validated by seeds constraint.
    #[account(seeds = [b"vault_authority", user.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    /// The external Program B's state account.
    ///
    /// Declared as `UncheckedAccount` so that Anchor does NOT apply its default
    /// owner check (which would compare against *our* program ID instead of
    /// Program B's).  We perform owner verification manually in the instruction
    /// body — checking `account.owner == condition_program.key()` — before
    /// deserialising the Borsh payload.
    ///
    /// CHECK: Owner verified against `condition_program` key; discriminator
    /// validated by `ExternalConditionAccount::try_deserialize` in instruction body.
    pub external_condition_state: UncheckedAccount<'info>,

    /// The external program reference — present only for account-resolution
    /// bookkeeping. The actual owner comparison in the instruction body uses
    /// the hardcoded CONDITION_PROGRAM_ID constant, not this runtime key.
    ///
    /// CHECK: Not used in the owner comparison; CONDITION_PROGRAM_ID is the
    /// authoritative value.
    pub condition_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Token account owner does not match the signer.")]
    InvalidOwner,
    #[msg("Vault does not hold sufficient funds for this withdrawal.")]
    InsufficientFunds,
    #[msg("Destination token account mint does not match the vault mint.")]
    MintMismatch,
    #[msg("The external condition account is not owned by the expected program.")]
    InvalidConditionOwner,
    #[msg("The external condition account data could not be deserialised.")]
    ConditionDeserializeFailed,
    #[msg("The external cross-program condition has not been fulfilled yet.")]
    ConditionNotMet,
    #[msg("The signer is not the authorised buyer in the external condition account.")]
    UnauthorizedWithdrawal,
}
