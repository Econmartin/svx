'use client';

/**
 * Math-validation scatter: for each closed trade, plots the entry-time
 * predicted edge (Predict probability − Polymarket implied probability) vs
 * the realized return on cost (PnL / cost).
 *
 * The intuition: if the bot's math is right, trades it identified as having
 * larger entry edge should on average produce higher realized returns. A
 * least-squares regression line lays bare whether that relationship exists.
 *
 *   - Positive slope → entry edge is predictive; the math captures real edge
 *   - Flat slope    → bot trades noise; edges identified don't translate
 *   - Negative slope → adverse selection; deeper edge actually loses money
 *
 * For hackathon judging this is THE chart: it shows in one glance whether
 * the strategy delivers what its signal claims.
 */

import { useMemo } from 'react';
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
  Line,
  ComposedChart,
} from 'recharts';
import type { TradeRecord } from '@/lib/api';

interface Props {
  closed: TradeRecord[];
  spreadThreshold?: number;
}

interface Point {
  edge: number;
  ret: number;
  win: boolean;
  strike: number;
  pnl: number;
}

export function EdgeCaptureChart({ closed, spreadThreshold = 0.03 }: Props) {
  const { points, fit } = useMemo(() => {
    const pts: Point[] = [];
    for (const t of closed) {
      const edge = t.edgeAtExec;
      const cost = t.polyCostUsdc;
      const pnl = t.polyPnlUsdc;
      if (edge == null || cost == null || cost <= 0 || pnl == null) continue;
      pts.push({
        edge,
        ret: pnl / cost,
        win: pnl > 0,
        strike: t.strike,
        pnl,
      });
    }

    if (pts.length < 2) {
      return { points: pts, fit: null as { slope: number; intercept: number; xMin: number; xMax: number } | null };
    }

    // Simple least-squares regression so we can draw the trend line.
    const n = pts.length;
    const sumX = pts.reduce((s, p) => s + p.edge, 0);
    const sumY = pts.reduce((s, p) => s + p.ret, 0);
    const sumXY = pts.reduce((s, p) => s + p.edge * p.ret, 0);
    const sumX2 = pts.reduce((s, p) => s + p.edge * p.edge, 0);
    const denom = n * sumX2 - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    const xMin = Math.min(...pts.map((p) => p.edge));
    const xMax = Math.max(...pts.map((p) => p.edge));
    return { points: pts, fit: { slope, intercept, xMin, xMax } };
  }, [closed]);

  if (points.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted text-sm">
        Need closed trades with entry-edge data to plot. Populates once mainnet
        starts settling fills.
      </div>
    );
  }

  // Build a tiny "fit line" series so recharts draws the regression atop
  // the scatter. Two points are enough since Line interpolates linearly.
  const fitData = fit
    ? [
        { edge: fit.xMin, fit: fit.slope * fit.xMin + fit.intercept },
        { edge: fit.xMax, fit: fit.slope * fit.xMax + fit.intercept },
      ]
    : [];

  return (
    <div className="space-y-2">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 5, right: 16, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
            <XAxis
              type="number"
              dataKey="edge"
              name="Entry edge"
              tickFormatter={(v) => `${(v * 100).toFixed(0)}pp`}
              tick={{ fontSize: 11, fill: '#8c93a3' }}
              label={{
                value: 'Entry edge (Predict − Polymarket, pp)',
                position: 'bottom',
                offset: 5,
                fill: '#8c93a3',
                fontSize: 11,
              }}
              domain={['auto', 'auto']}
            />
            <YAxis
              type="number"
              dataKey="ret"
              name="Realized return"
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              tick={{ fontSize: 11, fill: '#8c93a3' }}
              width={60}
              domain={['auto', 'auto']}
            />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              contentStyle={{
                background: '#11141b',
                border: '1px solid #1c2230',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(v: number, name: string) => {
                if (name === 'fit') return [`${(v * 100).toFixed(1)}%`, 'fit'];
                if (name === 'Realized return') return [`${(v * 100).toFixed(1)}%`, 'return'];
                if (name === 'Entry edge') return [`${(v * 100).toFixed(2)}pp`, 'edge'];
                return [v, name];
              }}
              labelFormatter={() => ''}
            />
            <ReferenceLine y={0} stroke="#2a3142" strokeDasharray="2 2" />
            <ReferenceLine
              x={spreadThreshold}
              stroke="#7dd3fc"
              strokeDasharray="2 2"
              strokeOpacity={0.5}
              label={{ value: 'open thresh', fill: '#7dd3fc', fontSize: 10, position: 'top' }}
            />
            <Scatter name="Trades" data={points}>
              {points.map((p, i) => (
                <Cell key={i} fill={p.win ? '#10b981' : '#ef4444'} fillOpacity={0.7} />
              ))}
            </Scatter>
            {fitData.length === 2 && (
              <Line
                data={fitData}
                dataKey="fit"
                type="linear"
                stroke="#fbbf24"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                name="best-fit"
                legendType="none"
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {fit && (
        <div className="text-xs text-muted leading-relaxed px-2">
          <span className="font-mono text-fg/80">
            slope {fit.slope >= 0 ? '+' : ''}
            {fit.slope.toFixed(2)}
          </span>{' '}
          — for every <span className="font-mono">1pp</span> of additional entry edge
          identified, realized return on cost moves{' '}
          <span className="font-mono">
            {fit.slope >= 0 ? '+' : ''}
            {(fit.slope * 0.01 * 100).toFixed(2)}%
          </span>
          . Positive slope = the bot captures the edge it identifies.{' '}
          <span className="text-muted/70">
            (
            <span className="text-win">●</span> win ·{' '}
            <span className="text-loss">●</span> loss · golden line = least-squares fit)
          </span>
        </div>
      )}
    </div>
  );
}
