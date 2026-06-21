'use client';

/**
 * SVI parameter drift — small-multiples chart.
 *
 * Surface stability is the strategy's risk gate. The raw SVI params drift
 * tick-by-tick as Predict's oracle refreshes; eyeballing those drifts tells
 * the operator when the surface is choppy and when it's locked in. We render
 * one mini-LineChart per param (a, b, ρ, m, σ) on its own y-axis so each
 * series can use its natural range — overlaying them on one chart obscures
 * the small swings the operator actually cares about.
 */

import type { SurfaceHistoryPoint } from '@/lib/api';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Props {
  points: SurfaceHistoryPoint[];
}

const PARAMS: Array<{
  key: 'a' | 'b' | 'rho' | 'm' | 'sigma';
  label: string;
  /** Hexcolour for the line. */
  stroke: string;
  /** How many decimals to show on the axis + tooltip. */
  decimals: number;
}> = [
  { key: 'a', label: 'a', stroke: '#1eff8a', decimals: 5 },
  { key: 'b', label: 'b', stroke: '#7dd3fc', decimals: 4 },
  { key: 'rho', label: 'ρ', stroke: '#ffb648', decimals: 4 },
  { key: 'm', label: 'm', stroke: '#ff5a5f', decimals: 4 },
  { key: 'sigma', label: 'σ', stroke: '#c084fc', decimals: 4 },
];

export function SviHistoryChart({ points }: Props) {
  if (points.length === 0) {
    return (
      <div className="text-muted text-sm py-12 text-center">
        No SVI snapshots persisted yet for this oracle — chart populates as
        the bot polls.
      </div>
    );
  }
  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        {PARAMS.map((p) => (
          <Sparkline
            key={p.key}
            label={p.label}
            stroke={p.stroke}
            decimals={p.decimals}
            data={points.map((pt) => ({ tsMs: pt.tsMs, value: pt[p.key] as number }))}
          />
        ))}
      </div>
      <p className="text-[11px] text-muted mt-3">
        {points.length} snapshots over{' '}
        {humanizeSpan(points[0]!.tsMs, points[points.length - 1]!.tsMs)} ·
        oldest left, newest right.
      </p>
    </div>
  );
}

function Sparkline({
  label,
  stroke,
  decimals,
  data,
}: {
  label: string;
  stroke: string;
  decimals: number;
  data: Array<{ tsMs: number; value: number }>;
}) {
  const last = data[data.length - 1]?.value ?? 0;
  const first = data[0]?.value ?? 0;
  const delta = last - first;
  return (
    <div className="rounded-lg border border-border bg-surface/60 p-3 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wider text-muted font-medium">{label}</span>
        <span className="font-mono text-sm tabular-nums text-fg">
          {last.toFixed(decimals)}
        </span>
      </div>
      <div className="h-16 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 2, right: 4, left: 4, bottom: 2 }}>
            <CartesianGrid strokeDasharray="2 3" stroke="#1c2230" vertical={false} />
            <XAxis dataKey="tsMs" hide />
            <YAxis
              tick={false}
              axisLine={false}
              tickLine={false}
              domain={['auto', 'auto']}
            />
            <Tooltip
              contentStyle={{
                background: '#11141b',
                border: '1px solid #1c2230',
                borderRadius: 6,
                fontSize: 11,
              }}
              labelFormatter={(v) => new Date(Number(v)).toLocaleTimeString()}
              formatter={(v: number) => [v.toFixed(decimals), label]}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke={stroke}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="text-[10px] text-muted font-mono tabular-nums">
        Δ{' '}
        <span className={delta >= 0 ? 'text-win' : 'text-loss'}>
          {delta >= 0 ? '+' : ''}
          {delta.toFixed(decimals)}
        </span>
      </div>
    </div>
  );
}

function humanizeSpan(startMs: number, endMs: number): string {
  const sec = Math.max(0, (endMs - startMs) / 1000);
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(0)}m`;
  const hr = min / 60;
  if (hr < 24) return `${hr.toFixed(1)}h`;
  return `${(hr / 24).toFixed(1)}d`;
}
