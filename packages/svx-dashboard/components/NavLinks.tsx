'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback } from 'react';
import { cn } from '@/lib/cn';
import { v2LivePnl } from '@/lib/api';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';

/**
 * Nav order = status board, not build history: live strategies first, then
 * the read-only infrastructure pages, then research, then closed
 * experiments. Strategy tabs carry a status dot:
 *
 *   green  — actively trading right now
 *   orange — research / paused (not currently traded, still maintained)
 *   red    — closed experiment (measured, post-mortemed, switched off)
 *
 * Green/orange are DERIVED from the bots' /status (trades in the last 24h,
 * open positions, execution gates) so the nav can't claim a strategy is
 * live when its feed died — that exact lie sat here hardcoded while the
 * mainnet signal stream had been down for a week. Red stays hardcoded:
 * closing an experiment is an editorial decision, not a telemetry state.
 *
 * Info pages (Overview, Surface, …) carry no dot on purpose — status
 * applies to strategies, not windows.
 */
type NavStatus = 'active' | 'stale' | 'closed' | undefined;

const NAV: ReadonlyArray<readonly [label: string, href: string, status?: NavStatus]> = [
  ['Overview', '/overview'],
  ['Fade spike', '/fade-spike', 'stale'], // derived live below
  ['Divergence', '/divergence-mint', 'stale'], // derived live below
  ['Poly-arb', '/poly-arb', 'stale'], // derived live below
  ['Positions', '/positions'],
  ['Surface', '/surface'],
  ['Signals', '/signals'],
  ['Wallets', '/wallets'],
  ['Vaults', '/vaults', 'stale'],
  ['IV-RV', '/vol-arb', 'closed'],
  ['Margin-Lever', '/margin-lever', 'closed'],
  ['About', '/about'],
] as const;

const DAY_MS = 24 * 3600_000;

/**
 * Live status for the two derived tabs, from the bot the CURRENT network
 * toggle points at — the dot describes what the page will show when clicked,
 * so the same tab can be green on one network and orange on the other
 * (e.g. Poly-arb trades real money only on the mainnet instance). Falls back
 * to 'stale' when the bot is unreachable — an offline bot is by definition
 * not actively trading.
 */
function useDerivedStatus(): Partial<Record<string, NavStatus>> {
  const client = useApiClient();
  const { data: status } = usePolling(
    useCallback(() => client.status().catch(() => null), [client]),
    60_000,
  );
  const v2 = v2LivePnl(status?.strategyPnl ?? undefined);
  const divergenceActive =
    !!status &&
    !status.paused &&
    status.harvestV2Enabled !== false && // master switch off = not trading
    (v2.trades24h > 0 || v2.open > 0);
  const polyActive =
    !!status &&
    !status.paused &&
    !!status.polyExecutionEnabled &&
    ((status.lastPolyAttemptAtMs ?? 0) > Date.now() - DAY_MS ||
      (status.realizedPolyPnl24hUsdc ?? 0) !== 0);
  const fade = (status?.strategyPnl ?? []).filter((r) => r.strategy === 'fade_spike');
  const fadeActive =
    !!status && !status.paused && fade.some((r) => r.trades24h > 0 || r.open > 0);
  return {
    '/fade-spike': fadeActive ? 'active' : 'stale',
    '/divergence-mint': divergenceActive ? 'active' : 'stale',
    '/poly-arb': polyActive ? 'active' : 'stale',
  };
}

const DOT: Record<Exclude<NavStatus, undefined>, { cls: string; title: string }> = {
  active: { cls: 'bg-accent', title: 'actively trading' },
  stale: { cls: 'bg-amber-400', title: 'research / not currently traded' },
  closed: { cls: 'bg-loss', title: 'closed experiment (post-mortem on page)' },
};

/**
 * Top-nav links. The active route is a quiet frosted pill (the way native
 * segmented navigation reads); green is reserved for status and data, so
 * the accent keeps meaning something.
 */
export function NavLinks() {
  const pathname = usePathname();
  const derived = useDerivedStatus();
  return (
    <nav aria-label="Primary" className="flex items-center gap-0.5 text-[13.5px] tracking-[-0.01em]">
      {NAV.map(([label, href, status]) => {
        const isActive = pathname === href || pathname?.startsWith(`${href}/`);
        const effective = derived[href] ?? status;
        const dot = effective ? DOT[effective] : null;
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            title={dot?.title}
            className={cn(
              'inline-flex items-center gap-1.5 h-8 px-2.5 xl:px-3 rounded-full transition-[background-color,color] duration-200 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
              isActive
                ? 'bg-white/[0.1] text-fg font-medium'
                : 'text-muted hover:text-fg hover:bg-white/[0.05]',
            )}
          >
            {dot && (
              <span
                aria-hidden
                className={cn(
                  'inline-block w-1.5 h-1.5 rounded-full shrink-0',
                  dot.cls,
                )}
              />
            )}
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
