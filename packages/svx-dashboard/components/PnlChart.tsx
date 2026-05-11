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
  const sorted = closed.slice().sort((a, b) => a.timestampMs - b.timestampMs);
  const points: PnlPoint[] = [];
  let cumTotal = 0;
  let cumPoly = 0;
  let cumHl = 0;
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
      ts: t.polySettledAtMs ?? t.timestampMs,
      total: cumTotal,
      poly: showLegs ? cumPoly : undefined,
      hl: showLegs ? cumHl : undefined,
    });
  }

  if (points.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted text-sm">
        No settled trades yet — chart populates after the first settlement.
      </div>
    );
  }

  const totalColor = cumTotal >= 0 ? '#10b981' : '#ef4444';

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
          <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={['auto', 'auto']}
            tickFormatter={(v) =>
              new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            }
            tick={{ fontSize: 11, fill: '#8c93a3' }}
            scale="time"
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#8c93a3' }}
            domain={['auto', 'auto']}
            tickFormatter={(v) => `${v >= 0 ? '+' : ''}$${v.toFixed(2)}`}
            width={70}
          />
          <Tooltip
            labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
            contentStyle={{
              background: '#11141b',
              border: '1px solid #1c2230',
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v: number, name: string) => [
              `${v >= 0 ? '+' : ''}$${v.toFixed(4)}`,
              name,
            ]}
          />
          {showLegs && <Legend wrapperStyle={{ fontSize: 12 }} />}
          <ReferenceLine y={0} stroke="#2a3142" strokeDasharray="2 2" />
          <Area
            type="monotone"
            dataKey="total"
            name="Combined"
            stroke={totalColor}
            strokeWidth={2}
            fill="url(#totalFill)"
          />
          {showLegs && (
            <Line type="monotone" dataKey="poly" name="Polymarket" stroke="#7dd3fc" strokeWidth={1.5} dot={false} />
          )}
          {showLegs && (
            <Line type="monotone" dataKey="hl" name="Hyperliquid hedge" stroke="#f59e0b" strokeWidth={1.5} dot={false} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
