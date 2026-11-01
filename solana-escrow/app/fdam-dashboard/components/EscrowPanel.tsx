const ESCROW_ID = "ivVk3oF3Vc6LE2nAtTaRyEa6ceg8V7fkSGEkJ1Bbnv1";

const instructions = [
  {
    name: "deposit_to_vault",
    desc: "Creates vault PDA on first call (init_if_needed), transfers tokens from user → vault via CPI.",
    guards: ["amount > 0", "owner == signer", "mint match"],
    status: "active",
  },
  {
    name: "withdraw_from_vault",
    desc: "PDA-signed CPI transfer vault → user. Closes vault account and reclaims rent on full withdrawal.",
    guards: ["amount > 0", "balance ≥ amount", "mint match", "close = user"],
    status: "active",
  },
  {
    name: "conditional_withdraw",
    desc: "Gates withdrawal on an external program's state: owner check + discriminator + is_completed + target_buyer.",
    guards: ["external owner", "discriminator", "is_completed", "target_buyer == signer"],
    status: "active",
  },
  {
    name: "init_condition",
    desc: "Test helper: initialises an ExternalConditionAccount PDA for local validator tests.",
    guards: ["seeds = [condition, payer]"],
    status: "test",
  },
];

const testSummary = [
  { id: "T-01", name: "First deposit — vault created", result: "pass" },
  { id: "T-02", name: "Second deposit (init_if_needed reuse)", result: "pass" },
  { id: "T-03", name: "Partial withdrawal", result: "pass" },
  { id: "T-04", name: "Full withdrawal + vault close + rent return", result: "pass" },
  { id: "T-05", name: "Zero-amount deposit → ZeroAmount", result: "pass" },
  { id: "T-06", name: "Zero-amount withdrawal → ZeroAmount", result: "pass" },
  { id: "T-07", name: "Overdraft → InsufficientFunds", result: "pass" },
  { id: "T-08", name: "Wrong owner → InvalidOwner", result: "pass" },
  { id: "T-09", name: "Mint mismatch → MintMismatch", result: "pass" },
  { id: "T-10", name: "Condition fulfilled → tokens released", result: "pass" },
  { id: "T-11", name: "is_completed=false → ConditionNotMet", result: "pass" },
  { id: "T-12", name: "Impostor signer → UnauthorizedWithdrawal", result: "pass" },
  { id: "T-13", name: "Wrong program owner → InvalidConditionOwner", result: "pass" },
];

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded text-xs font-mono"
      style={{ background: color + "22", color }}
    >
      {text}
    </span>
  );
}

export default function EscrowPanel() {
  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 border-b flex items-start justify-between gap-4"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="status-dot" style={{ background: "var(--blue)" }} />
            <h2 className="font-semibold text-sm tracking-tight">solana-escrow</h2>
          </div>
          <p className="addr" style={{ color: "var(--muted)" }}>{ESCROW_ID}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs font-medium" style={{ color: "var(--green)" }}>
            ✓ cargo check
          </div>
          <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
            4 instructions
          </div>
        </div>
      </div>

      {/* Instructions */}
      <div className="p-5 space-y-3">
        {instructions.map((ix) => (
          <div
            key={ix.name}
            className="rounded-lg p-3 border"
            style={{ borderColor: "var(--border)", background: "var(--bg)" }}
          >
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              <code className="text-xs font-bold" style={{ color: "var(--amber)" }}>
                {ix.name}
              </code>
              {ix.status === "test" && (
                <Badge text="test-only" color="var(--muted)" />
              )}
            </div>
            <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>{ix.desc}</p>
            <div className="flex flex-wrap gap-1">
              {ix.guards.map((g) => (
                <Badge key={g} text={g} color="var(--blue)" />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Test results */}
      <div
        className="border-t px-5 py-4"
        style={{ borderColor: "var(--border)" }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: "var(--muted)" }}>
          Test Suite — 13 / 13 passing
        </h3>
        <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
          {testSummary.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-xs">
              <span className="font-mono w-8 shrink-0" style={{ color: "var(--muted)" }}>{t.id}</span>
              <span className="flex-1" style={{ color: "var(--text)" }}>{t.name}</span>
              <span style={{ color: "var(--green)" }}>✓</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
