const KYC_ID    = "7b7KuUqicUcoTSvkdBXdc6KvX4hPyB5DergBsGssURsM";
const HOOK_ID   = "23kV2bhRWCGeyCjZrJHpdnWq9jyjZfP5tJ1JYHWmcAAB";
const KYC_SEED  = "kyc_status";

const kycInstructions = [
  {
    name: "init_kyc_record",
    args: ["compliance_level: u8", "jurisdiction: [u8;3]"],
    desc: "Creates a KycRecord PDA for a wallet. Approval starts as false — explicit grant required.",
    authority: "compliance_authority (multisig in prod)",
  },
  {
    name: "set_approval",
    args: ["is_approved: bool"],
    desc: "Grants or revokes KYC status. Pair with freeze_account for atomic revocation.",
    authority: "compliance_authority",
  },
  {
    name: "update_compliance_level",
    args: ["compliance_level: u8"],
    desc: "Updates investor classification: 0=unset, 1=accredited, 2=qualified, 3=retail.",
    authority: "compliance_authority",
  },
];

const kycFields = [
  { field: "is_approved",      type: "bool",     note: "Primary KYC gate" },
  { field: "compliance_level", type: "u8",       note: "0–3 investor class" },
  { field: "canonical_bump",   type: "u8",       note: "Stored for CU-efficient PDA re-derivation in hook" },
  { field: "approved_at",      type: "i64",      note: "Unix timestamp of last change" },
  { field: "jurisdiction",     type: "[u8; 3]",  note: "ISO 3166-1 alpha-3" },
  { field: "approved_by",      type: "Pubkey",   note: "Compliance officer key" },
];

const complianceFlow = [
  { step: "1", label: "Investor completes off-chain KYC/AML onboarding", party: "Compliance Ops" },
  { step: "2", label: "init_kyc_record called — PDA created, is_approved=false", party: "Registry Program" },
  { step: "3", label: "set_approval(true) called by multisig", party: "Compliance Multisig" },
  { step: "4", label: "Transfer hook validates is_approved on every transfer", party: "Hook Program" },
  { step: "5", label: "Sanctions hit: set_approval(false) + freeze_account called atomically", party: "Emergency Ops" },
];

export default function KycPanel() {
  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center justify-between gap-4 mb-1">
          <div className="flex items-center gap-2">
            <span className="status-dot" style={{ background: "var(--amber)" }} />
            <h2 className="font-semibold text-sm">kyc-registry</h2>
          </div>
          <span
            className="text-xs px-2 py-0.5 rounded border"
            style={{ color: "var(--amber)", borderColor: "var(--amber-dim)", background: "var(--amber-dim)" }}
          >
            COMPLIANCE_PROGRAM_ID
          </span>
        </div>
        <p className="addr" style={{ color: "var(--muted)" }}>{KYC_ID}</p>
        <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
          PDA seed: <code className="addr" style={{ color: "var(--text)" }}>[&quot;{KYC_SEED}&quot;, wallet]</code>
          {" "}· baked into hook binary as compile-time constant
        </p>
      </div>

      {/* Account layout */}
      <div className="px-5 pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
          KycRecord layout
        </h3>
        <div className="rounded-lg border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "var(--bg)" }}>
                <th className="text-left px-3 py-2 font-medium" style={{ color: "var(--muted)" }}>Field</th>
                <th className="text-left px-3 py-2 font-medium" style={{ color: "var(--muted)" }}>Type</th>
                <th className="text-left px-3 py-2 font-medium hidden sm:table-cell" style={{ color: "var(--muted)" }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {kycFields.map((f, i) => (
                <tr
                  key={f.field}
                  style={{ borderTop: i > 0 ? "1px solid var(--border)" : "none" }}
                >
                  <td className="px-3 py-1.5">
                    <code style={{ color: "var(--text)" }}>{f.field}</code>
                  </td>
                  <td className="px-3 py-1.5">
                    <code style={{ color: "var(--blue)" }}>{f.type}</code>
                  </td>
                  <td className="px-3 py-1.5 hidden sm:table-cell" style={{ color: "var(--muted)" }}>{f.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Instructions */}
      <div className="px-5 pt-4 space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--muted)" }}>
          Instructions
        </h3>
        {kycInstructions.map((ix) => (
          <div
            key={ix.name}
            className="rounded-lg p-3 border"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
          >
            <code className="text-xs font-bold" style={{ color: "var(--amber)" }}>{ix.name}</code>
            <div className="mt-1 flex flex-wrap gap-1">
              {ix.args.map((a) => (
                <span
                  key={a}
                  className="text-xs px-1.5 py-0.5 rounded font-mono"
                  style={{ background: "var(--blue-dim)", color: "var(--blue)" }}
                >
                  {a}
                </span>
              ))}
            </div>
            <p className="text-xs mt-1.5" style={{ color: "var(--muted)" }}>{ix.desc}</p>
            <p className="text-xs mt-1" style={{ color: "var(--green)" }}>
              Signer: {ix.authority}
            </p>
          </div>
        ))}
      </div>

      {/* Compliance lifecycle */}
      <div
        className="px-5 py-4 mt-4 border-t"
        style={{ borderColor: "var(--border)" }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--muted)" }}>
          Compliance lifecycle
        </h3>
        <div className="space-y-2">
          {complianceFlow.map((s) => (
            <div key={s.step} className="flex items-start gap-3">
              <div
                className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5"
                style={{ background: "var(--amber-dim)", color: "var(--amber)" }}
              >
                {s.step}
              </div>
              <div>
                <p className="text-xs" style={{ color: "var(--text)" }}>{s.label}</p>
                <p className="text-xs" style={{ color: "var(--muted)" }}>{s.party}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Hook linkage */}
      <div
        className="px-5 pb-4"
        style={{ borderColor: "var(--border)" }}
      >
        <div
          className="rounded-lg p-3 border text-xs"
          style={{ borderColor: "var(--amber-dim)", background: "var(--amber-dim)" }}
        >
          <p className="font-semibold mb-0.5" style={{ color: "var(--amber)" }}>
            🔒 Hook cross-reference
          </p>
          <p style={{ color: "var(--text)" }}>
            Hook binary: <span className="addr">{HOOK_ID}</span>
          </p>
          <p className="mt-0.5" style={{ color: "var(--muted)" }}>
            COMPLIANCE_PROGRAM_ID is hardcoded in the hook binary — changing the registry
            requires a governance-approved hook redeploy, not a runtime parameter change.
          </p>
        </div>
      </div>
    </div>
  );
}
