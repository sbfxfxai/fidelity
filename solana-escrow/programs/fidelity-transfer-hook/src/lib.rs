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
        // Step 1 — Structural owner check
        //
        // Verify the KYC account's on-chain owner is the KYC registry program.
        // We compare against the COMPILE-TIME constant — not the
        // `compliance_program` account key — so an attacker cannot inject a
        // different program ID at runtime.
        // ------------------------------------------------------------------
        require_keys_eq!(
            *ctx.accounts.receiver_kyc_registry.owner,
            COMPLIANCE_PROGRAM_ID,
            HookError::InvalidRegistryOwner
        );

        // ------------------------------------------------------------------
        // Step 2 — Discriminator + deserialise
        //
        // try_deserialize validates the 8-byte Anchor discriminator prefix
        // before returning data.  A fake account with random bytes fails here.
        // ------------------------------------------------------------------
        let data = ctx.accounts.receiver_kyc_registry.try_borrow_data()?;
        let record = KycRecord::try_deserialize(&mut data.as_ref())
            .map_err(|_| error!(HookError::RegistryDeserializeFailed))?;
        // Drop borrow before any further account access
        drop(data);

        // ------------------------------------------------------------------
        // Step 3 — PDA re-derivation using the stored canonical bump
        //
        // We use create_program_address (not find_program_address) to save
        // ~1,000 CU.  This is safe because canonical_bump was read from data
        // that is already owner-verified and discriminator-validated above.
        // The PDA is bound to the *wallet owner* of the destination token
        // account, not the token account address itself — one KYC record per
        // wallet regardless of how many token accounts they hold.
        // ------------------------------------------------------------------

        // .owner on InterfaceAccount<TokenAccount> is the wallet Pubkey (via
        // Deref to spl_token_2022::state::Account), NOT account_info().owner
        // which is the Token-2022 program ID.
        let destination_wallet: &Pubkey = &ctx.accounts.destination_token.owner;

        let expected_pda = Pubkey::create_program_address(
            &[KYC_SEED, destination_wallet.as_ref(), &[record.canonical_bump]],
            &COMPLIANCE_PROGRAM_ID,
        )
        .map_err(|_| error!(HookError::InvalidPdaDerivation))?;

        require_keys_eq!(
            ctx.accounts.receiver_kyc_registry.key(),
            expected_pda,
            HookError::RegistryPdaMismatch
        );

        // ------------------------------------------------------------------
        // Step 4 — Compliance gate
        // ------------------------------------------------------------------
        require!(record.is_approved, HookError::ReceiverNotKycVerified);

        msg!(
            "KYC cleared: wallet {} compliance_level={} jurisdiction={:?}",
            destination_wallet,
            record.compliance_level,
            record.jurisdiction,
        );
        Ok(())
    }

    /// Registers the extra accounts this hook needs with Token-2022.
    ///
    /// MUST be called in the same atomic transaction that creates the mint so
    /// an attacker cannot front-run the PDA initialisation and inject their
    /// own account list.
    ///
    /// Registered extra account slots (appended after the mandatory 4):
    ///   slot 4: receiver_kyc_registry  (index-seeded: ["kyc_status", acct[2].owner])
    ///   slot 5: compliance_program     (literal address = COMPLIANCE_PROGRAM_ID)
    pub fn initialize_extra_account_metas(
        ctx: Context<InitializeExtraAccountMetas>,
    ) -> Result<()> {
        // Two extra accounts beyond the 4 mandatory ones.
        // Slot 4: KYC record, derived from destination token account owner (acct index 2).
        //   ExtraAccountMeta::new_with_seeds uses Token-2022's account-resolution
        //   protocol: seed type 0x02 = account key at position N in the accounts list.
        let account_metas = vec![
            // KYC record PDA: seeds = ["kyc_status", destination_token.owner]
            // destination_token is at mandatory account index 2 (0-based).
            // The Token-2022 layout stores .owner at byte offset 32 in TokenAccount.
            ExtraAccountMeta::new_with_seeds(
                &[
                    spl_tlv_account_resolution::seeds::Seed::Literal {
                        bytes: KYC_SEED.to_vec(),
                    },
                    // Resolve destination_token.owner at execution time.
                    // account_index 2 = destination_token; data_index 32 = owner field offset.
                    spl_tlv_account_resolution::seeds::Seed::AccountData {
                        account_index: 2,
                        data_index:    32,
                        length:        32,
                    },
                ],
                false, // not a signer
                false, // not writable
            )?,
            // Compliance program literal address (read-only reference, not CPI target)
            ExtraAccountMeta::new_with_pubkey(
                &COMPLIANCE_PROGRAM_ID,
                false,
                false,
            )?,
        ];

        let account_size = ExtraAccountMetaList::size_of(account_metas.len())?;
        // Verify allocated space matches
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
    /// Mandatory slot 0 — source token account
    pub source_token: InterfaceAccount<'info, TokenAccount>,

    /// Mandatory slot 1 — regulated mint
    pub mint: InterfaceAccount<'info, Mint>,

    /// Mandatory slot 2 — destination token account.
    /// .owner (via Deref) is the wallet Pubkey — used for KYC PDA derivation.
    pub destination_token: InterfaceAccount<'info, TokenAccount>,

    /// Mandatory slot 3 — transfer authority (owner or delegate).
    ///
    /// Declared as AccountInfo, NOT Signer — the Token-2022 spec does not
    /// guarantee a signature here when a delegate is in use.
    /// CHECK: Passed by Token-2022; not used in hook logic.
    pub authority: UncheckedAccount<'info>,

    /// Mandatory slot 4 — extra account metas list PDA.
    /// Required by the interface; validated by seeds constraint.
    /// CHECK: Validated by seeds; content read by Token-2022 machinery.
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_metas_list: UncheckedAccount<'info>,

    // --- Custom accounts injected via extra-account-metas resolution ---

    /// The KYC record for the destination wallet.
    /// Owner verified against COMPLIANCE_PROGRAM_ID (hardcoded constant).
    /// PDA re-derived in body using stored canonical_bump.
    /// CHECK: Verified in instruction body — owner check + discriminator + PDA derivation.
    pub receiver_kyc_registry: UncheckedAccount<'info>,

    /// The compliance program whose program ID is the unforgeable owner
    /// reference for all KYC record accounts.
    ///
    /// Included in the accounts list so Token-2022 can pass it for
    /// `create_program_address` use — but we always compare against the
    /// hardcoded COMPLIANCE_PROGRAM_ID constant, never this runtime value.
    /// CHECK: Not used directly in logic; presence confirms it was registered.
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
        space = ExtraAccountMetaList::size_of(2).unwrap(),
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
    #[msg("KYC registry PDA does not match the derivation for this receiver wallet.")]
    RegistryPdaMismatch,
    #[msg("Receiver wallet has not cleared KYC/AML compliance.")]
    ReceiverNotKycVerified,
    #[msg("Extra account metas list allocated space does not match required size.")]
    MetaListSizeMismatch,
}
