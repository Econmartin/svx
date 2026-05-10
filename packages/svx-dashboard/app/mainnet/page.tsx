'use client';

/**
 * Mainnet (Polymarket) overview page.
 *
 * Talks to the bot-mainnet service via NEXT_PUBLIC_SVX_API_MAINNET. The
 * Polymarket-focused twin of the testnet Predict overview at `/`.
 *
 * Predict signals still drive the spread analysis (Predict has no Sui mainnet
 * yet) but execution lands on Polymarket pUSD. The page surfaces:
 *   - pUSD wallet balance + POL gas + wallet address
 *   - Current spread signals (same data shape, different bot)
 *   - Open Polymarket positions with fill price, shares, status
 *   - Realized pUSD PnL (once we wire poly settlement)
 */

import { useCallback } from 'react';
import {
  apiMainnet,
  formatPct,
  formatRelative,
  formatUsdc,
  type TradeRecord,
} from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { StatRow } from '@/components/StatRow';
import { StatusBadge } from '@/components/StatusBadge';

export default function MainnetOverviewPage() {
  const fetchStatus = useCallback(() => apiMainnet.status(), []);
  const fetchOpen = useCallback(() => apiMainnet.positionsOpen(), []);
  const fetchSignals = useCallback(() => apiMainnet.signals(20), []);

  const { data: status, error: statusError } = usePolling(fetchStatus, 10_000);
  const { data: open } = usePolling(fetchOpen, 10_000);
  const { data: recentSignals } = usePolling(fetchSignals, 5_000);

  if (!apiMainnet.enabled) {
    return (
      <div className="rounded border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
        <strong>Mainnet API URL not configured.</strong> Set{' '}
        <code className="font-mono">NEXT_PUBLIC_SVX_API_MAINNET</code> at dashboard
        build time (Coolify env panel) to point at the <code>bot-mainnet</code>{' '}
        service.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-3">
            Mainnet · Polymarket
            <span className="text-xs uppercase tracking-wider px-2 py-0.5 rounded font-mono bg-loss/20 text-loss border border-loss/40">
              real money
            </span>
          </h1>
          <p className="text-muted text-sm mt-1">
            Polymarket execution on Polygon mainnet, signals from testnet Predict
            (no Sui mainnet yet).
          </p>
        </div>
        {status && (
          <StatusBadge
            paused={status.paused}
            reason={status.pauseReason}
            live={!!status.polyExecutionEnabled}
          />
        )}
      </header>

      {statusError && (
        <div className="rounded border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
          Could not reach the mainnet bot API: {statusError}.
        </div>
      )}

      <StatRow
        stats={[
          {
            label: 'BTC spot',
            value: status?.spotBtc != null ? `$${formatUsdc(status.spotBtc, 0)}` : '—',
            hint: status?.spotBtcAtMs ? formatRelative(status.spotBtcAtMs) : 'no oracle yet',
          },
          {
            label: `pUSD (${status?.polyNetwork ?? 'polygon'})`,
            value: formatUsdc(status?.polyPusdBalance ?? 0),
            hint: status?.polyExecutionEnabled
              ? status.polyBalanceAtMs
                ? `live · synced ${formatRelative(status.polyBalanceAtMs)}`
                : 'live · awaiting sync'
              : status?.polyBalanceAtMs
                ? `read-only · ${formatRelative(status.polyBalanceAtMs)}`
                : 'read-only · awaiting sync',
          },
          {
            label: 'POL (gas)',
            value: status?.polyGasPol != null ? status.polyGasPol.toFixed(3) : '—',
            hint: 'native gas balance',
          },
          {
            label: 'Open poly positions',
            value: open?.filter((t) => t.polyStatus === 'filled').length ?? '—',
            hint: `${status?.openPositionCount ?? 0} total trades open`,
          },
          {
            label: 'Signals 24h',
            value: status?.signalsLast24h ?? '—',
            hint: `${status?.tradesLast24h ?? 0} executed`,
          },
        ]}
      />

      <section className="rounded border border-border bg-surface p-4">
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">
          Wallet
        </h2>
        {status?.polyAddress ? (
          <div className="font-mono text-sm space-y-1">
            <div>
              <span className="text-muted">address: </span>
              <a
                href={`https://polygonscan.com/address/${status.polyAddress}`}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-accent"
              >
                {status.polyAddress}
              </a>
            </div>
            <div className="text-muted text-xs">
              {status.polyExecutionEnabled
                ? 'Execution ENABLED — bot will fire orders on signals.'
                : 'Execution OFF — bot is observing only. Flip POLY_EXECUTION_ENABLED to true to go live.'}
            </div>
          </div>
        ) : (
          <p className="text-muted text-sm">
            No Polymarket wallet configured. Set <code>POLY_PRIVATE_KEY</code> +
            run <code>setup-poly-wallet</code>.
          </p>
        )}
      </section>

      <section className="rounded border border-border bg-surface p-4">
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">
          Open Polymarket positions
        </h2>
        <div className="overflow-x-auto">
          <table className="font-mono w-full">
            <thead>
              <tr>
                <th>Opened</th>
                <th>Strike</th>
                <th>Outcome</th>
                <th>Shares</th>
                <th>Fill price</th>
                <th>Cost (pUSD)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(open ?? [])
                .filter((t) => !!t.polyStatus)
                .map((t) => (
                  <tr key={t.id} className={polyRowClass(t)}>
                    <td className="text-muted">{new Date(t.timestampMs).toLocaleTimeString()}</td>
                    <td>${t.strike.toFixed(0)}</td>
                    <td>{t.polyOutcome?.toUpperCase() ?? '—'}</td>
                    <td>{t.polyFilledShares?.toFixed(2) ?? '—'}</td>
                    <td>{t.polyFillPrice != null ? formatPct(t.polyFillPrice, 2) : '—'}</td>
                    <td>{formatUsdc(t.polyCostUsdc)}</td>
                    <td className="text-xs">{t.polyStatus}</td>
                  </tr>
                ))}
              {!(open ?? []).some((t) => t.polyStatus) && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    No Polymarket positions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded border border-border bg-surface p-4">
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">
          Last 20 signals
        </h2>
        <div className="overflow-x-auto">
          <table className="font-mono w-full">
            <thead>
              <tr>
                <th>Time</th>
                <th>Strike</th>
                <th>Predict↑</th>
                <th>Poly Yes</th>
                <th>Spread</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {recentSignals?.map((s) => (
                <tr key={s.id} className={signalRowClass(s.action)}>
                  <td className="text-muted">{new Date(s.timestampMs).toLocaleTimeString()}</td>
                  <td>${s.strike.toFixed(0)}</td>
                  <td>{formatPct(s.predictProb)}</td>
                  <td>{formatPct(s.polyProb)}</td>
                  <td>{formatPct(s.spread)}</td>
                  <td className="text-xs">
                    {s.action}
                    {s.filterReason ? ` (${s.filterReason})` : ''}
                  </td>
                </tr>
              ))}
              {!recentSignals?.length && (
                <tr>
                  <td colSpan={6} className="text-center text-muted py-4">
                    No signals yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function polyRowClass(t: TradeRecord): string {
  if (t.polyStatus === 'failed') return 'text-loss';
  if (t.polyStatus === 'partial') return 'text-muted';
  return '';
}

function signalRowClass(action: string): string {
  if (action === 'paper_executed' || action === 'live_executed') return 'text-win';
  if (action === 'filtered') return 'text-muted';
  return '';
}
