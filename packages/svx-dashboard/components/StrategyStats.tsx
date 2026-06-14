'use client';

/**
 * Strategy-level statistics derived from the closed-trade list.
 *
 * Surfaces the metrics a judge or operator would actually use to size up
 * "is this strategy working?" — beyond the top-line "win rate + total PnL"
 * cards. Shows distribution shape, downside, throughput, and consistency.
 */

import { useMemo } from 'react';
import { StatRow } from '@/components/StatRow';
import { formatUsdc, formatPct, type TradeRecord } from '@/lib/api';

interface Props {
  closed: TradeRecord[];
  /** Mainnet view = combined poly + HL PnL per trade; testnet = Sui PnL. */
  isMainnet: boolean;
}

export function StrategyStats({ closed, isMainnet }: Props) {
  const stats = useMemo(() => {
    if (closed.length === 0) {
      return null;
    }

    const pnls: number[] = [];
    const sorted = closed.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    let volume = 0;
    for (const t of sorted) {
      const pnl = isMainnet ? (t.polyPnlUsdc ?? 0) + (t.hlPnlUsdc ?? 0) : t.pnlUsdc ?? 0;
      pnls.push(pnl);
      // Trade volume: poly cost is a reasonable proxy on mainnet, Sui cost on testnet.
      volume += isMainnet ? t.polyCostUsdc ?? 0 : t.costUsdc ?? 0;
    }

    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);
    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const grossWin = wins.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
    const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    // Profit factor: ratio of gross wins to gross losses. >1 = profitable
    // before costs; <1 = bleeding. "Industry-standard" threshold ≥ 1.5.
    const profitFactor =
      grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const bestTrade = pnls.reduce((m, p) => (p > m ? p : m), -Infinity);
    const worstTrade = pnls.reduce((m, p) => (p < m ? p : m), Infinity);
    const avgPnl = totalPnl / pnls.length;

    // Max drawdown — biggest peak-to-trough on the cumulative curve.
    let peak = 0;
    let maxDd = 0;
    let cum = 0;
    for (const p of pnls) {
      cum += p;
      if (cum > peak) peak = cum;
      const dd = cum - peak;
      if (dd < maxDd) maxDd = dd;
    }

    // Trades per day across the observed window.
    const spanMs = sorted[sorted.length - 1]!.timestampMs - sorted[0]!.timestampMs;
    const spanDays = Math.max(1 / 24, spanMs / (24 * 3600_000));
    const tradesPerDay = pnls.length / spanDays;

    return {
      total: pnls.length,
      winCount: wins.length,
      lossCount: losses.length,
      avgWin,
      avgLoss,
      profitFactor,
      bestTrade,
      worstTrade,
      avgPnl,
      maxDd,
      volume,
      tradesPerDay,
    };
  }, [closed, isMainnet]);

  if (!stats) {
    return null;
  }

  // Profit factor presentation: cap display at "10+" for visual stability.
  const pfDisplay =
    stats.profitFactor === Infinity
      ? '∞'
      : stats.profitFactor > 10
        ? '10+'
        : stats.profitFactor.toFixed(2);

  return (
    <StatRow
      cols={4}
      stats={[
        {
          label: 'Profit factor',
          value: pfDisplay,
          tone: stats.profitFactor >= 1 ? 'win' : stats.profitFactor > 0 ? 'loss' : 'default',
          hint: 'gross win / gross loss — over 1.0 = profitable before costs',
        },
        {
          label: 'Avg win / avg loss',
          value: `${formatUsdc(stats.avgWin)} / ${formatUsdc(stats.avgLoss)}`,
          hint: `${stats.winCount} wins · ${stats.lossCount} losses`,
        },
        {
          label: 'Best · worst trade',
          value: `${formatUsdc(stats.bestTrade)} · ${formatUsdc(stats.worstTrade)}`,
          hint: `single-trade PnL extremes`,
        },
        {
          label: 'Max drawdown',
          value: formatUsdc(stats.maxDd),
          tone: stats.maxDd < 0 ? 'loss' : 'default',
          hint: 'biggest peak-to-trough on cumulative PnL',
        },
        {
          label: 'Avg PnL / trade',
          value: formatUsdc(stats.avgPnl),
          tone: stats.avgPnl >= 0 ? 'win' : 'loss',
          hint: 'mean across all closed trades',
        },
        {
          label: 'Trades / day',
          value: stats.tradesPerDay.toFixed(1),
          hint: `${stats.total} closed in the visible window`,
        },
        {
          label: 'Volume traded',
          value: formatUsdc(stats.volume),
          hint: 'sum of trade costs (capital deployed)',
        },
        {
          label: 'Hit rate',
          value: formatPct(stats.winCount / stats.total, 0),
          tone: stats.winCount / stats.total >= 0.5 ? 'win' : 'default',
          hint: `${stats.winCount}/${stats.total}`,
        },
      ]}
    />
  );
}
