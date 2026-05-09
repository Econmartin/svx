'use client';

import { useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api, formatPct, formatUsdc, formatRelative, type TradeRecord } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { StatRow } from '@/components/StatRow';
import { StatusBadge } from '@/components/StatusBadge';

export default function OverviewPage() {
  const fetchStatus = useCallback(() => api.status(), []);
  const fetchClosed = useCallback(() => api.positionsClosed(500), []);
  const fetchSignals = useCallback(() => api.signals(20), []);
  const fetchOpen = useCallback(() => api.positionsOpen(), []);

  const { data: status, error: statusError } = usePolling(fetchStatus, 10_000);
  const { data: closed } = usePolling(fetchClosed, 30_000);
  const { data: recentSignals } = usePolling(fetchSignals, 5_000);
  const { data: open } = usePolling(fetchOpen, 10_000);

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
            label: 'BTC spot',
            value: status?.spotBtc != null ? `$${formatUsdc(status.spotBtc, 0)}` : '—',
            hint: status?.spotBtcAtMs ? formatRelative(status.spotBtcAtMs) : 'no oracle yet',
          },
          {
            label: 'NAV (dUSDC)',
            value: formatUsdc(status?.navUsdc),
            hint: status?.liveTradingEnabled ? 'live' : 'paper',
          },
          {
            label: 'PnL (all time)',
            value: formatUsdc(status?.realizedPnlUsdc),
            hint: status ? `${closed?.length ?? 0} closed trades` : '',
          },
          {
            label: 'PnL (24h)',
            value: formatUsdc(status?.realizedPnl24hUsdc ?? 0),
            hint: closed && closed.length > 0 ? `win rate ${formatPct(winRate, 0)} (${wins}/${closed.length})` : '',
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
          Open positions{open?.length ? ` (${open.length})` : ''}
        </h2>
        <div className="overflow-x-auto">
          <table className="font-mono w-full">
            <thead>
              <tr>
                <th>Opened</th>
                <th>Strike</th>
                <th>Side</th>
                <th>Stake</th>
                <th>Entry</th>
                <th>Spot</th>
                <th>Distance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {open?.map((t) => {
                const m = moneyness(t, status?.spotBtc ?? null);
                return (
                  <tr key={t.id} className={m.cls}>
                    <td className="text-muted">{new Date(t.timestampMs).toLocaleTimeString()}</td>
                    <td>${t.strike.toFixed(0)}</td>
                    <td>{t.direction}</td>
                    <td>{formatUsdc(t.costUsdc)}</td>
                    <td>{formatPct(t.costPrice)}</td>
                    <td>{m.spotLabel}</td>
                    <td>{m.distLabel}</td>
                    <td className="text-xs">{m.statusLabel}</td>
                  </tr>
                );
              })}
              {!open?.length && (
                <tr>
                  <td colSpan={8} className="text-center text-muted py-4">
                    No open positions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

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

interface Moneyness {
  cls: string;
  spotLabel: string;
  distLabel: string;
  statusLabel: string;
}

function moneyness(t: TradeRecord, spot: number | null): Moneyness {
  if (spot == null) {
    return { cls: 'text-muted', spotLabel: '—', distLabel: '—', statusLabel: 'no spot' };
  }
  // direction='up' wins if spot > strike at expiry; 'down' wins if spot <= strike.
  const isWinning = t.direction === 'up' ? spot > t.strike : spot <= t.strike;
  const distAbs = spot - t.strike;
  const distPct = distAbs / t.strike;
  const distSign = distAbs >= 0 ? '+' : '';
  return {
    cls: isWinning ? 'text-win' : 'text-loss',
    spotLabel: `$${spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    distLabel: `${distSign}${distAbs.toFixed(0)} (${distSign}${(distPct * 100).toFixed(2)}%)`,
    statusLabel: isWinning ? 'ITM' : 'OTM',
  };
}
