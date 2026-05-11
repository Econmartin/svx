import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { NetworkProvider } from '@/lib/network-context';
import { NetworkToggle } from '@/components/NetworkToggle';

export const metadata: Metadata = {
  title: 'SVX — Cross-venue vol-arb on DeepBook Predict',
  description:
    'A fully-automated bot that trades the spread between DeepBook Predict (SVI surface) and Polymarket BTC binaries, delta-hedged on Hyperliquid.',
};

/**
 * Single dashboard, network-aware. The header's NetworkToggle switches
 * between the testnet bot (Predict-live, paper Poly) and the mainnet bot
 * (paper Predict, live Poly + HL). Each page consumes the active client
 * via the useApiClient() hook — no route duplication.
 */
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
        <NetworkProvider>
          <header className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80">
            <div className="px-6 py-3 flex items-center gap-6">
              <Link href="/" className="font-mono font-bold text-accent text-lg whitespace-nowrap">
                SVX
              </Link>
              <nav className="flex gap-1 text-sm">
                {NAV.map(([label, href]) => (
                  <Link
                    key={href}
                    href={href}
                    className="px-3 py-1.5 rounded-md text-muted hover:text-white hover:bg-surface-elevated transition-colors"
                  >
                    {label}
                  </Link>
                ))}
              </nav>
              <div className="ml-auto flex items-center gap-4">
                <NetworkToggle />
                <span className="hidden md:inline text-xs text-muted font-mono whitespace-nowrap">
                  Sui Overflow 2026
                </span>
              </div>
            </div>
          </header>
          <main className="px-6 py-6 max-w-7xl mx-auto animate-fade-in">{children}</main>
        </NetworkProvider>
      </body>
    </html>
  );
}
