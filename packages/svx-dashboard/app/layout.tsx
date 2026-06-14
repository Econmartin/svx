import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { NetworkProvider } from '@/lib/network-context';
import { NetworkToggle } from '@/components/NetworkToggle';
import { NavLinks } from '@/components/NavLinks';
import { StatusTicker } from '@/components/StatusTicker';

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
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NetworkProvider>
          {/* Ambient atmosphere — fixed-position, no interaction cost. */}
          <div className="svx-ambient" aria-hidden />
          <div className="svx-grid" aria-hidden />

          <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/70">
            <div className="px-6 py-3 flex items-center gap-6">
              <Link
                href="/"
                className="flex items-center gap-2 whitespace-nowrap group"
              >
                <span
                  aria-hidden
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-accent/12 border border-accent/30 text-accent font-mono font-bold text-sm shadow-[0_0_18px_-4px_rgba(30,255,138,0.55)] group-hover:bg-accent/20 transition-colors"
                >
                  S
                </span>
                <span className="font-mono font-bold tracking-tight text-base">
                  <span className="text-accent">SVX</span>
                  <span className="text-muted">/</span>
                  <span className="text-fg/80 text-xs uppercase tracking-wider">
                    vol-arb
                  </span>
                </span>
              </Link>
              <NavLinks />
              <div className="ml-auto flex items-center gap-4">
                <NetworkToggle />
                <span className="hidden md:inline text-[10px] text-muted font-mono whitespace-nowrap uppercase tracking-wider">
                  Sui Overflow ’26
                </span>
              </div>
            </div>
          </header>

          <main className="relative z-10 px-6 py-6 pb-12 max-w-7xl mx-auto animate-fade-in">
            {children}
          </main>

          <StatusTicker />
        </NetworkProvider>
      </body>
    </html>
  );
}
