export default function Header() {
  return (
    <header
      className="sticky top-0 z-50 border-b mb-8"
      style={{
        background: "rgba(8,12,20,0.92)",
        borderColor: "var(--border)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between">
        {/* Wordmark */}
        <div className="flex items-center gap-3">
          <div
            className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold"
            style={{ background: "var(--amber)", color: "#000" }}
          >
            F
          </div>
          <span className="font-semibold text-sm tracking-tight" style={{ color: "var(--text)" }}>
            Fidelity Digital Asset Management
          </span>
          <span
            className="hidden sm:block text-xs px-2 py-0.5 rounded border font-mono"
            style={{ color: "var(--muted)", borderColor: "var(--border)" }}
          >
            Solana Protocol Dashboard
          </span>
        </div>

        {/* Status indicators */}
        <div className="flex items-center gap-4 text-xs" style={{ color: "var(--muted)" }}>
          <div className="hidden md:flex items-center gap-1.5">
            <span className="status-dot" style={{ background: "var(--green)" }} />
            cargo check passing
          </div>
          <div className="flex items-center gap-1.5">
            <span className="status-dot" style={{ background: "var(--amber)" }} />
            localnet
          </div>
          <div
            className="px-2 py-1 rounded border text-xs"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            Anchor 0.32.2
          </div>
        </div>
      </div>
    </header>
  );
}
