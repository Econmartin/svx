'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
} from 'recharts';
import { useApiClient } from '@/lib/network-context';
import { formatPct, formatRelative } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';

const ACTIONS = ['all', 'executed', 'sub_threshold', 'filtered'] as const;
type Filter = (typeof ACTIONS)[number];

export default function SignalsPage() {
  const client = useApiClient();
  const fetchSignals = useCallback(() => client.signals(200), [client]);
  const { data, error } = usePolling(fetchSignals, 5_000);
  const [filter, setFilter] = useState<Filter>('all');

  const rows = (data ?? []).filter((s) => {
    if (filter === 'all') return true;
    if (filter === 'executed')
      return s.action === 'paper_executed' || s.action === 'live_executed';
    return s.action === filter;
  });

  // Calibration scatter: how Predict and Polymarket disagree on probability,
  // strike-by-strike. The diagonal y=x is "perfect agreement"; points off the
  // line are where the bot trades.
  const scatterData = useMemo(
    () =>
      (data ?? []).map((s) => ({
        x: s.polyProb,
        y: s.predictProb,
        spread: s.spread,
        strike: s.strike,
        action: s.action,
      })),
    [data],
  );

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
          Signals
        </h1>
        <p className="text-muted text-[13.5px] max-w-3xl leading-relaxed">
          Real-time spread evaluations: Predict's SVI probability vs.
          Polymarket's order book.
        </p>
      </header>

      {error && (
        <div className="rounded border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
          {error}
        </div>
      )}

      <PageIntro
        summary={
          <>
            Every 15s the bot prices each matched (oracle, strike) pair on both venues and records the
            disagreement here. <strong>Each row is a decision the bot made</strong>: filtered (didn't qualify),
            sub-threshold (spread too small), executed (placed a trade), or failed (tried to execute but the
            venue rejected). It's the strategy's audit trail.
          </>
        }
        hints={[
          <>The <strong>scatter</strong> below plots Polymarket probability (x) vs Predict probability (y). Points on the y=x line are venues in agreement; points off the line are where the spread lives.</>,
          <>Use the <strong>tabs</strong> top-right to filter to executed-only when checking what actually fired.</>,
          <>Failed rows carry a <code className="font-mono text-[10px]">filter_reason</code> like <code className="font-mono text-[10px]">poly_thin_book</code> or <code className="font-mono text-[10px]">poly_maker_not_allowed</code> — useful for debugging mainnet config.</>,
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Calibration scatter — Predict vs Polymarket probability</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              On the y=x line, both venues agree. Points off the line are where we trade.
              Color = action (green executed, gray filtered).
            </p>
          </CardHeader>
          <CardContent>
            <CalibrationScatter data={scatterData} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Signal mix</CardTitle>
          </CardHeader>
          <CardContent>
            <SignalMix signals={data ?? []} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle>Signals — last 200</CardTitle>
            <p className="text-xs text-muted">
              {rows.length === (data?.length ?? 0)
                ? `Showing all ${rows.length}`
                : `Showing ${rows.length} of ${data?.length ?? 0}`}
              {filter !== 'all' ? ` · filter: ${filter}` : ''}
            </p>
          </div>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
            <TabsList>
              {ACTIONS.map((a) => (
                <TabsTrigger key={a} value={a}>
                  {a}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Oracle</TableHead>
                <TableHead>Strike</TableHead>
                <TableHead>Predict↑</TableHead>
                <TableHead>Predict IV</TableHead>
                <TableHead>Poly Yes</TableHead>
                <TableHead>Poly IV</TableHead>
                <TableHead>Spread</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id} className={rowClass(s.action)}>
                  <TableCell className="text-muted text-xs">
                    {formatRelative(s.timestampMs)}
                  </TableCell>
                  <TableCell className="text-muted text-xs">
                    {s.oracleId.slice(0, 8)}…
                  </TableCell>
                  <TableCell>${s.strike.toFixed(0)}</TableCell>
                  <TableCell>{formatPct(s.predictProb)}</TableCell>
                  <TableCell>{formatPct(s.predictIv, 1)}</TableCell>
                  <TableCell>{formatPct(s.polyProb)}</TableCell>
                  <TableCell>{s.polyIv ? formatPct(s.polyIv, 1) : '—'}</TableCell>
                  <TableCell
                    className={
                      Math.abs(s.spread) > 0.03 ? 'font-semibold' : ''
                    }
                  >
                    {s.spread >= 0 ? '+' : ''}
                    {formatPct(s.spread, 2)}
                  </TableCell>
                  <TableCell>
                    <ActionBadge action={s.action} reason={s.filterReason} />
                  </TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted py-8">
                    No signals match this filter.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function rowClass(action: string): string {
  if (action === 'paper_executed' || action === 'live_executed') return 'text-win';
  if (action === 'filtered') return 'text-muted/70';
  return '';
}

function ActionBadge({ action, reason }: { action: string; reason?: string }) {
  if (action === 'paper_executed' || action === 'live_executed') {
    return <Badge variant="live">exec</Badge>;
  }
  if (action === 'sub_threshold') {
    return <Badge variant="outline">sub-thresh</Badge>;
  }
  return (
    <Badge variant="default" title={reason}>
      {reason ?? 'filtered'}
    </Badge>
  );
}

function SignalMix({
  signals,
}: {
  signals: import('@/lib/api').SignalRecord[];
}) {
  const counts = signals.reduce<Record<string, number>>((acc, s) => {
    const key = s.action === 'paper_executed' || s.action === 'live_executed'
      ? 'executed'
      : s.action === 'sub_threshold'
        ? 'sub_threshold'
        : `filtered: ${s.filterReason ?? 'unknown'}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const total = signals.length || 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-2">
      {entries.map(([k, v]) => {
        const pct = (v / total) * 100;
        const isExecuted = k === 'executed';
        const isSub = k === 'sub_threshold';
        const barColor = isExecuted
          ? 'bg-win'
          : isSub
            ? 'bg-accent'
            : 'bg-muted';
        return (
          <div key={k} className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted">{k}</span>
              <span className="font-mono tabular-nums">
                {v} <span className="text-muted">({pct.toFixed(0)}%)</span>
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-elevated overflow-hidden">
              <div
                className={`h-full ${barColor} transition-all`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
      {entries.length === 0 && (
        <div className="text-muted text-sm text-center py-4">No signals yet.</div>
      )}
    </div>
  );
}

interface ScatterPoint {
  x: number;
  y: number;
  spread: number;
  strike: number;
  action: string;
}

function CalibrationScatter({ data }: { data: ScatterPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted text-sm">
        No signals yet — chart populates as the bot evaluates spreads.
      </div>
    );
  }
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
          <XAxis
            dataKey="x"
            type="number"
            domain={[0, 1]}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            tick={{ fontSize: 11, fill: '#8c93a3' }}
            label={{
              value: 'Polymarket Yes ask',
              position: 'insideBottom',
              offset: -2,
              fill: '#8c93a3',
              fontSize: 11,
            }}
          />
          <YAxis
            dataKey="y"
            type="number"
            domain={[0, 1]}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
            tick={{ fontSize: 11, fill: '#8c93a3' }}
            label={{
              value: 'Predict ↑',
              angle: -90,
              position: 'insideLeft',
              fill: '#8c93a3',
              fontSize: 11,
              offset: 8,
            }}
          />
          <Tooltip
            contentStyle={{
              background: '#11141b',
              border: '1px solid #1c2230',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v: number, name) => [`${(v * 100).toFixed(1)}%`, name]}
            labelFormatter={() => ''}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0]!.payload as ScatterPoint;
              return (
                <div className="bg-surface border border-border rounded p-2 text-xs">
                  <div className="font-mono">Strike ${p.strike.toFixed(0)}</div>
                  <div>Predict: {(p.y * 100).toFixed(1)}%</div>
                  <div>Poly: {(p.x * 100).toFixed(1)}%</div>
                  <div>
                    Spread:{' '}
                    <span className={Math.abs(p.spread) > 0.03 ? 'text-win' : 'text-muted'}>
                      {p.spread >= 0 ? '+' : ''}
                      {(p.spread * 100).toFixed(2)}%
                    </span>
                  </div>
                  <div className="text-muted">{p.action}</div>
                </div>
              );
            }}
          />
          {/* y = x diagonal: perfect agreement */}
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke="#2a3142"
            strokeDasharray="3 3"
          />
          <Scatter data={data}>
            {data.map((p, i) => (
              <Cell
                key={i}
                fill={
                  p.action === 'paper_executed' || p.action === 'live_executed'
                    ? '#10b981'
                    : p.action === 'sub_threshold'
                      ? '#7dd3fc'
                      : '#6b7280'
                }
                fillOpacity={0.7}
              />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
