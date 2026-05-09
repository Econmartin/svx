'use client';

import { useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api, formatPct, formatUsdc } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { StatRow } from '@/components/StatRow';
import { StatusBadge } from '@/components/StatusBadge';

export default function OverviewPage() {
  const fetchStatus = useCallback(() => api.status(), []);
  const fetchClosed = useCallback(() => api.positionsClosed(500), []);
  const fetchSignals = useCallback(() => api.signals(20), []);

  const { data: status, error: statusError } = usePolling(fetchStatus, 10_000);
  const { data: closed } = usePolling(fetchClosed, 30_000);
  const { data: recentSignals } = usePolling(fetchSignals, 5_000);

  // Build a cumulative PnL series from closed trades.
  let cumPnl = 0;
  const pnlSeries =
    (closed ?? [])
      .slice()
      .sort((a, b) => a.timestampMs - b.timestampMs)
      .map((t) => {
        cumPnl += t.pnlUsdc ?? 0;
        return { ts: t.timestampMs, pnl: cumPnl };
      }) ?? [];

  const wins = (closed ?? []).filter((t) => (t.pnlUsdc ?? 0) > 0).length;
  const winRate = closed && closed.length > 0 ? wins / closed.length : 0;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SVX Overview</h1>
          <p className="text-muted text-sm mt-1">
            Cross-venue volatility arbitrage between DeepBook Predict and Polymarket BTC binaries.
          </p>
        </div>
        {status && (
          <StatusBadge
            paused={status.paused}
            reason={status.pauseReason}
            live={status.liveTradingEnabled}
          />
        )}
      </header>

      {statusError && (
        <div className="rounded border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
          Could not reach SVX API: {statusError}. Make sure the bot is running with{' '}
          <code className="font-mono">pnpm svx start</code>.
        </div>
      )}

      <StatRow
        stats={[
          {
            label: 'NAV (dUSDC)',
            value: formatUsdc(status?.navUsdc),
            hint: status?.liveTradingEnabled ? 'live' : 'paper',
          },
          {
            label: 'Realized PnL',
            value: formatUsdc(status?.realizedPnlUsdc),
            hint: status ? `${closed?.length ?? 0} closed trades` : '',
          },
          {
            label: 'Win rate',
            value: closed && closed.length > 0 ? formatPct(winRate, 1) : '—',
            hint: closed ? `${wins}/${closed.length}` : '',
          },
          {
            label: 'Signals 24h',
            value: status?.signalsLast24h ?? '—',
            hint: `${status?.tradesLast24h ?? 0} executed`,
          },
        ]}
      />

      <section className="rounded border border-border bg-surface p-4">
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Cumulative realized PnL</h2>
        <div className="h-64">
          {pnlSeries.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={pnlSeries} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => new Date(v).toLocaleTimeString()}
                  tick={{ fontSize: 11, fill: '#8c93a3' }}
                  scale="time"
                />
                <YAxis tick={{ fontSize: 11, fill: '#8c93a3' }} />
                <Tooltip
                  labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                  contentStyle={{ background: '#11141b', border: '1px solid #1c2230' }}
                />
                <Line type="monotone" dataKey="pnl" stroke="#7dd3fc" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-muted text-sm">
              No closed trades yet — chart populates after first settlement.
            </div>
          )}
        </div>
      </section>

      <section className="rounded border border-border bg-surface p-4">
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Last 20 signals</h2>
        <div className="overflow-x-auto">
          <table className="font-mono">
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
                <tr key={s.id} className={rowClass(s.action)}>
                  <td className="text-muted">{new Date(s.timestampMs).toLocaleTimeString()}</td>
                  <td>${s.strike.toFixed(0)}</td>
                  <td>{formatPct(s.predictProb)}</td>
                  <td>{formatPct(s.polyProb)}</td>
                  <td>{formatPct(s.spread)}</td>
                  <td className="text-xs">{s.action}{s.filterReason ? ` (${s.filterReason})` : ''}</td>
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

      <footer className="text-xs text-muted font-mono">
        Predict package:{' '}
        <a
          className="underline hover:text-accent"
          href={`https://suiscan.xyz/testnet/object/${status?.predictPackageId ?? ''}`}
          target="_blank"
          rel="noreferrer"
        >
          {status?.predictPackageId?.slice(0, 16) ?? '—'}…
        </a>
      </footer>
    </div>
  );
}

function rowClass(action: string): string {
  if (action === 'paper_executed' || action === 'live_executed') return 'text-win';
  if (action === 'filtered') return 'text-muted';
  return '';
}
