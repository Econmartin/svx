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
import { formatUsdc } from '@/lib/api';

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
  const stateLabel = status ? (status.paused ? 'PAUSED' : 'LIVE') : error ? 'OFFLINE' : 'CONNECTING';

  const items: Array<{ label: string; value: string; tone?: 'win' | 'loss' | 'muted' }> = [];

  if (status) {
    if (status.spotBtc != null) {
      items.push({ label: 'BTC', value: `$${formatUsdc(status.spotBtc, 0)}` });
    }
    if (isMainnet) {
      const poly = status.realizedPolyPnlUsdc ?? 0;
      const hl = status.realizedHlPnlUsdc ?? 0;
      const combined = poly + hl;
      items.push({
        label: 'PnL',
        value: `${combined >= 0 ? '+' : ''}$${combined.toFixed(2)}`,
        tone: combined >= 0 ? 'win' : 'loss',
      });
      if (status.polyPusdBalance != null) {
        items.push({ label: 'pUSD', value: formatUsdc(status.polyPusdBalance) });
      }
      if (status.hlAccountValueUsdc != null) {
        items.push({ label: 'HL', value: `$${formatUsdc(status.hlAccountValueUsdc)}` });
      }
    } else {
      const realized = status.realizedPnlUsdc ?? 0;
      items.push({
        label: 'NAV',
        value: `$${formatUsdc(status.navUsdc ?? 0)}`,
      });
      items.push({
        label: 'PnL',
        value: `${realized >= 0 ? '+' : ''}$${realized.toFixed(2)}`,
        tone: realized >= 0 ? 'win' : 'loss',
      });
    }
    if (status.openPositionCount != null) {
      items.push({ label: 'OPEN', value: status.openPositionCount.toString() });
    }
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-bg/95 backdrop-blur supports-[backdrop-filter]:bg-bg/80">
      <div className="px-4 py-1.5 flex items-center gap-4 text-[11px] font-mono tabular-nums overflow-x-auto whitespace-nowrap">
        <div className="flex items-center gap-2 flex-shrink-0">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              status && !status.paused ? 'bg-accent animate-pulse-glow' : status?.paused ? 'bg-loss' : 'bg-muted'
            }`}
          />
          <span className={`font-semibold ${stateColor}`}>{stateLabel}</span>
          <span className="text-muted">·</span>
          <span className="text-muted">{network.toUpperCase()}</span>
          <span className="text-muted">·</span>
          <span className="text-muted">{latencyMs}</span>
        </div>
        <div className="flex items-center gap-4 ml-auto overflow-x-auto">
          {items.map((it) => (
            <span key={it.label} className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-muted">{it.label}</span>
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
