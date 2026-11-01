const validationSteps = [
  {
    step: "1",
    title: "Owner check — hardcoded constant",
    code: `require_keys_eq!(
  *account.owner,
  COMPLIANCE_PROGRAM_ID, // compile-time const
  HookError::InvalidRegistryOwner
);`,
    why: "Defeats spoofed-program injection. Attacker cannot pass their own program as compliance_program because the comparison target is baked into the binary, not supplied at runtime.",
    cu: "~50 CU",
    color: "var(--red)",
  },
  {
    step: "2",
    title: "Discriminator validation via try_deserialize",
    code: `let record = KycRecord::try_deserialize(
  &mut data.as_ref()
).map_err(|_| error!(HookError::RegistryDeserializeFailed))?;`,
    why: "Validates the 8-byte Anchor discriminator prefix (sha256('account:KycRecord')[..8]). A type-confusion account with random bytes fails here before any field is read.",
    cu: "~100 CU",
    color: "var(--amber)",
  },
  {
    step: "3",
    title: "PDA re-derivation — stored canonical_bump",
    code: `let expected = Pubkey::create_program_address(
  &[KYC_SEED, wallet.as_ref(), &[record.canonical_bump]],
  &COMPLIANCE_PROGRAM_ID,
)?;
require_keys_eq!(account.key(), expected, ...);`,
    why: "Re-derives the expected PDA and compares it to the supplied address. canonical_bump is safe to use here because steps 1–2 already verified the data source. Uses create_program_address (~500 CU) instead of find_program_address (~1,500 CU).",
    cu: "~500 CU",
    color: "var(--blue)",
  },
  {
    step: "4",
    title: "Compliance gate",
    code: `require!(record.is_approved, HookError::ReceiverNotKycVerified);`,
    why: "Business logic gate checked only after cryptographic identity is fully established. KYC bound to destination wallet owner, not transaction signer — delegate-authorised transfers are still gated.",
    cu: "~10 CU",
    color: "var(--green)",
  },
];

const accountSlots = [
  { slot: "0", name: "source_token",              type: "InterfaceAccount<TokenAccount>", injected: "Token-2022" },
  { slot: "1", name: "mint",                      type: "InterfaceAccount<Mint>",         injected: "Token-2022" },
  { slot: "2", name: "destination_token",         type: "InterfaceAccount<TokenAccount>", injected: "Token-2022" },
  { slot: "3", name: "authority",                 type: "UncheckedAccount",               injected: "Token-2022", note: "NOT Signer — delegate compat" },
  { slot: "4", name: "extra_account_metas_list",  type: "UncheckedAccount (seeds)",       injected: "Interface"  },
  { slot: "5", name: "receiver_kyc_registry",     type: "UncheckedAccount",               injected: "Resolved",  note: "custom — seed-resolved at runtime" },
  { slot: "6", name: "compliance_program",        type: "UncheckedAccount",               injected: "Resolved",  note: "custom — literal address" },
];

export default function HookArchPanel() {
  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      {/* Header */}
      <div
        className="px-6 py-4 border-b flex flex-wrap items-start justify-between gap-4"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="status-dot" style={{ background: "var(--green)" }} />
            <h2 className="font-semibold text-sm">fidelity-transfer-hook</h2>
            <span
              className="text-xs px-2 py-0.5 rounded"
              style={{ background: "var(--green-dim)", color: "var(--green)" }}
            >
              Token-2022 / spl-transfer-hook-interface
            </span>
          </div>
          <p className="addr" style={{ color: "var(--muted)" }}>23kV2bhRWCGeyCjZrJHpdnWq9jyjZfP5tJ1JYHWmcAAB</p>
        </div>
        <div className="flex gap-3 text-xs">
          <div className="text-right">
            <div style={{ color: "var(--green)" }}>✓ 0 errors</div>
            <div style={{ color: "var(--muted)" }}>11 warnings (macro cfg — benign)</div>
          </div>
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Validation steps */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: "var(--muted)" }}>
            4-layer validation in execute()
          </h3>
          <div className="space-y-3">
            {validationSteps.map((s) => (
              <div
                key={s.step}
                className="rounded-lg border overflow-hidden"
                style={{ borderColor: "var(--border)", borderLeftColor: s.color, borderLeftWidth: 3 }}
              >
                <div
                  className="px-4 py-2 border-b flex items-center gap-2"
                  style={{ borderColor: "var(--border)", background: "var(--bg)" }}
                >
                  <span
                    className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                    style={{ background: s.color + "22", color: s.color }}
                  >
                    {s.step}
                  </span>
                  <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>{s.title}</span>
                  <span
                    className="ml-auto text-xs font-mono px-1.5 py-0.5 rounded"
                    style={{ background: s.color + "22", color: s.color }}
                  >
                    {s.cu}
                  </span>
                </div>
                <pre
                  className="addr p-3 overflow-x-auto text-xs"
                  style={{ background: "var(--bg)", color: "var(--text)" }}
                >
                  {s.code}
                </pre>
                <div className="px-4 pb-3">
                  <p className="text-xs" style={{ color: "var(--muted)" }}>{s.why}</p>
                </div>
              </div>
            ))}
          </div>
          <div
            className="mt-3 rounded-lg p-3 border text-xs"
            style={{ borderColor: "var(--green-dim)", background: "var(--green-dim)" }}
          >
            <span className="font-semibold" style={{ color: "var(--green)" }}>Total estimated CU budget: </span>
            <span style={{ color: "var(--text)" }}>~660 CU — well within Token-2022 hook allocation</span>
          </div>
        </div>

        {/* Account layout table */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: "var(--muted)" }}>
            ExecuteTransfer account layout
          </h3>
          <div className="rounded-lg border overflow-hidden mb-4" style={{ borderColor: "var(--border)" }}>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ background: "var(--bg)" }}>
                  {["Slot", "Name", "Type", "Injected by"].map((h) => (
                    <th key={h} className="text-left px-3 py-2 font-medium" style={{ color: "var(--muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {accountSlots.map((a, i) => (
                  <tr
                    key={a.slot}
                    style={{ borderTop: i > 0 ? "1px solid var(--border)" : "none" }}
                  >
                    <td className="px-3 py-1.5 font-mono" style={{ color: "var(--muted)" }}>{a.slot}</td>
                    <td className="px-3 py-1.5">
                      <div>
                        <code style={{ color: "var(--amber)" }}>{a.name}</code>
                        {a.note && (
                          <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{a.note}</div>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      <code className="text-xs" style={{ color: "var(--blue)" }}>{a.type}</code>
                    </td>
                    <td className="px-3 py-1.5" style={{ color: "var(--muted)" }}>{a.injected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Spoofing attack / defense callout */}
          <div
            className="rounded-lg p-4 border"
            style={{ borderColor: "var(--red-dim)", background: "var(--red-dim)" }}
          >
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--red)" }}>
              ⚠ Closed Attack Vector: Spoofed compliance_program
            </p>
            <div className="space-y-1.5 text-xs" style={{ color: "var(--text)" }}>
              <div className="flex gap-2">
                <span style={{ color: "var(--red)" }}>✗</span>
                <span><strong>Proposed:</strong> compliance_program as runtime UncheckedAccount → attacker passes MaliciousProgram, satisfies owner check with fake KYC data.</span>
              </div>
              <div className="flex gap-2">
                <span style={{ color: "var(--green)" }}>✓</span>
                <span><strong>Fixed:</strong> COMPLIANCE_PROGRAM_ID baked as <code className="addr">pubkey!(...)</code> compile-time constant — runtime account key is never trusted.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
