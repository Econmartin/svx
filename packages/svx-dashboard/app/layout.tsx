import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'SVX — Cross-venue vol-arb on DeepBook Predict',
  description:
    'A fully-automated bot that trades the spread between DeepBook Predict (SVI surface) and Polymarket BTC binaries.',
};

const NAV = [
  ['Overview', '/'],
  ['Signals', '/signals'],
  ['Positions', '/positions'],
  ['Surface', '/surface'],
  ['About', '/about'],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-border px-6 py-3 flex items-center gap-6">
          <Link href="/" className="font-mono font-bold text-accent text-lg">
            SVX
          </Link>
          <nav className="flex gap-4 text-sm">
            {NAV.map(([label, href]) => (
              <Link key={href} href={href} className="text-muted hover:text-white transition-colors">
                {label}
              </Link>
            ))}
          </nav>
          <span className="ml-auto text-xs text-muted font-mono">
            DeepBook Predict · Sui Overflow 2026
          </span>
        </header>
        <main className="px-6 py-6 max-w-7xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
