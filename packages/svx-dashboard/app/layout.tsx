import './globals.css';
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { NetworkProvider } from '@/lib/network-context';
import { NetworkToggle } from '@/components/NetworkToggle';
import { NavLinks } from '@/components/NavLinks';
import { Presenter } from '@/components/Presenter';
import { StatusTicker } from '@/components/StatusTicker';

export const metadata: Metadata = {
  title: 'SVX — Cross-venue vol-arb on DeepBook Predict',
  description:
    'A fully-automated bot that trades the spread between DeepBook Predict (SVI surface) and Polymarket BTC binaries, with a Hyperliquid realized-vol feed.',
};

// Without this, mobile browsers render the page at the default ~980px
// desktop viewport and scale it down — content looks "half width" and tiny.
// Setting width=device-width is what makes Tailwind's `sm:`/`md:` breakpoints
// actually fire on real phones.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#06090a',
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
          {/* Demo-day presenter overlay — inert unless /present is visited. */}
          <Presenter />
          {/* Ambient atmosphere — fixed-position, no interaction cost. */}
          <div className="svx-ambient" aria-hidden />
          <div className="svx-grid" aria-hidden />

          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-bg focus:font-medium"
          >
            Skip to content
          </a>

          <header className="sticky top-0 z-40 border-b border-border/80 bg-bg/85 backdrop-blur supports-[backdrop-filter]:bg-bg/65">
            {/* Two-row header on mobile (brand + toggles on top, scrollable
                nav below); single-row from md up. Keeps each row well within
                the viewport instead of clipping the nav off-screen. */}
            <div className="max-w-[1600px] mx-auto">
              <div className="px-4 sm:px-5 h-14 flex items-center gap-3 md:gap-5">
                <Link
                  href="/"
                  aria-label="SVX home"
                  className="flex items-center gap-2.5 whitespace-nowrap group h-8 flex-shrink-0"
                >
                  <span
                    aria-hidden
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent/12 border border-accent/30 text-accent font-mono font-bold text-sm shadow-[0_0_22px_-6px_rgba(30,255,138,0.7)] group-hover:bg-accent/20 group-hover:border-accent/50 transition-colors"
                  >
                    S
                  </span>
                  <span className="flex items-baseline gap-1.5 leading-none">
                    <span className="font-mono font-semibold tracking-tight text-[15px] text-fg">
                      SVX
                    </span>
                    <span
                      aria-hidden
                      className="text-[10px] uppercase tracking-[0.18em] text-muted font-medium"
                    >
                      vol-arb
                    </span>
                  </span>
                </Link>
                <span aria-hidden className="hidden md:block h-5 w-px bg-border/80" />
                <div className="hidden md:block min-w-0 flex-1">
                  <NavLinks />
                </div>
                <div className="ml-auto flex items-center gap-2 sm:gap-3 flex-shrink-0">
                  <NetworkToggle />
                  <span
                    aria-hidden
                    className="hidden xl:inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-surface/60 px-2.5 h-7 text-[10px] text-muted font-mono whitespace-nowrap uppercase tracking-[0.14em]"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent/70" />
                    Sui Overflow ’26
                  </span>
                </div>
              </div>
              {/* Mobile-only nav row: horizontally scrollable so all 7 links
                  remain reachable on a 375px viewport without forcing the
                  brand row to wrap. */}
              <div className="md:hidden px-4 pb-2 -mt-1 overflow-x-auto scrollbar-none">
                <NavLinks />
              </div>
            </div>
          </header>

          <main
            id="main"
            className="relative z-10 px-5 sm:px-6 py-6 pb-16 max-w-[1400px] mx-auto animate-fade-in"
          >
            {children}
          </main>

          <StatusTicker />
        </NetworkProvider>
      </body>
    </html>
  );
}
