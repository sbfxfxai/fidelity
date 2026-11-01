//! KYC Registry Program — Fidelity Digital Asset Management
//!
//! Owns and manages on-chain KYC/AML status records for wallet addresses.
//! This is the authority program that the transfer hook reads foreign state from.
//! Deployed separately so its program ID acts as the unforgeable owner
//! reference inside the hook's owner-validation step.

use anchor_lang::prelude::*;

// The program ID emitted by the generated keypair.
// Must match target/deploy/kyc_registry-keypair.json
declare_id!("7b7KuUqicUcoTSvkdBXdc6KvX4hPyB5DergBsGssURsM");

// ---------------------------------------------------------------------------
// Account layout — shared with the transfer hook via crate import or layout copy
// ---------------------------------------------------------------------------

/// On-chain KYC/AML status for a single wallet address.
///
/// Space calculation:
///   8  (Anchor discriminator)
///   1  (is_approved: bool)
///   1  (compliance_level: u8)
///   1  (canonical_bump: u8)  — stored here so the hook can use
///                              create_program_address safely; the bump is
///                              read AFTER owner + discriminator are already
///                              verified, so it cannot be spoofed.
///   8  (approved_at: i64)
///   3  (jurisdiction: [u8;3])
///   32 (approved_by: Pubkey)
///  = 54 bytes + 8 discriminator = 62 total → pad to 64 for alignment.
#[account]
pub struct KycRecord {
    /// Whether this wallet is currently cleared to receive regulated tokens.
    pub is_approved: bool,
    /// 0 = unset, 1 = accredited investor, 2 = qualified purchaser, 3 = retail.
    pub compliance_level: u8,
    /// Canonical PDA bump — read by the hook to call create_program_address
    /// without accepting a caller-supplied value.
    pub canonical_bump: u8,
    /// Unix timestamp of last approval grant.
    pub approved_at: i64,
    /// ISO 3166-1 alpha-3 jurisdiction code (e.g. b"USA").
    pub jurisdiction: [u8; 3],
    /// Compliance officer who last updated this record.
    pub approved_by: Pubkey,
}

impl KycRecord {
    pub const LEN: usize = 8 + 1 + 1 + 1 + 8 + 3 + 32;
}

// ---------------------------------------------------------------------------
// Seeds constant — identical value used in the hook for PDA derivation
// ---------------------------------------------------------------------------
pub const KYC_SEED: &[u8] = b"kyc_status";

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod kyc_registry {
    use super::*;

    /// Creates a new KYC record for a wallet.
    ///
    /// Only callable by the `compliance_authority` — a multisig in production.
    /// The PDA is bound to the `wallet` address, ensuring one record per wallet.
    pub fn init_kyc_record(
        ctx: Context<InitKycRecord>,
        compliance_level: u8,
        jurisdiction: [u8; 3],
    ) -> Result<()> {
        require!(compliance_level <= 3, RegistryError::InvalidComplianceLevel);

        let record = &mut ctx.accounts.kyc_record;
        record.is_approved      = false; // Explicitly false until a grant is issued
        record.compliance_level = compliance_level;
        record.canonical_bump   = ctx.bumps.kyc_record;
        record.approved_at      = 0;
        record.jurisdiction     = jurisdiction;
        record.approved_by      = ctx.accounts.compliance_authority.key();

        msg!("KYC record initialised for wallet {}", ctx.accounts.wallet.key());
        Ok(())
    }

    /// Grants or revokes KYC approval for an existing record.
    ///
    /// This is the instruction the compliance system calls when a wallet:
    ///   - Completes KYC/AML onboarding (approved = true)
    ///   - Hits a sanctions list or initiates a redemption freeze (approved = false)
    ///
    /// A revocation issued here takes effect on the *next* transfer attempted
    /// by that wallet. For immediate effect, pair this with a
    /// `freeze_account` call on the wallet's token account via the mint's
    /// freeze authority — the freeze is atomic and does not depend on hook CPI timing.
    pub fn set_approval(
        ctx: Context<UpdateKycRecord>,
        is_approved: bool,
    ) -> Result<()> {
        let record = &mut ctx.accounts.kyc_record;
        record.is_approved  = is_approved;
        record.approved_at  = Clock::get()?.unix_timestamp;
        record.approved_by  = ctx.accounts.compliance_authority.key();

        msg!(
            "KYC record for {} set to approved={}",
            ctx.accounts.wallet.key(),
            is_approved
        );
        Ok(())
    }

    /// Updates compliance level (e.g. investor status change).
    pub fn update_compliance_level(
        ctx: Context<UpdateKycRecord>,
        compliance_level: u8,
    ) -> Result<()> {
        require!(compliance_level <= 3, RegistryError::InvalidComplianceLevel);
        ctx.accounts.kyc_record.compliance_level = compliance_level;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitKycRecord<'info> {
    /// The compliance officer authorised to manage records.
    /// In production this is a multisig PDA, not a hot wallet.
    #[account(mut)]
    pub compliance_authority: Signer<'info>,

    /// The wallet whose KYC status is being created.
    /// CHECK: Used only as a seed — no on-chain data needed.
    pub wallet: UncheckedAccount<'info>,

    /// The KYC record PDA, deterministically bound to `wallet`.
    #[account(
        init,
        payer = compliance_authority,
        space = KycRecord::LEN,
        seeds = [KYC_SEED, wallet.key().as_ref()],
        bump,
    )]
    pub kyc_record: Account<'info, KycRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateKycRecord<'info> {
    #[account(mut)]
    pub compliance_authority: Signer<'info>,

    /// CHECK: Used only as a seed.
    pub wallet: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [KYC_SEED, wallet.key().as_ref()],
        bump = kyc_record.canonical_bump,
    )]
    pub kyc_record: Account<'info, KycRecord>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum RegistryError {
    #[msg("Compliance level must be 0–3.")]
    InvalidComplianceLevel,
}
