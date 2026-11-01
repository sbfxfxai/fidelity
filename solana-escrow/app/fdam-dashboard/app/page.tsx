import Header from "@/components/Header";
import EscrowPanel from "@/components/EscrowPanel";
import KycPanel from "@/components/KycPanel";
import HookArchPanel from "@/components/HookArchPanel";
import ThreatMatrix from "@/components/ThreatMatrix";
import FlowDiagram from "@/components/FlowDiagram";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      <Header />

      <main className="max-w-[1400px] mx-auto px-6 pb-20 space-y-8">

        {/* Top metrics row */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 fade-up fade-up-1">
          <StatCard label="Programs Deployed" value="3" sub="Solana Localnet" color="blue" />
          <StatCard label="Instructions" value="9" sub="deposit · withdraw · conditional · kyc · hook" color="amber" />
          <StatCard label="Test Cases" value="13" sub="cargo check ✓  zero errors" color="green" />
          <StatCard label="Security Layers" value="4" sub="owner · discriminator · PDA · compliance" color="green" />
        </section>

        {/* Full-width flow diagram */}
        <section className="fade-up fade-up-2">
          <FlowDiagram />
        </section>

        {/* Two-column panels */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 fade-up fade-up-3">
          <EscrowPanel />
          <KycPanel />
        </section>

        {/* Hook architecture — full width */}
        <section className="fade-up fade-up-4">
          <HookArchPanel />
        </section>

        {/* Threat matrix — full width */}
        <section className="fade-up fade-up-5">
          <ThreatMatrix />
        </section>

      </main>

      <Footer />
    </div>
  );
}

function StatCard({
  label, value, sub, color,
}: {
  label: string; value: string; sub: string;
  color: "blue" | "amber" | "green" | "red";
}) {
  const colors = {
    blue:  { dot: "#3b82f6", bg: "var(--blue-dim)"  },
    amber: { dot: "#f59e0b", bg: "var(--amber-dim)" },
    green: { dot: "#10b981", bg: "var(--green-dim)" },
    red:   { dot: "#ef4444", bg: "var(--red-dim)"   },
  };
  const c = colors[color];
  return (
    <div
      className="rounded-lg p-4 border"
      style={{ background: "var(--surface)", borderColor: "var(--border)" }}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="status-dot" style={{ background: c.dot }} />
        <span className="text-xs font-medium uppercase tracking-widest" style={{ color: "var(--muted)" }}>
          {label}
        </span>
      </div>
      <div className="text-3xl font-700 tracking-tight" style={{ color: c.dot }}>
        {value}
      </div>
      <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{sub}</div>
    </div>
  );
}
