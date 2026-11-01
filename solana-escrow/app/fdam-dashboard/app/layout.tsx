import type { Metadata } from "next";
import { Space_Grotesk, Space_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "FDAM · Solana Protocol Dashboard",
  description:
    "Fidelity Digital Asset Management — Tokenised US Treasury Fund on Solana. " +
    "Escrow vault lifecycle, KYC/AML compliance registry, and Token-2022 transfer hook architecture.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body
        className={`${spaceGrotesk.variable} ${spaceMono.variable} antialiased min-h-screen`}
        style={{ background: "var(--bg)", color: "var(--text)" }}
      >
        {children}
      </body>
    </html>
  );
}
