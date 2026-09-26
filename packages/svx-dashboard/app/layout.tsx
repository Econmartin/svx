import './globals.css';
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { NetworkProvider } from '@/lib/network-context';
import { NetworkToggle } from '@/components/NetworkToggle';
import { NavLinks } from '@/components/NavLinks';
import { StatusTicker } from '@/components/StatusTicker';
import { FeedNotice } from '@/components/FeedNotice';

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
          {/* Temporary: frozen-feed notice; remove when the upstream feeder resumes. */}
          <FeedNotice />
          {/* Ambient atmosphere — fixed-position, no interaction cost. */}
          <div className="svx-ambient" aria-hidden />
          <div className="svx-grid" aria-hidden />

          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-bg focus:font-medium"
          >
            Skip to content
          </a>

          <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-bg/80 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-bg/60">
            {/* Two-row header on mobile (brand + toggles on top, scrollable
                nav below); single-row from md up. Keeps each row well within
                the viewport instead of clipping the nav off-screen. */}
            <div className="max-w-[1600px] mx-auto">
              <div className="px-4 sm:px-6 h-16 flex items-center gap-3 md:gap-5">
                <Link
                  href="/"
                  aria-label="SVX home"
                  className="flex items-center gap-2.5 whitespace-nowrap group h-8 flex-shrink-0"
                >
                  <span
                    aria-hidden
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#3dff9c] to-[#10d974] text-bg font-bold text-[15px] tracking-[-0.03em] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_1px_2px_rgba(0,0,0,0.4)] transition-transform duration-200 group-hover:scale-[1.04]"
                  >
                    S
                  </span>
                  <span className="flex items-baseline gap-1.5 leading-none">
                    <span className="font-semibold tracking-[-0.02em] text-[16px] text-fg">
                      SVX
                    </span>
                    <span aria-hidden className="text-[13px] text-muted font-normal tracking-[-0.01em]">
                      Vol-arb
                    </span>
                  </span>
                </Link>
                <span aria-hidden className="hidden md:block h-5 w-px bg-white/[0.08]" />
                <div className="hidden md:block min-w-0 flex-1">
                  <NavLinks />
                </div>
                <div className="ml-auto flex items-center gap-2 sm:gap-3 flex-shrink-0">
                  <NetworkToggle />
                  <span
                    aria-hidden
                    className="hidden xl:inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-3 h-7 text-[12px] text-muted whitespace-nowrap"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent/80" />
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
            className="relative z-10 px-5 sm:px-8 pt-10 pb-24 max-w-[1320px] mx-auto animate-fade-in"
          >
            {children}
          </main>

          <StatusTicker />
        </NetworkProvider>
      </body>
    </html>
  );
}
