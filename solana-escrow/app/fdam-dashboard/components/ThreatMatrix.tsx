const threats = [
  {
    vector: "Stale-state revocation race",
    impact: "Sanctioned user transfers tokens before is_approved=false clears congestion",
    severity: "critical",
    mitigation: "Freeze authority (multisig PDA) on the mint is the primary weapon — atomic, no CPI latency. is_approved flag is the secondary soft gate.",
    code: "mint.freeze_authority = compliance_multisig_PDA",
    status: "addressed",
  },
  {
    vector: "Extra-account-metas frontrun",
    impact: "Attacker creates extra-account-metas PDA before setup, injecting malicious keys into every transfer hook",
    severity: "critical",
    mitigation: "Mint creation + initialize_extra_account_metas must be in a single atomic transaction bundle. Authority locked at block zero.",
    code: "Single tx: createMint + initExtraAccountMetas",
    status: "addressed",
  },
  {
    vector: "Spoofed compliance_program",
    impact: "Attacker passes MaliciousProgram as compliance_program, satisfies owner check with fake KYC account",
    severity: "critical",
    mitigation: "COMPLIANCE_PROGRAM_ID baked as compile-time constant in hook binary. Runtime account key never used as comparison target.",
    code: "pub const COMPLIANCE_PROGRAM_ID: Pubkey = pubkey!(\"...\");",
    status: "addressed",
  },
  {
    vector: "Type-confusion account",
    impact: "Attacker passes an account with correct owner but wrong data layout (different account type)",
    severity: "high",
    mitigation: "try_deserialize validates the 8-byte Anchor discriminator before any field is read.",
    code: "KycRecord::try_deserialize(&mut data.as_ref())?",
    status: "addressed",
  },
  {
    vector: "Spoofed PDA (wrong seeds)",
    impact: "Attacker passes an account owned by compliance program but with seeds for a different wallet",
    severity: "high",
    mitigation: "create_program_address re-derives the expected PDA from destination_token.owner seeds and compares. canonical_bump read from already-trusted data.",
    code: "Pubkey::create_program_address([KYC_SEED, wallet, &[bump]], ID)",
    status: "addressed",
  },
  {
    vector: "Delegate authority bypass",
    impact: "Blacklisted user bypasses checks via previously approved delegate key",
    severity: "high",
    mitigation: "KYC bound to destination token account's wallet .owner (via Deref), not transaction signer. Delegate-authorised transfers are still gated.",
    code: "let wallet = &ctx.accounts.destination_token.owner; // Deref, not .to_account_info().owner",
    status: "addressed",
  },
  {
    vector: "ConfidentialTransfer interaction",
    impact: "Token-2022 ConfidentialTransfer passes encrypted ElGamal amount — Bank Secrecy Act threshold checks impossible in hook",
    severity: "medium",
    mitigation: "This hook is identity-gated only — amount is ignored. Volume-threshold reporting must be off-chain via log monitoring. ConfidentialTransfer extension must be explicitly disallowed if BSA thresholds are required on-chain.",
    code: "pub fn execute(ctx: ..., _amount: u64) — amount intentionally unused",
    status: "design-constraint",
  },
  {
    vector: "CU exhaustion DoS",
    impact: "Hook exceeds Token-2022 compute budget, freezing all token transfers on the regulated mint",
    severity: "medium",
    mitigation: "create_program_address (~500 CU) instead of find_program_address (~1,500 CU). No loops. Total estimated budget: ~660 CU.",
    code: "create_program_address (not find_program_address) — saves ~1,000 CU",
    status: "addressed",
  },
];

const severityConfig = {
  critical: { label: "CRITICAL", color: "var(--red)",   bg: "var(--red-dim)"   },
  high:     { label: "HIGH",     color: "var(--amber)", bg: "var(--amber-dim)" },
  medium:   { label: "MEDIUM",   color: "var(--blue)",  bg: "var(--blue-dim)"  },
};
const statusConfig = {
  addressed:        { label: "Addressed",        color: "var(--green)" },
  "design-constraint": { label: "Design Constraint", color: "var(--blue)"  },
};

export default function ThreatMatrix() {
  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div
        className="px-6 py-4 border-b flex items-center justify-between"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <h2 className="font-semibold text-sm">Institutional Threat Matrix</h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
            VP / Principal-level security analysis — {threats.length} vectors reviewed
          </p>
        </div>
        <div className="flex gap-3 text-xs">
          {Object.entries(severityConfig).map(([k, v]) => (
            <span
              key={k}
              className="px-2 py-0.5 rounded font-semibold"
              style={{ background: v.bg, color: v.color }}
            >
              {v.label}
            </span>
          ))}
        </div>
      </div>

      <div className="divide-y" style={{ borderColor: "var(--border)" }}>
        {threats.map((t) => {
          const sev = severityConfig[t.severity as keyof typeof severityConfig];
          const st  = statusConfig[t.status as keyof typeof statusConfig];
          return (
            <div
              key={t.vector}
              className="px-6 py-4 grid grid-cols-1 md:grid-cols-[1fr_2fr_1fr] gap-4 items-start"
            >
              {/* Vector + severity */}
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span
                    className="text-xs font-bold px-1.5 py-0.5 rounded"
                    style={{ background: sev.bg, color: sev.color }}
                  >
                    {sev.label}
                  </span>
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ background: st.color + "22", color: st.color }}
                  >
                    {st.label}
                  </span>
                </div>
                <p className="text-xs font-semibold" style={{ color: "var(--text)" }}>{t.vector}</p>
                <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>{t.impact}</p>
              </div>

              {/* Mitigation */}
              <div>
                <p className="text-xs mb-2" style={{ color: "var(--text)" }}>{t.mitigation}</p>
                <pre
                  className="addr text-xs p-2 rounded overflow-x-auto"
                  style={{ background: "var(--bg)", color: "var(--amber)" }}
                >
                  {t.code}
                </pre>
              </div>

              {/* Programs affected */}
              <div className="text-xs" style={{ color: "var(--muted)" }}>
                {t.status === "addressed"
                  ? <span style={{ color: "var(--green)" }}>✓ Resolved in codebase</span>
                  : <span style={{ color: "var(--blue)" }}>ℹ Design-level constraint</span>
                }
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
