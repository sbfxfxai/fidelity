// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _nodes = [
  // Row 0: trigger
  { id: "tx",      label: "Token-2022 transfer_checked",  sub: "User-initiated",          row: 0, col: 1, color: "var(--text)",  bg: "var(--surface)" },
  // Row 1: programs
  { id: "escrow",  label: "solana-escrow",                sub: "Deposit / Withdraw",       row: 1, col: 0, color: "var(--blue)",  bg: "var(--blue-dim)" },
  { id: "hook",    label: "fidelity-transfer-hook",       sub: "execute() — CPI from T22", row: 1, col: 1, color: "var(--green)", bg: "var(--green-dim)" },
  { id: "kyc",     label: "kyc-registry",                 sub: "KycRecord PDAs",           row: 1, col: 2, color: "var(--amber)", bg: "var(--amber-dim)" },
  // Row 2: gates
  { id: "g1",      label: "① owner == CONSTANT",          sub: "~50 CU",                   row: 2, col: 0, color: "var(--red)",   bg: "var(--red-dim)" },
  { id: "g2",      label: "② discriminator",              sub: "try_deserialize ~100 CU",  row: 2, col: 1, color: "var(--amber)", bg: "var(--amber-dim)" },
  { id: "g3",      label: "③ PDA re-derive",              sub: "create_program_address ~500 CU", row: 2, col: 2, color: "var(--blue)", bg: "var(--blue-dim)" },
  // Row 3: outcome
  { id: "ok",      label: "④ is_approved",                sub: "Transfer authorised",      row: 3, col: 1, color: "var(--green)", bg: "var(--green-dim)" },
  { id: "fail",    label: "Reject",                       sub: "tx fails at boundary",     row: 3, col: 2, color: "var(--red)",   bg: "var(--red-dim)" },
];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _flows = [
  // Main escrow lifecycle
  { label: "deposit / withdraw",    from: "escrow", color: "var(--blue)"  },
  { label: "token-2022 CPI",        from: "tx",     color: "var(--green)" },
  // Hook reads KYC state
  { label: "reads KycRecord",       from: "hook",   color: "var(--amber)" },
];

export default function FlowDiagram() {
  return (
    <div
      className="rounded-xl border p-6 overflow-hidden"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <h2 className="text-xs font-semibold uppercase tracking-widest mb-6" style={{ color: "var(--muted)" }}>
        System Architecture · Transfer Flow
      </h2>

      {/* SVG diagram */}
      <div className="w-full overflow-x-auto">
        <svg
          viewBox="0 0 900 420"
          className="w-full"
          style={{ maxHeight: 420, minWidth: 600 }}
          aria-label="Transfer hook architecture flow"
        >
          {/* Background grid lines */}
          {[140, 280, 370].map((y) => (
            <line key={y} x1="0" y1={y} x2="900" y2={y} stroke="var(--border)" strokeWidth="1" strokeDasharray="4 6" />
          ))}

          {/* ── Row 0: User tx */}
          <FlowNode x={350} y={20} w={200} h={52} label="token-2022 transfer_checked" sub="User-initiated" color="var(--text)" bg="var(--surface)" border="var(--border)" />

          {/* Arrow down from tx */}
          <Arrow x1={450} y1={72} x2={450} y2={148} color="var(--green)" />
          <Label x={456} y={112} text="CPI" color="var(--green)" />

          {/* ── Row 1: Programs */}
          <FlowNode x={30}  y={152} w={200} h={52} label="solana-escrow"          sub="deposit · withdraw · conditional" color="var(--blue)"  bg="var(--blue-dim)"  border="var(--blue-dim)" />
          <FlowNode x={340} y={152} w={220} h={52} label="fidelity-transfer-hook" sub="execute() — spl-transfer-hook-interface" color="var(--green)" bg="var(--green-dim)" border="var(--green-dim)" />
          <FlowNode x={670} y={152} w={200} h={52} label="kyc-registry"           sub="KycRecord PDAs — COMPLIANCE_PROGRAM_ID" color="var(--amber)" bg="var(--amber-dim)" border="var(--amber-dim)" />

          {/* Hook reads KYC state */}
          <Arrow x1={560} y1={178} x2={670} y2={178} color="var(--amber)" />
          <Label x={605} y={172} text="reads KycRecord" color="var(--amber)" />

          {/* Arrows to gates */}
          <Arrow x1={450} y1={204} x2={175} y2={290} color="var(--red)"   />
          <Arrow x1={450} y1={204} x2={450} y2={290} color="var(--amber)" />
          <Arrow x1={450} y1={204} x2={725} y2={290} color="var(--blue)"  />

          {/* ── Row 2: Validation gates */}
          <FlowNode x={30}  y={294} w={190} h={52} label="① owner == CONSTANT"  sub="~50 CU — defeats spoofed program"        color="var(--red)"   bg="var(--red-dim)"   border="var(--red-dim)"   />
          <FlowNode x={345} y={294} w={210} h={52} label="② discriminator"       sub="try_deserialize ~100 CU"                 color="var(--amber)" bg="var(--amber-dim)" border="var(--amber-dim)" />
          <FlowNode x={620} y={294} w={250} h={52} label="③ PDA re-derive"       sub="create_program_address ~500 CU"          color="var(--blue)"  bg="var(--blue-dim)"  border="var(--blue-dim)"  />

          {/* Arrows to outcome */}
          <Arrow x1={450} y1={346} x2={400} y2={380} color="var(--green)" />
          <Arrow x1={725} y1={346} x2={760} y2={380} color="var(--red)"   />

          {/* ── Row 3: Outcome */}
          <FlowNode x={260} y={384} w={280} h={30} label="④ is_approved → Transfer authorised" sub="" color="var(--green)" bg="var(--green-dim)" border="var(--green-dim)" />
          <FlowNode x={660} y={384} w={220} h={30} label="Reject — tx fails at boundary"        sub="" color="var(--red)"   bg="var(--red-dim)"   border="var(--red-dim)"   />
        </svg>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 mt-4 text-xs" style={{ color: "var(--muted)" }}>
        {[
          { color: "var(--green)", label: "Token-2022 CPI path" },
          { color: "var(--amber)", label: "KYC state read" },
          { color: "var(--blue)",  label: "Escrow instructions" },
          { color: "var(--red)",   label: "Security gates" },
        ].map((l) => (
          <div key={l.label} className="flex items-center gap-1.5">
            <span className="w-6 h-0.5 inline-block rounded" style={{ background: l.color }} />
            {l.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- SVG primitives ---

function FlowNode({
  x, y, w, h, label, sub, color, bg, border,
}: {
  x: number; y: number; w: number; h: number;
  label: string; sub: string; color: string; bg: string; border: string;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={6} fill={bg} stroke={border} strokeWidth={1} />
      <text
        x={x + w / 2} y={y + (sub ? 18 : h / 2 + 5)}
        textAnchor="middle" fontSize={11} fontWeight="600"
        fill={color} fontFamily="Space Grotesk, system-ui"
      >
        {label}
      </text>
      {sub && (
        <text
          x={x + w / 2} y={y + 34}
          textAnchor="middle" fontSize={9}
          fill="var(--muted)" fontFamily="Space Grotesk, system-ui"
        >
          {sub}
        </text>
      )}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, color }: { x1: number; y1: number; x2: number; y2: number; color: string }) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const ux = dx / len, uy = dy / len;
  const ax = x2 - ux * 8, ay = y2 - uy * 8;
  return (
    <g>
      <line x1={x1} y1={y1} x2={ax} y2={ay} stroke={color} strokeWidth={1.5} />
      <polygon
        points={`${x2},${y2} ${ax - uy * 4},${ay + ux * 4} ${ax + uy * 4},${ay - ux * 4}`}
        fill={color}
      />
    </g>
  );
}

function Label({ x, y, text, color }: { x: number; y: number; text: string; color: string }) {
  return (
    <text x={x} y={y} fontSize={9} fill={color} fontFamily="Space Mono, monospace">
      {text}
    </text>
  );
}
