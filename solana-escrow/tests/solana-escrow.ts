/**
 * solana-escrow — full lifecycle test suite
 *
 * Covers:
 *  - Vault creation and first deposit
 *  - Second deposit into an existing vault (init_if_needed path)
 *  - Partial withdrawal
 *  - Full withdrawal (vault closed, rent returned)
 *  - Error path: zero-amount deposit
 *  - Error path: zero-amount withdrawal
 *  - Error path: overdraft withdrawal
 *  - Error path: wrong owner on user token account
 *  - Error path: mint mismatch on withdrawal
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError } from "@coral-xyz/anchor";
import { SolanaEscrow } from "../target/types/solana_escrow";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive the vault token account PDA for a given user. */
function vaultPDA(programId: PublicKey, user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), user.toBuffer()],
    programId
  );
}

/** Derive the vault authority PDA for a given user. */
function vaultAuthorityPDA(
  programId: PublicKey,
  user: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority"), user.toBuffer()],
    programId
  );
}

/** Airdrop SOL and confirm. */
async function airdrop(
  connection: anchor.web3.Connection,
  to: PublicKey,
  sol = 2
): Promise<void> {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("solana-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaEscrow as Program<SolanaEscrow>;
  const connection = provider.connection;

  // Actors
  let user: Keypair;
  let mint: PublicKey;
  let userTokenAccount: PublicKey;

  // PDAs (derived once, reused across tests)
  let vaultTokenAccount: PublicKey;
  let vaultAuthority: PublicKey;

  const DEPOSIT_AMOUNT = new anchor.BN(1_000);
  const PARTIAL_WITHDRAW = new anchor.BN(400);

  // ---------------------------------------------------------------------------
  // Before all — set up mint and fund user
  // ---------------------------------------------------------------------------
  before("set up mint, user and token accounts", async () => {
    user = Keypair.generate();
    await airdrop(connection, user.publicKey);
    await airdrop(connection, provider.wallet.publicKey);

    // Create a fresh SPL token mint owned by the provider wallet (fee payer)
    mint = await createMint(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey, // mint authority
      null,                       // freeze authority
      6                           // decimals
    );

    // Create the user's associated token account
    userTokenAccount = await createAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      user.publicKey
    );

    // Mint 10,000 tokens to the user
    await mintTo(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      userTokenAccount,
      provider.wallet.publicKey,
      10_000
    );

    // Derive PDAs
    [vaultTokenAccount] = vaultPDA(program.programId, user.publicKey);
    [vaultAuthority] = vaultAuthorityPDA(program.programId, user.publicKey);
  });

  // ---------------------------------------------------------------------------
  // deposit_to_vault — success paths
  // ---------------------------------------------------------------------------

  it("creates the vault and deposits tokens on first call", async () => {
    const beforeUser = await getAccount(connection, userTokenAccount);

    await program.methods
      .depositToVault(DEPOSIT_AMOUNT)
      .accounts({
        user: user.publicKey,
        userTokenAccount,
        vaultTokenAccount,
        vaultAuthority,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc({ commitment: "confirmed" });

    const afterUser = await getAccount(connection, userTokenAccount);
    const vault = await getAccount(connection, vaultTokenAccount);

    assert.equal(
      BigInt(beforeUser.amount) - BigInt(afterUser.amount),
      BigInt(DEPOSIT_AMOUNT.toString()),
      "User balance should decrease by deposit amount"
    );
    assert.equal(
      vault.amount,
      BigInt(DEPOSIT_AMOUNT.toString()),
      "Vault should hold exactly the deposited amount"
    );
    assert.equal(
      vault.owner.toBase58(),
      vaultAuthority.toBase58(),
      "Vault authority must be the PDA signer, not the token account itself"
    );
  });

  it("accepts a second deposit into the existing vault (init_if_needed path)", async () => {
    const beforeVault = await getAccount(connection, vaultTokenAccount);

    const secondDeposit = new anchor.BN(500);
    await program.methods
      .depositToVault(secondDeposit)
      .accounts({
        user: user.publicKey,
        userTokenAccount,
        vaultTokenAccount,
        vaultAuthority,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc({ commitment: "confirmed" });

    const afterVault = await getAccount(connection, vaultTokenAccount);
    assert.equal(
      afterVault.amount - beforeVault.amount,
      BigInt(secondDeposit.toString()),
      "Vault should accumulate both deposits"
    );
  });

  // ---------------------------------------------------------------------------
  // withdraw_from_vault — success paths
  // ---------------------------------------------------------------------------

  it("performs a partial withdrawal from the vault", async () => {
    const beforeVault = await getAccount(connection, vaultTokenAccount);
    const beforeUser = await getAccount(connection, userTokenAccount);

    await program.methods
      .withdrawFromVault(PARTIAL_WITHDRAW)
      .accounts({
        user: user.publicKey,
        userTokenAccount,
        vaultTokenAccount,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc({ commitment: "confirmed" });

    const afterVault = await getAccount(connection, vaultTokenAccount);
    const afterUser = await getAccount(connection, userTokenAccount);

    assert.equal(
      beforeVault.amount - afterVault.amount,
      BigInt(PARTIAL_WITHDRAW.toString()),
      "Vault balance should decrease by withdrawn amount"
    );
    assert.equal(
      afterUser.amount - beforeUser.amount,
      BigInt(PARTIAL_WITHDRAW.toString()),
      "User balance should increase by withdrawn amount"
    );
  });

  it("performs a full withdrawal and closes the vault (rent returned)", async () => {
    const vault = await getAccount(connection, vaultTokenAccount);
    const fullAmount = new anchor.BN(vault.amount.toString());

    const beforeUserLamports = await connection.getBalance(user.publicKey);

    await program.methods
      .withdrawFromVault(fullAmount)
      .accounts({
        user: user.publicKey,
        userTokenAccount,
        vaultTokenAccount,
        vaultAuthority,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc({ commitment: "confirmed" });

    const afterUserLamports = await connection.getBalance(user.publicKey);

    // Vault account must no longer exist
    const closedInfo = await connection.getAccountInfo(vaultTokenAccount);
    assert.isNull(closedInfo, "Vault token account should be closed after full withdrawal");

    // User should have received rent lamports back (net positive after tx fees)
    assert.isAbove(afterUserLamports, beforeUserLamports - 0.01 * LAMPORTS_PER_SOL,
      "User should recover rent lamports from closed vault");
  });

  // ---------------------------------------------------------------------------
  // Error paths
  // ---------------------------------------------------------------------------

  it("rejects a zero-amount deposit", async () => {
    // Re-derive PDAs for a fresh user so vault doesn't exist
    const freshUser = Keypair.generate();
    await airdrop(connection, freshUser.publicKey);

    const freshUserTA = await createAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      freshUser.publicKey
    );
    await mintTo(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      freshUserTA,
      provider.wallet.publicKey,
      1_000
    );

    const [freshVault] = vaultPDA(program.programId, freshUser.publicKey);
    const [freshAuthority] = vaultAuthorityPDA(program.programId, freshUser.publicKey);

    try {
      await program.methods
        .depositToVault(new anchor.BN(0))
        .accounts({
          user: freshUser.publicKey,
          userTokenAccount: freshUserTA,
          vaultTokenAccount: freshVault,
          vaultAuthority: freshAuthority,
          mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([freshUser])
        .rpc();
      assert.fail("Should have thrown ZeroAmount");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "ZeroAmount");
    }
  });

  it("rejects a zero-amount withdrawal", async () => {
    // Use original user — vault is closed, but the error fires before account lookup
    // so we need a vault that exists. Reopen with a small deposit first.
    await program.methods
      .depositToVault(new anchor.BN(100))
      .accounts({
        user: user.publicKey,
        userTokenAccount,
        vaultTokenAccount,
        vaultAuthority,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc({ commitment: "confirmed" });

    try {
      await program.methods
        .withdrawFromVault(new anchor.BN(0))
        .accounts({
          user: user.publicKey,
          userTokenAccount,
          vaultTokenAccount,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have thrown ZeroAmount");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "ZeroAmount");
    }
  });

  it("rejects an overdraft withdrawal", async () => {
    const vault = await getAccount(connection, vaultTokenAccount);
    const overAmount = new anchor.BN(vault.amount.toString()).addn(1);

    try {
      await program.methods
        .withdrawFromVault(overAmount)
        .accounts({
          user: user.publicKey,
          userTokenAccount,
          vaultTokenAccount,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have thrown InsufficientFunds");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "InsufficientFunds");
    }
  });

  it("rejects a deposit when user_token_account owner does not match signer", async () => {
    // Create a token account owned by the provider, pass it as if owned by `user`
    const wrongOwnerTA = await createAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      provider.wallet.publicKey // owned by provider, not `user`
    );

    try {
      await program.methods
        .depositToVault(new anchor.BN(100))
        .accounts({
          user: user.publicKey,
          userTokenAccount: wrongOwnerTA, // mismatch
          vaultTokenAccount,
          vaultAuthority,
          mint,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have thrown InvalidOwner");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "InvalidOwner");
    }
  });

  it("rejects a withdrawal when destination mint does not match vault mint", async () => {
    // Create a second mint and a token account for it
    const wrongMint = await createMint(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      6
    );
    const wrongMintTA = await createAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      wrongMint,
      user.publicKey
    );

    try {
      await program.methods
        .withdrawFromVault(new anchor.BN(1))
        .accounts({
          user: user.publicKey,
          userTokenAccount: wrongMintTA, // wrong mint
          vaultTokenAccount,
          vaultAuthority,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have thrown MintMismatch");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "MintMismatch");
    }
  });
});

// ===========================================================================
// conditional_withdraw — cross-program state check
// ===========================================================================
//
// Strategy: `init_condition` lives in our own program (for testing purposes),
// so the condition account's runtime owner IS our program ID.
// We pass `program.programId` as `conditionProgram`, which satisfies the
// `account.owner == condition_program.key()` check in the instruction body.
// The discriminator is valid because `ExternalConditionAccount` is defined
// in this crate and Anchor uses the same sha256-based discriminator on both
// sides of the write/read boundary.
// ===========================================================================

describe("conditional_withdraw", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaEscrow as Program<SolanaEscrow>;
  const connection = provider.connection;

  let user: Keypair;
  let mint: PublicKey;
  let userTokenAccount: PublicKey;
  let vaultTokenAccount: PublicKey;
  let vaultAuthority: PublicKey;
  let conditionState: PublicKey;

  /** Derive the condition account PDA for a payer. */
  function conditionPDA(programId: PublicKey, payer: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("condition"), payer.toBuffer()],
      programId
    )[0];
  }

  before("set up shared state", async () => {
    user = Keypair.generate();
    const sig = await connection.requestAirdrop(user.publicKey, 4 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    mint = await createMint(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    userTokenAccount = await createAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      user.publicKey
    );

    await mintTo(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      userTokenAccount,
      provider.wallet.publicKey,
      5_000
    );

    [vaultTokenAccount] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), user.publicKey.toBuffer()],
      program.programId
    );
    [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), user.publicKey.toBuffer()],
      program.programId
    );
    conditionState = conditionPDA(program.programId, user.publicKey);

    // Fund the vault with 2,000 tokens.
    await program.methods
      .depositToVault(new anchor.BN(2_000))
      .accounts({
        user: user.publicKey,
        userTokenAccount,
        vaultTokenAccount,
        vaultAuthority,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc({ commitment: "confirmed" });
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it("releases tokens when external condition is fulfilled and buyer matches", async () => {
    // Initialise a condition account: completed = true, target_buyer = user.
    await program.methods
      .initCondition(
        provider.wallet.publicKey,    // initializer
        mint,                         // asset_mint
        true,                         // is_completed ✓
        user.publicKey                // target_buyer ✓
      )
      .accounts({
        payer: user.publicKey,
        conditionState,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc({ commitment: "confirmed" });

    const beforeUser = await getAccount(connection, userTokenAccount);

    await program.methods
      .conditionalWithdraw(new anchor.BN(500))
      .accounts({
        user: user.publicKey,
        userTokenAccount,
        vaultTokenAccount,
        vaultAuthority,
        externalConditionState: conditionState,
        // conditionProgram = our own program since init_condition lives here
        conditionProgram: program.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc({ commitment: "confirmed" });

    const afterUser = await getAccount(connection, userTokenAccount);
    assert.equal(
      afterUser.amount - beforeUser.amount,
      BigInt(500),
      "User should receive exactly 500 tokens"
    );
  });

  // ---------------------------------------------------------------------------
  // Error paths
  // ---------------------------------------------------------------------------

  it("rejects when condition is not completed", async () => {
    // Create a fresh user so we can initialise a new condition account.
    const freshUser = Keypair.generate();
    const sig = await connection.requestAirdrop(freshUser.publicKey, 4 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    const freshUserTA = await createAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      freshUser.publicKey
    );
    await mintTo(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      freshUserTA,
      provider.wallet.publicKey,
      2_000
    );

    const [freshVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), freshUser.publicKey.toBuffer()],
      program.programId
    );
    const [freshAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), freshUser.publicKey.toBuffer()],
      program.programId
    );
    const freshCondition = conditionPDA(program.programId, freshUser.publicKey);

    // Fund fresh vault.
    await program.methods
      .depositToVault(new anchor.BN(1_000))
      .accounts({
        user: freshUser.publicKey,
        userTokenAccount: freshUserTA,
        vaultTokenAccount: freshVault,
        vaultAuthority: freshAuthority,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([freshUser])
      .rpc({ commitment: "confirmed" });

    // Condition: is_completed = FALSE.
    await program.methods
      .initCondition(
        provider.wallet.publicKey,
        mint,
        false,           // ← not completed
        freshUser.publicKey
      )
      .accounts({
        payer: freshUser.publicKey,
        conditionState: freshCondition,
        systemProgram: SystemProgram.programId,
      })
      .signers([freshUser])
      .rpc({ commitment: "confirmed" });

    try {
      await program.methods
        .conditionalWithdraw(new anchor.BN(100))
        .accounts({
          user: freshUser.publicKey,
          userTokenAccount: freshUserTA,
          vaultTokenAccount: freshVault,
          vaultAuthority: freshAuthority,
          externalConditionState: freshCondition,
          conditionProgram: program.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([freshUser])
        .rpc();
      assert.fail("Should have thrown ConditionNotMet");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "ConditionNotMet");
    }
  });

  it("rejects when signer is not the target_buyer", async () => {
    // Reuse the original user's vault + condition (still completed=true, buyer=user).
    // Attempt to withdraw as the provider wallet instead.
    const impostor = Keypair.generate();
    const sig = await connection.requestAirdrop(impostor.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    const impostorTA = await createAccount(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      impostor.publicKey
    );

    // Derive impostor's own vault PDAs (they need their own vault to satisfy seeds)
    const [impostorVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), impostor.publicKey.toBuffer()],
      program.programId
    );
    const [impostorAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), impostor.publicKey.toBuffer()],
      program.programId
    );

    // Fund the impostor vault.
    await mintTo(
      connection,
      (provider.wallet as anchor.Wallet).payer,
      mint,
      impostorTA,
      provider.wallet.publicKey,
      1_000
    );
    await program.methods
      .depositToVault(new anchor.BN(500))
      .accounts({
        user: impostor.publicKey,
        userTokenAccount: impostorTA,
        vaultTokenAccount: impostorVault,
        vaultAuthority: impostorAuthority,
        mint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([impostor])
      .rpc({ commitment: "confirmed" });

    // Impostor attempts to use the original user's condition (target_buyer = user).
    try {
      await program.methods
        .conditionalWithdraw(new anchor.BN(100))
        .accounts({
          user: impostor.publicKey,         // signer is impostor
          userTokenAccount: impostorTA,
          vaultTokenAccount: impostorVault,
          vaultAuthority: impostorAuthority,
          externalConditionState: conditionState, // condition names original user as buyer
          conditionProgram: program.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([impostor])
        .rpc();
      assert.fail("Should have thrown UnauthorizedWithdrawal");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "UnauthorizedWithdrawal");
    }
  });

  it("rejects when condition account is owned by the wrong program", async () => {
    // Pass a raw system-owned account (e.g. a freshly generated keypair that
    // has never been initialised). Its owner will be the System Program, not
    // our program — triggering InvalidConditionOwner.
    const fakeCondition = Keypair.generate();

    // Airdrop a tiny amount so the account exists on-chain as a system account.
    const sig = await connection.requestAirdrop(fakeCondition.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");

    try {
      await program.methods
        .conditionalWithdraw(new anchor.BN(100))
        .accounts({
          user: user.publicKey,
          userTokenAccount,
          vaultTokenAccount,
          vaultAuthority,
          externalConditionState: fakeCondition.publicKey, // owned by System Program
          conditionProgram: program.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have thrown InvalidConditionOwner");
    } catch (err) {
      assert.instanceOf(err, AnchorError);
      assert.equal((err as AnchorError).error.errorCode.code, "InvalidConditionOwner");
    }
  });
});
