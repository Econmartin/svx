'use client';

import { useCallback, useState } from 'react';
import { api, formatPct, formatRelative } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';

const ACTIONS = ['all', 'paper_executed', 'sub_threshold', 'filtered'] as const;
type Filter = (typeof ACTIONS)[number];

export default function SignalsPage() {
  const fetchSignals = useCallback(() => api.signals(200), []);
  const { data, error } = usePolling(fetchSignals, 5_000);
  const [filter, setFilter] = useState<Filter>('all');

  const rows = (data ?? []).filter((s) => filter === 'all' || s.action === filter);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Signals</h1>
        <div className="flex gap-2 text-xs">
          {ACTIONS.map((a) => (
            <button
              key={a}
              onClick={() => setFilter(a)}
              className={`px-3 py-1 rounded border ${
                filter === a
                  ? 'border-accent text-accent bg-accent/10'
                  : 'border-border text-muted hover:text-white'
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="text-loss text-sm">{error}</div>}

      <div className="rounded border border-border bg-surface overflow-x-auto">
        <table className="font-mono">
          <thead>
            <tr>
              <th>Time</th>
              <th>Oracle</th>
              <th>Strike</th>
              <th>Predict↑</th>
              <th>Predict IV</th>
              <th>Poly Yes</th>
              <th>Poly IV</th>
              <th>Spread</th>
              <th>IV Edge</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className={rowClass(s.action)}>
                <td className="text-muted">{formatRelative(s.timestampMs)}</td>
                <td className="text-muted">{s.oracleId.slice(0, 8)}…</td>
                <td>${s.strike.toFixed(0)}</td>
                <td>{formatPct(s.predictProb)}</td>
                <td>{formatPct(s.predictIv, 1)}</td>
                <td>{formatPct(s.polyProb)}</td>
                <td>{s.polyIv ? formatPct(s.polyIv, 1) : '—'}</td>
                <td>{formatPct(s.spread, 2)}</td>
                <td>{s.ivSpread ? formatPct(s.ivSpread, 1) : '—'}</td>
                <td className="text-xs">
                  {s.action}
                  {s.filterReason && <span className="text-muted"> · {s.filterReason}</span>}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={10} className="text-center text-muted py-6">
                  No signals match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function rowClass(action: string): string {
  if (action === 'paper_executed' || action === 'live_executed') return 'text-win';
  if (action === 'filtered') return 'text-muted';
  return '';
}
