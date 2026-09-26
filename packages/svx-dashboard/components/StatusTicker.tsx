'use client';

/**
 * Fixed-position bottom ticker bar — connection state on the left, live
 * tickers (BTC spot, NAV, open positions, paused state) scrolling across
 * the right. Modeled on the BlockTrade / Hyperliquid reference: gives the
 * dashboard a sense of "always-on" that an idle Coolify deploy lacks.
 */

import { useCallback } from 'react';
import { useApiClient, useNetwork } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import { formatUsdc, v2LivePnl } from '@/lib/api';

/** Strategies the mainnet bot can run live on Predict today. */
const CURRENT_PREDICT = ['fade_spike', 'auto_shadow', 'calibration_harvest', 'divergence_mint'];

export function StatusTicker() {
  const client = useApiClient();
  const { network } = useNetwork();
  const isMainnet = network === 'mainnet';
  const { data: status, error } = usePolling(
    useCallback(() => client.status(), [client]),
    5_000,
  );

  // Lightweight ping — round-trip from the fetch to update gives us a
  // rough latency-to-bot measurement.
  const latencyMs = status ? '~stable' : error ? 'offline' : '…';
  const stateColor = status
    ? status.paused
      ? 'text-loss'
      : 'text-accent'
    : error
      ? 'text-loss'
      : 'text-muted';
  const stateLabel = status ? (status.paused ? 'Paused' : 'Live') : error ? 'Offline' : 'Connecting';

  const items: Array<{ label: string; value: string; tone?: 'win' | 'loss' | 'muted' }> = [];

  if (status) {
    if (status.spotBtc != null) {
      items.push({ label: 'BTC', value: `$${formatUsdc(status.spotBtc, 0)}` });
    }
    if (isMainnet) {
      // What the mainnet bot trades today: the Predict account and its live
      // strategies. Polymarket / Hyperliquid only appear while enabled.
      const liveRows = (status.strategyPnl ?? []).filter(
        (r) => r.mode === 'live' && CURRENT_PREDICT.includes(r.strategy),
      );
      const pnl24h = liveRows.reduce((a, r) => a + r.pnl24hUsdc, 0);
      const openLive = liveRows.reduce((a, r) => a + r.open, 0);
      if (status.v2WrapperBalanceUsdc != null) {
        items.push({ label: 'Balance', value: `$${formatUsdc(status.v2WrapperBalanceUsdc)}` });
      }
      items.push({
        label: 'Today',
        value: `${pnl24h >= 0 ? '+' : '−'}$${Math.abs(pnl24h).toFixed(2)}`,
        tone: pnl24h > 0 ? 'win' : pnl24h < 0 ? 'loss' : 'muted',
      });
      items.push({ label: 'Open', value: String(openLive) });
      if (status.polyExecutionEnabled && status.polyPusdBalance != null) {
        items.push({ label: 'pUSD', value: formatUsdc(status.polyPusdBalance) });
      }
      if (status.hlExecutionEnabled && status.hlAccountValueUsdc != null) {
        items.push({ label: 'HL', value: `$${formatUsdc(status.hlAccountValueUsdc)}` });
      }
    } else {
      // Current-generation strategies only — the all-time blend counts the
      // retired V1 poly-arb era, which is not what "PnL" should tick.
      const realized = status.strategyPnl
        ? v2LivePnl(status.strategyPnl).pnlUsdc
        : status.realizedPnlUsdc ?? 0;
      items.push({
        label: 'NAV',
        value: `$${formatUsdc(status.navUsdc ?? 0)}`,
      });
      items.push({
        label: 'V2 PnL',
        value: `${realized >= 0 ? '+' : ''}$${realized.toFixed(2)}`,
        tone: realized >= 0 ? 'win' : 'loss',
      });
    }
    if (!isMainnet && status.openPositionCount != null) {
      items.push({ label: 'Open', value: status.openPositionCount.toString() });
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Live bot status"
      className="fixed bottom-0 left-0 right-0 z-30 border-t border-white/[0.06] bg-bg/80 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-bg/60"
    >
      <div className="mx-auto max-w-[1600px] px-6 h-9 flex items-center gap-4 text-[12px] font-mono tabular-nums overflow-x-auto whitespace-nowrap scrollbar-none">
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            aria-hidden
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              status && !status.paused ? 'bg-accent animate-pulse-glow' : status?.paused ? 'bg-loss' : 'bg-muted'
            }`}
          />
          <span className={`font-semibold ${stateColor}`}>{stateLabel}</span>
          <span aria-hidden className="text-muted/60">·</span>
          <span className="text-muted capitalize">{network}</span>
          <span aria-hidden className="text-muted/60">·</span>
          <span className="text-muted">{latencyMs}</span>
        </div>
        <div className="flex items-center gap-5 ml-auto overflow-x-auto">
          {items.map((it) => (
            <span key={it.label} className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-muted text-[12px]">
                {it.label}
              </span>
              <span
                className={
                  it.tone === 'win'
                    ? 'text-win'
                    : it.tone === 'loss'
                      ? 'text-loss'
                      : 'text-fg'
                }
              >
                {it.value}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
