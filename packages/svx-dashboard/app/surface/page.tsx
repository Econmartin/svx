'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useApiClient } from '@/lib/network-context';
import { formatPct, formatTime } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

export default function SurfacePage() {
  const client = useApiClient();
  const { data: oracles } = usePolling(useCallback(() => client.oracles(), [client]), 30_000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMath, setShowMath] = useState(false);

  useEffect(() => {
    if (oracles && oracles.length > 0 && !selectedId) {
      setSelectedId(oracles[0].oracleId);
    }
  }, [oracles, selectedId]);

  const surfaceFetcher = useCallback(
    () => (selectedId ? client.surface(selectedId) : Promise.resolve(null)),
    [client, selectedId],
  );
  const { data: surface } = usePolling(surfaceFetcher, 10_000);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Volatility surface</h1>
          <p className="text-muted text-sm mt-1">
            Raw SVI parameters from DeepBook Predict, evaluated across a strike grid.
            The smile that drives every signal.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {(oracles ?? []).slice(0, 6).map((o) => {
            const active = o.oracleId === selectedId;
            const mins = Math.max(0, Math.round((o.expiryMs - Date.now()) / 60_000));
            return (
              <Button
                key={o.oracleId}
                variant={active ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedId(o.oracleId)}
              >
                {mins < 60 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`}
              </Button>
            );
          })}
        </div>
      </header>

      {surface ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SurfaceStat label="Spot" value={`$${surface.spot.toFixed(2)}`} />
            <SurfaceStat label="Forward" value={`$${surface.forward.toFixed(2)}`} />
            <SurfaceStat label="Expiry" value={formatTime(surface.expiryMs)} />
            <SurfaceStat
              label="Time to expiry"
              value={`${((surface.expiryMs - Date.now()) / 60_000).toFixed(1)}m`}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Implied vol smile</CardTitle>
                <p className="text-xs text-muted">
                  IV(K) = √(w(k) / T). The shape is the SVI smile that all
                  binary probabilities derive from.
                </p>
              </CardHeader>
              <CardContent>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={surface.points} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
                      <XAxis
                        dataKey="strike"
                        tick={{ fontSize: 11, fill: '#8c93a3' }}
                        tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: '#8c93a3' }}
                        tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                        domain={['auto', 'auto']}
                      />
                      <Tooltip
                        contentStyle={{
                          background: '#11141b',
                          border: '1px solid #1c2230',
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        formatter={(v: number) => [`${(v * 100).toFixed(2)}%`, 'IV']}
                        labelFormatter={(v) => `K=$${Number(v).toFixed(0)}`}
                      />
                      <ReferenceLine
                        x={surface.forward}
                        stroke="#7dd3fc"
                        strokeDasharray="4 4"
                        label={{ value: 'F', fill: '#7dd3fc', fontSize: 11, position: 'top' }}
                      />
                      <Line type="monotone" dataKey="iv" stroke="#7dd3fc" dot={false} strokeWidth={2.5} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>UP probability — N(d2)</CardTitle>
                <p className="text-xs text-muted">
                  P(spot &gt; K at expiry). The fair value of every "Yes" outcome.
                </p>
              </CardHeader>
              <CardContent>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={surface.points} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
                      <defs>
                        <linearGradient id="upFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
                          <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
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
                        contentStyle={{
                          background: '#11141b',
                          border: '1px solid #1c2230',
                          borderRadius: 6,
                          fontSize: 12,
                        }}
                        formatter={(v: number) => [formatPct(v), 'P(spot > K)']}
                        labelFormatter={(v) => `K=$${Number(v).toFixed(0)}`}
                      />
                      <ReferenceLine
                        x={surface.forward}
                        stroke="#7dd3fc"
                        strokeDasharray="4 4"
                      />
                      <ReferenceLine y={0.5} stroke="#2a3142" strokeDasharray="2 2" />
                      <Area
                        type="monotone"
                        dataKey="up"
                        stroke="#10b981"
                        strokeWidth={2.5}
                        fill="url(#upFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle>SVI parameters</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setShowMath(!showMath)}>
                {showMath ? 'Hide math' : 'Show math'}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <SurfaceStat label="a" value={surface.svi.a.toFixed(6)} />
                <SurfaceStat label="b" value={surface.svi.b.toFixed(6)} />
                <SurfaceStat label="ρ" value={surface.svi.rho.toFixed(4)} />
                <SurfaceStat label="m" value={surface.svi.m.toFixed(4)} />
                <SurfaceStat label="σ" value={surface.svi.sigma.toFixed(4)} />
              </div>
              {showMath && (
                <div className="mt-4 p-4 bg-surface-elevated rounded-lg border border-border space-y-3">
                  <MathRow
                    label="Total variance"
                    formula="w(k) = a + b · (ρ(k − m) + √((k − m)² + σ²))"
                  />
                  <MathRow
                    label="Log-moneyness"
                    formula="k = ln(K / F)"
                  />
                  <MathRow
                    label="Annualized IV"
                    formula="σ(K) = √(w(k) / T)"
                  />
                  <MathRow
                    label="Binary fair value"
                    formula="P(spot > K) = N(d₂),    d₂ = −(k + w/2) / √w"
                  />
                  <MathRow
                    label="Cross-expiry reprice"
                    formula="w_target = σ(K)² · T_poly    →    P_poly = N(d₂_target)"
                  />
                  <p className="text-xs text-muted">
                    All implementation in
                    <code className="px-1 mx-1 bg-bg rounded font-mono">packages/svx-bot/src/pricing/{`{svi,bs}`}.ts</code>,
                    validated against Python <code className="font-mono">math.erf</code> reference vectors.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted text-sm">
            Loading surface…
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SurfaceStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm truncate">{value}</div>
    </div>
  );
}

function MathRow({ label, formula }: { label: string; formula: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-3">
      <span className="text-xs uppercase tracking-wider text-muted shrink-0 w-32">
        {label}
      </span>
      <code className="font-mono text-sm text-white">{formula}</code>
    </div>
  );
}
