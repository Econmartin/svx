'use client';

/**
 * Cumulative PnL chart with optional Poly + HL leg breakdown.
 *
 * Renders Total / Poly / HL series as overlaid lines. On testnet view, only
 * Total appears (Predict's dUSDC PnL only — no Poly/HL data).
 */

import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ComposedChart,
  Legend,
} from 'recharts';
import type { TradeRecord } from '@/lib/api';

interface PnlPoint {
  ts: number;
  total: number;
  poly?: number;
  hl?: number;
}

export function PnlChart({
  closed,
  showLegs,
}: {
  closed: TradeRecord[];
  showLegs: boolean;
}) {
  // Settlement time is the x-axis we plot on, so it has to be the sort key
  // too — otherwise trades that opened in order but settled out of order
  // produce a backwards-jumping line. (Was sorting by timestampMs and
  // plotting at polySettledAtMs — they're different timestamps.)
  const pointTs = (t: TradeRecord): number => t.polySettledAtMs ?? t.timestampMs;
  const sorted = closed.slice().sort((a, b) => pointTs(a) - pointTs(b));
  const points: PnlPoint[] = [];
  let cumTotal = 0;
  let cumPoly = 0;
  let cumHl = 0;
  // Seed at zero just before the first trade so the line starts on the x-axis
  // (otherwise the first data point IS the first PnL value and the line just
  // appears mid-air).
  if (sorted.length > 0) {
    const seedTs = pointTs(sorted[0]!) - 1;
    points.push({ ts: seedTs, total: 0, poly: showLegs ? 0 : undefined, hl: showLegs ? 0 : undefined });
  }
  for (const t of sorted) {
    const polyPnl = t.polyPnlUsdc ?? 0;
    const hlPnl = t.hlPnlUsdc ?? 0;
    const sui = t.pnlUsdc ?? 0;
    // For mainnet (paper Predict) the "total" is poly + hl.
    // For testnet the "total" is just the Sui-side PnL.
    cumPoly += polyPnl;
    cumHl += hlPnl;
    cumTotal += showLegs ? polyPnl + hlPnl : sui;
    points.push({
      ts: pointTs(t),
      total: cumTotal,
      poly: showLegs ? cumPoly : undefined,
      hl: showLegs ? cumHl : undefined,
    });
  }

  if (points.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-center px-6">
        <div className="space-y-1">
          <div className="text-sm text-fg/80">Waiting on the first settled trade.</div>
          <div className="text-xs text-muted leading-relaxed max-w-md">
            On mainnet, that's the first Polymarket fill to either hit{' '}
            <span className="font-mono">+20%</span> mark profit (mid-life
            exit) or have its UMA resolution finalised — usually 1–6h after
            expiry.
          </div>
        </div>
      </div>
    );
  }

  // "Now" anchor — extend the staircase to the current time so the line ends
  // at the right edge of the chart, not at the last trade's timestamp.
  // Skipped if the last trade IS within ~30s of now (avoids a stub segment).
  const last = points[points.length - 1]!;
  const nowMs = Date.now();
  if (nowMs - last.ts > 30_000) {
    points.push({ ts: nowMs, total: last.total, poly: last.poly, hl: last.hl });
  }

  const totalColor = cumTotal >= 0 ? '#1eff8a' : '#ff5a5f';

  // Generate one tick per midnight UTC across the visible time span so the
  // x-axis shows "13 Jun · 14 Jun · 15 Jun" once each instead of recharts'
  // auto-picker producing several same-day labels.
  const dayTicks: number[] = [];
  if (points.length > 0) {
    const firstTs = points[0]!.ts;
    const lastTs = points[points.length - 1]!.ts;
    // Snap to UTC midnight on the day BEFORE the first point so the line's
    // seed point lands inside the tick range.
    const startDay = new Date(firstTs);
    startDay.setUTCHours(0, 0, 0, 0);
    for (let t = startDay.getTime(); t <= lastTs; t += 24 * 3600_000) {
      dayTicks.push(t);
    }
  }
  // For sub-day spans, fall back to hourly ticks so we don't get a blank axis.
  const spansLessThanADay = points.length > 1 && points[points.length - 1]!.ts - points[0]!.ts < 24 * 3600_000;
  const tickFormat = spansLessThanADay
    ? (v: number) => new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : (v: number) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="totalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={totalColor} stopOpacity={0.25} />
              <stop offset="95%" stopColor={totalColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1a2520" strokeOpacity={0.5} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={['auto', 'auto']}
            ticks={spansLessThanADay ? undefined : dayTicks}
            tickFormatter={tickFormat}
            tick={{ fontSize: 11, fill: '#7a8579' }}
            scale="time"
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#7a8579' }}
            domain={['auto', 'auto']}
            tickFormatter={(v) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`}
            width={70}
          />
          <Tooltip
            labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
            contentStyle={{
              background: '#0c1110',
              border: '1px solid #1a2520',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v: number, name: string) => [
              `${v >= 0 ? '+' : ''}$${v.toFixed(4)}`,
              name,
            ]}
          />
          {showLegs && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <ReferenceLine y={0} stroke="#28342e" strokeDasharray="2 2" />
          <Area
            type="stepAfter"
            dataKey="total"
            name="Combined"
            stroke={totalColor}
            strokeWidth={2}
            fill="url(#totalFill)"
          />
          {showLegs && (
            <Line type="stepAfter" dataKey="poly" name="Polymarket" stroke="#5af9fb" strokeWidth={1.5} dot={false} />
          )}
          {showLegs && (
            <Line type="stepAfter" dataKey="hl" name="Hyperliquid hedge" stroke="#f59e0b" strokeWidth={1.5} dot={false} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
