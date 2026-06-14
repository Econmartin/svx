'use client';

/**
 * Probability-calibration plot — proves Predict's SVI surface is honest.
 *
 * Method: for each closed trade we know two things —
 *   1. What probability Predict assigned to the winning outcome at execution
 *      (the "predicted win probability"). For an UP-side bet, this is just
 *      `predictProbAtExec`; for a DOWN-side bet it's `1 − predictProbAtExec`.
 *   2. Whether the trade actually won (polyPnlUsdc > 0 on mainnet, pnlUsdc > 0
 *      on testnet).
 *
 * Bin trades by predicted win probability (5pp buckets), compute the *actual*
 * hit rate in each bucket, and plot vs the y = x diagonal.
 *
 *   - Points on / near y = x  → Predict's surface is well-calibrated.
 *                                When it says "70% chance," ~70% win.
 *   - Points below the line   → Predict over-confident (its 70%-confidence
 *                                trades actually win less than 70% of the time).
 *   - Points above the line   → Predict under-confident, leaving edge on table.
 *
 * The spec called out vol-arb as "a live stress test of the SVI feeder."
 * This chart is the stress-test result, made visible.
 *
 * Dot size scales with sample count in the bucket so judges can see at a
 * glance which buckets are statistically meaningful.
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
  ZAxis,
} from 'recharts';
import type { TradeRecord } from '@/lib/api';

interface Props {
  closed: TradeRecord[];
  isMainnet: boolean;
}

interface Bucket {
  /** Midpoint of the predicted-probability bucket (e.g. 0.625 for [60%, 65%)). */
  predicted: number;
  /** Actual hit rate observed in this bucket. */
  actual: number;
  /** Trade count in this bucket. */
  n: number;
  /** Wins in this bucket. */
  wins: number;
}

const BUCKET_WIDTH = 0.05;
const MIN_TRADES_PER_BUCKET = 2;

export function CalibrationChart({ closed, isMainnet }: Props) {
  const buckets = useMemo<Bucket[]>(() => {
    const map = new Map<number, { n: number; wins: number }>();
    for (const t of closed) {
      const ppa = t.predictProbAtExec;
      if (ppa == null) continue;
      // Convert "probability of UP" into "probability that THIS trade's
      // chosen side wins."
      const pWin = t.direction === 'up' ? ppa : 1 - ppa;
      if (!Number.isFinite(pWin) || pWin <= 0 || pWin >= 1) continue;
      // Win determination depends on which leg we're following. On mainnet
      // the trade winner is the Polymarket leg's outcome; on testnet it's
      // the Predict-side Sui mint.
      const pnl = isMainnet ? t.polyPnlUsdc : t.pnlUsdc;
      if (pnl == null) continue;
      const won = pnl > 0;
      const bucketIdx = Math.floor(pWin / BUCKET_WIDTH);
      const prev = map.get(bucketIdx) ?? { n: 0, wins: 0 };
      prev.n += 1;
      if (won) prev.wins += 1;
      map.set(bucketIdx, prev);
    }
    const out: Bucket[] = [];
    for (const [bucketIdx, { n, wins }] of map.entries()) {
      if (n < MIN_TRADES_PER_BUCKET) continue;
      out.push({
        predicted: bucketIdx * BUCKET_WIDTH + BUCKET_WIDTH / 2,
        actual: wins / n,
        n,
        wins,
      });
    }
    return out.sort((a, b) => a.predicted - b.predicted);
  }, [closed, isMainnet]);

  if (buckets.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted text-sm text-center px-6">
        Not enough closed trades per probability bucket yet. Need ≥
        {MIN_TRADES_PER_BUCKET} trades per 5pp bucket; chart populates as the
        sample grows.
      </div>
    );
  }

  // Build a 2-point series for the y = x reference (perfect calibration).
  const diagonal = [
    { predicted: 0, ideal: 0 },
    { predicted: 1, ideal: 1 },
  ];

  const totalTrades = buckets.reduce((s, b) => s + b.n, 0);

  return (
    <div className="space-y-2">
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 5, right: 16, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a2520" />
            <XAxis
              type="number"
              dataKey="predicted"
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              tick={{ fontSize: 11, fill: '#7a8579' }}
              label={{
                value: 'Predicted win probability',
                position: 'bottom',
                offset: 5,
                fill: '#7a8579',
                fontSize: 11,
              }}
            />
            <YAxis
              type="number"
              dataKey="actual"
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              tick={{ fontSize: 11, fill: '#7a8579' }}
              width={50}
              label={{
                value: 'Actual hit rate',
                angle: -90,
                position: 'left',
                offset: -10,
                fill: '#7a8579',
                fontSize: 11,
              }}
            />
            <ZAxis type="number" dataKey="n" range={[60, 360]} />
            <Tooltip
              cursor={{ strokeDasharray: '3 3' }}
              contentStyle={{
                background: '#0c1110',
                border: '1px solid #1a2520',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(v: number, name: string) => {
                if (name === 'ideal') return [`${(v * 100).toFixed(0)}%`, 'ideal'];
                return [`${(v * 100).toFixed(1)}%`, name];
              }}
              labelFormatter={() => ''}
            />
            <ReferenceLine y={0} stroke="#28342e" />
            <ReferenceLine x={0} stroke="#28342e" />
            {/* y = x diagonal — perfect calibration. */}
            <Line
              data={diagonal}
              dataKey="ideal"
              type="linear"
              stroke="#fbbf24"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              isAnimationActive={false}
              name="perfect calibration"
              legendType="none"
            />
            <Scatter name="Observed" data={buckets}>
              {buckets.map((b, i) => {
                // Color by direction of miscalibration: close to diagonal
                // (within 5pp) = green; over-confident (below diagonal) =
                // red; under-confident (above diagonal) = blue.
                const miss = b.actual - b.predicted;
                const color =
                  Math.abs(miss) < 0.05 ? '#1eff8a' : miss < 0 ? '#ef4444' : '#5af9fb';
                return <Cell key={i} fill={color} fillOpacity={0.8} />;
              })}
            </Scatter>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="text-xs text-muted leading-relaxed px-2">
        <span className="font-mono text-fg/80">{buckets.length} buckets · {totalTrades} trades</span>
        {' — '}
        <span className="text-win">●</span> on-line (well-calibrated)
        {' · '}
        <span className="text-loss">●</span> below (Predict over-confident)
        {' · '}
        <span className="text-accent">●</span> above (Predict under-confident).
        Dot size scales with sample count per bucket.
      </div>
    </div>
  );
}
