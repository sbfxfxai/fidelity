export default function Footer() {
  return (
    <footer
      className="border-t mt-16 py-6 text-center text-xs"
      style={{ borderColor: "var(--border)", color: "var(--muted)" }}
    >
      <p>
        FDAM Solana Protocol Dashboard · 3 programs · 13 test cases ·{" "}
        <span style={{ color: "var(--green)" }}>cargo check ✓</span>
      </p>
      <p className="mt-1 opacity-50">
        Tokenised US Treasury Fund — KYC/AML Transfer Hook Architecture
      </p>
    </footer>
  );
}
