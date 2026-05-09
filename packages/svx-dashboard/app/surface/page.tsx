'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, formatPct, formatTime } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';

export default function SurfacePage() {
  const { data: oracles } = usePolling(useCallback(() => api.oracles(), []), 30_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-select the soonest-expiring oracle when the list loads.
  useEffect(() => {
    if (oracles && oracles.length > 0 && !selectedId) {
      setSelectedId(oracles[0].oracleId);
    }
  }, [oracles, selectedId]);

  const surfaceFetcher = useCallback(
    () => (selectedId ? api.surface(selectedId) : Promise.resolve(null)),
    [selectedId],
  );
  const { data: surface } = usePolling(surfaceFetcher, 10_000);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Volatility surface</h1>
          <p className="text-muted text-sm mt-1">
            SVI-implied IV across strikes for each active oracle expiry.
          </p>
        </div>
        <select
          className="bg-surface border border-border rounded px-3 py-1 font-mono text-sm"
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {(oracles ?? []).map((o) => (
            <option key={o.oracleId} value={o.oracleId}>
              {o.oracleId.slice(0, 10)}… · expires {new Date(o.expiryMs).toLocaleTimeString()}
            </option>
          ))}
        </select>
      </header>

      {surface && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
            <Stat label="Spot" value={`$${surface.spot.toFixed(2)}`} />
            <Stat label="Forward" value={`$${surface.forward.toFixed(2)}`} />
            <Stat label="Expiry" value={formatTime(surface.expiryMs)} />
            <Stat label="As of" value={formatTime(surface.timestampMs)} />
          </div>

          <section className="rounded border border-border bg-surface p-4">
            <h2 className="text-sm uppercase tracking-wider text-muted mb-3">IV vs strike</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={surface.points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
                  <XAxis
                    dataKey="strike"
                    tick={{ fontSize: 11, fill: '#8c93a3' }}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#8c93a3' }}
                    tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                  />
                  <Tooltip
                    contentStyle={{ background: '#11141b', border: '1px solid #1c2230' }}
                    formatter={(v: number) => [`${(v * 100).toFixed(2)}%`, 'IV']}
                    labelFormatter={(v) => `K=$${Number(v).toFixed(0)}`}
                  />
                  <Line type="monotone" dataKey="iv" stroke="#7dd3fc" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded border border-border bg-surface p-4">
            <h2 className="text-sm uppercase tracking-wider text-muted mb-3">UP probability vs strike</h2>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={surface.points}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
                  <XAxis
                    dataKey="strike"
                    tick={{ fontSize: 11, fill: '#8c93a3' }}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  />
                  <YAxis
                    domain={[0, 1]}
                    tick={{ fontSize: 11, fill: '#8c93a3' }}
                    tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                  />
                  <Tooltip
                    contentStyle={{ background: '#11141b', border: '1px solid #1c2230' }}
                    formatter={(v: number) => [formatPct(v), 'P(spot > K)']}
                    labelFormatter={(v) => `K=$${Number(v).toFixed(0)}`}
                  />
                  <Area dataKey="up" stroke="#10b981" fill="#10b981" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <details className="text-xs text-muted font-mono">
            <summary className="cursor-pointer">Raw SVI parameters</summary>
            <pre className="mt-2 bg-surface p-3 rounded border border-border">
              {JSON.stringify(surface.svi, null, 2)}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-surface px-3 py-2">
      <div className="text-xs text-muted uppercase tracking-wider">{label}</div>
      <div className="mt-1 truncate">{value}</div>
    </div>
  );
}
