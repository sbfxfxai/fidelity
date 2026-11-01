//! Fidelity Transfer Hook Program
//!
//! Implements the spl-transfer-hook-interface `execute` instruction.
//! Token-2022 calls this program as a nested CPI on every `transfer_checked`
//! issued against the regulated mint, enforcing KYC/AML compliance before
//! the transfer is finalised.
//!
//! # Security model
//!
//! The `compliance_program` address is a **compile-time constant** baked into
//! this binary.  It is not passed as a runtime account parameter.  This closes
//! the primary spoofing attack vector where an attacker passes their own
//! program as `compliance_program`, satisfies the owner check with a fake KYC
//! record owned by that program, and bypasses the gate entirely.
//!
//! # CU budget
//!
//! Token-2022 allocates a fixed CU slice to the hook CPI.  We stay within
//! budget by reading `canonical_bump` from already-owner-verified account data
//! and using `create_program_address` (~500 CU) instead of the canonical
//! `find_program_address` (~1,500 CU).  The bump is safe to use here because
//! it is read *after* the owner check and discriminator validation — it comes
//! from data we already trust.
//!
//! # Threat vectors addressed
//!
//! 1. Spoofed registry (fake program, fake data)
//!    → compliance_program is a hardcoded constant; runtime value is ignored.
//! 2. Spoofed PDA (correct program, wrong seeds)
//!    → create_program_address with the stored bump re-derives the address and
//!      compares it against the account key.
//! 3. Stale-state revocation race
//!    → is_approved flag is the soft gate; freeze_authority on the mint is the
//!      hard gate and is atomic.  Both must be set in a compliance workflow.
//! 4. Delegate authority bypass
//!    → KYC is bound to the destination token account's wallet owner, not the
//!      transaction signer, so delegate-authorised transfers are still gated.
//! 5. ConfidentialTransfer interaction
//!    → This hook does not inspect `amount`; it is purely identity-gated.
//!      Volume-threshold reporting must be implemented at the off-chain
//!      compliance layer via transaction log monitoring, since encrypted amounts
//!      are not available inside the hook.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta,
    state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

declare_id!("23kV2bhRWCGeyCjZrJHpdnWq9jyjZfP5tJ1JYHWmcAAB");

// ---------------------------------------------------------------------------
// Hardcoded compliance program ID
//
// CRITICAL: this must never be accepted as a runtime parameter.  Changing the
// KYC registry requires redeploying the hook program (which itself requires
// governance approval), not just passing a different account key at runtime.
// ---------------------------------------------------------------------------
pub const COMPLIANCE_PROGRAM_ID: Pubkey =
    pubkey!("7b7KuUqicUcoTSvkdBXdc6KvX4hPyB5DergBsGssURsM");

/// Seed shared with the kyc-registry program.
pub const KYC_SEED: &[u8] = b"kyc_status";

// ---------------------------------------------------------------------------
// KycRecord layout mirror
//
// In a production monorepo the hook would import this from the kyc-registry
// crate directly.  We replicate it here to keep the programs independently
// deployable without circular crate dependencies.
// The discriminator is sha256("account:KycRecord")[..8] — both programs must
// use the exact same struct name for the discriminators to match.
// ---------------------------------------------------------------------------
#[account]
pub struct KycRecord {
    pub is_approved:      bool,
    pub compliance_level: u8,
    /// Canonical PDA bump — safe to read post-owner-check for create_program_address.
    pub canonical_bump:   u8,
    pub approved_at:      i64,
    pub jurisdiction:     [u8; 3],
    pub approved_by:      Pubkey,
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod fidelity_transfer_hook {
    use super::*;

    /// Called by Token-2022 as a CPI on every `transfer_checked`.
    ///
    /// Account order is **mandated** by spl-transfer-hook-interface and must
    /// match the extra-account-metas list registered in
    /// `initialize_extra_account_metas`.  Do not reorder.
    pub fn execute(ctx: Context<ExecuteTransfer>, _amount: u64) -> Result<()> {
        msg!("FDAM compliance hook: evaluating transfer...");

        // ------------------------------------------------------------------
        // Shared helper: validate a KYC registry account against a wallet.
        // Runs the same 4-layer check for both sender and receiver so neither
        // can bypass the gate, and a revoked sender can't transfer even before
        // the freeze account instruction lands.
        // ------------------------------------------------------------------
        let validate_kyc = |registry: &AccountInfo,
                             wallet: &Pubkey|
         -> Result<()> {
            // Layer 1 — owner must be the hardcoded compliance program constant.
            require_keys_eq!(
                *registry.owner,
                COMPLIANCE_PROGRAM_ID,
                HookError::InvalidRegistryOwner
            );

            // Layer 2 — discriminator-validated deserialise.
            let data = registry.try_borrow_data()?;
            let record = KycRecord::try_deserialize(&mut data.as_ref())
                .map_err(|_| error!(HookError::RegistryDeserializeFailed))?;
            drop(data);

            // Layer 3 — PDA re-derivation using the stored canonical bump.
            // create_program_address (~500 CU) is safe here because the bump
            // was read from data whose owner and discriminator are already
            // verified above.
            let expected_pda = Pubkey::create_program_address(
                &[KYC_SEED, wallet.as_ref(), &[record.canonical_bump]],
                &COMPLIANCE_PROGRAM_ID,
            )
            .map_err(|_| error!(HookError::InvalidPdaDerivation))?;

            require_keys_eq!(
                *registry.key,
                expected_pda,
                HookError::RegistryPdaMismatch
            );

            // Layer 4 — compliance gate.
            require!(record.is_approved, HookError::WalletNotKycVerified);

            Ok(())
        };

        // Sender check: prevents a revoked holder from initiating a transfer
        // in the window between flag revocation and freeze_account landing.
        let source_wallet: Pubkey = ctx.accounts.source_token.owner;
        validate_kyc(
            ctx.accounts.sender_kyc_registry.as_ref(),
            &source_wallet,
        )?;

        // Receiver check: prevents transfer to an unapproved wallet.
        let destination_wallet: Pubkey = ctx.accounts.destination_token.owner;
        validate_kyc(
            ctx.accounts.receiver_kyc_registry.as_ref(),
            &destination_wallet,
        )?;

        msg!(
            "KYC cleared: sender {} receiver {} — transfer authorised",
            source_wallet,
            destination_wallet,
        );
        Ok(())
    }

    /// Registers the extra accounts this hook needs with Token-2022.
    ///
    /// MUST be called in the same atomic transaction that creates the mint so
    /// an attacker cannot front-run the PDA initialisation and inject their
    /// own account list.
    ///
    /// Registered extra account slots (appended after the mandatory 5):
    ///   slot 5: sender_kyc_registry    (seed-resolved: ["kyc_status", acct[0].owner])
    ///   slot 6: receiver_kyc_registry  (seed-resolved: ["kyc_status", acct[2].owner])
    ///   slot 7: compliance_program     (literal address = COMPLIANCE_PROGRAM_ID)
    pub fn initialize_extra_account_metas(
        ctx: Context<InitializeExtraAccountMetas>,
    ) -> Result<()> {
        // Mandatory account indices (0-based, as Token-2022 passes them):
        //   0 = source_token       (owner field at byte offset 32)
        //   1 = mint
        //   2 = destination_token  (owner field at byte offset 32)
        //   3 = authority
        //   4 = extra_account_metas_list (this PDA)
        let account_metas = vec![
            // Slot 5 — sender KYC record PDA
            // seeds = ["kyc_status", source_token.owner]
            // source_token is account index 0; .owner field is at byte offset 32.
            ExtraAccountMeta::new_with_seeds(
                &[
                    spl_tlv_account_resolution::seeds::Seed::Literal {
                        bytes: KYC_SEED.to_vec(),
                    },
                    spl_tlv_account_resolution::seeds::Seed::AccountData {
                        account_index: 0, // source_token
                        data_index:    32, // offset of .owner in TokenAccount layout
                        length:        32,
                    },
                ],
                false,
                false,
            )?,
            // Slot 6 — receiver KYC record PDA
            // seeds = ["kyc_status", destination_token.owner]
            // destination_token is account index 2.
            ExtraAccountMeta::new_with_seeds(
                &[
                    spl_tlv_account_resolution::seeds::Seed::Literal {
                        bytes: KYC_SEED.to_vec(),
                    },
                    spl_tlv_account_resolution::seeds::Seed::AccountData {
                        account_index: 2, // destination_token
                        data_index:    32,
                        length:        32,
                    },
                ],
                false,
                false,
            )?,
            // Slot 7 — compliance program literal address
            ExtraAccountMeta::new_with_pubkey(
                &COMPLIANCE_PROGRAM_ID,
                false,
                false,
            )?,
        ];

        let account_size = ExtraAccountMetaList::size_of(account_metas.len())?;
        require_eq!(
            ctx.accounts.extra_account_metas_list.data_len(),
            account_size,
            HookError::MetaListSizeMismatch
        );

        let mut data = ctx.accounts.extra_account_metas_list.try_borrow_mut_data()?;
        ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &account_metas)?;

        msg!("Extra account metas initialised for mint {}", ctx.accounts.mint.key());
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

/// Mandatory account layout for spl-transfer-hook-interface `execute`.
///
/// The first 4 accounts (source_token, mint, destination_token, authority)
/// are injected by Token-2022 in this exact order.  Do NOT reorder them.
/// The 5th account (extra_account_metas_list) is required by the interface
/// machinery to resolve the remaining custom accounts.
/// Accounts 6+ are populated by the Token-2022 account-resolution protocol
/// using the data registered in `initialize_extra_account_metas`.
#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    /// Mandatory slot 0 — source token account.
    /// .owner (via Deref) is the sender wallet — used for sender KYC derivation.
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    /// Mandatory slot 1 — regulated mint
    pub mint: InterfaceAccount<'info, Mint>,

    /// Mandatory slot 2 — destination token account.
    /// .owner (via Deref) is the receiver wallet — used for receiver KYC derivation.
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    /// Mandatory slot 3 — transfer authority (owner or delegate).
    ///
    /// Declared as UncheckedAccount, NOT Signer — the Token-2022 spec does not
    /// guarantee a signature here when a delegate is in use.
    /// CHECK: Passed by Token-2022; not used in hook logic.
    pub authority: UncheckedAccount<'info>,

    /// Mandatory slot 4 — extra account metas list PDA.
    /// Required by the interface; validated by seeds constraint.
    /// CHECK: Validated by seeds; content read by Token-2022 machinery.
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_metas_list: UncheckedAccount<'info>,

    // --- Custom accounts injected via extra-account-metas resolution ---

    /// Slot 5 — KYC record for the sending wallet.
    /// Prevents a revoked holder from initiating a transfer before freeze lands.
    /// CHECK: Owner + discriminator + PDA verified in execute() body.
    pub sender_kyc_registry: UncheckedAccount<'info>,

    /// Slot 6 — KYC record for the receiving wallet.
    /// CHECK: Owner + discriminator + PDA verified in execute() body.
    pub receiver_kyc_registry: UncheckedAccount<'info>,

    /// Slot 7 — compliance program literal address.
    /// We always compare KYC account owners against the hardcoded
    /// COMPLIANCE_PROGRAM_ID constant, never this runtime value.
    /// CHECK: Present for account-resolution bookkeeping only.
    pub compliance_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetas<'info> {
    /// Fee payer — must be the mint authority to prevent unauthorised registration.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The regulated mint this hook is attached to.
    pub mint: InterfaceAccount<'info, Mint>,

    /// Caller must be the mint authority to register hook accounts.
    /// Constraint: key must match mint.mint_authority — prevents any signer
    /// other than the actual mint authority from initialising the meta list.
    #[account(
        constraint = mint.mint_authority.contains(&mint_authority.key())
            @ HookError::UnauthorizedMetaInit
    )]
    pub mint_authority: Signer<'info>,

    /// The extra account metas list PDA for this mint.
    /// Initialised here; Token-2022 reads it on every transfer.
    ///
    /// Space is set to ExtraAccountMetaList::size_of(2) — must be computed
    /// off-chain and passed as the account's allocated size at creation.
    /// CHECK: Content written by ExtraAccountMetaList::init in instruction body.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(3).unwrap(),
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump,
    )]
    pub extra_account_metas_list: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum HookError {
    #[msg("KYC registry account not owned by the official compliance program.")]
    InvalidRegistryOwner,
    #[msg("KYC registry account data could not be deserialised — invalid discriminator.")]
    RegistryDeserializeFailed,
    #[msg("PDA re-derivation failed — canonical_bump is invalid.")]
    InvalidPdaDerivation,
    #[msg("KYC registry PDA does not match the derivation for this wallet.")]
    RegistryPdaMismatch,
    #[msg("Wallet has not cleared KYC/AML compliance.")]
    WalletNotKycVerified,
    #[msg("Extra account metas list allocated space does not match required size.")]
    MetaListSizeMismatch,
    #[msg("Signer is not the mint authority for this regulated mint.")]
    UnauthorizedMetaInit,
}
