/**
 * Range-ladder vault SIMULATION — the "proper simulation result" the track
 * brief requires for vault strategies, replayed from recorded data: for
 * every oracle where the ledger holds both an SVI surface snapshot and the
 * eventual settlement price, build the ladder the vault WOULD have minted
 * at first sight of the oracle, price each rung off that surface (+fee),
 * and settle it against what actually happened.
 *
 * Serves both the CLI and GET /range-sim so the numbers are reproducible
 * against the deployed bot's own ledger — same pattern as ops/backtest.ts.
 */

import type { SVIParams } from 'svx-shared/types';
import { buildLadder, rangePays, type LadderCfg, type LadderPolicy } from '../strategy/range-ladder.js';

export interface RangeSimRow {
  oracleId: string;
  /** Snapshot time (the vault's decision time). */
  tsMs: number;
  expiryMs: number;
  forward: number;
  svi: SVIParams;
  settlementPrice: number;
}

export interface RangeSimArgs {
  policy: LadderPolicy;
  rungs: number;
  widthZ: number;
  widthBps: number;
  /** Cost markup approximating the protocol fee. */
  fee: number;
  /** dUSDC notional (max payout) per rung. */
  notionalPerRung: number;
  minRungPrice: number;
  maxRungPrice: number;
}

export interface RungBucket {
  offset: number;
  n: number;
  hits: number;
  hit_rate: number | null;
  avg_fair_price: number | null;
  cost_usdc: number;
  payout_usdc: number;
  pnl_usdc: number;
  roi: number | null;
}

export interface RangeSimSummary {
  policy: LadderPolicy;
  rungs: number;
  width: { z: number | null; bps: number | null };
  fee: number;
  notional_per_rung: number;
  oracles_simulated: number;
  rungs_minted: number;
  total_cost_usdc: number;
  total_payout_usdc: number;
  total_pnl_usdc: number;
  roi: number | null;
  ladder_hit_rate: number | null;
  by_offset: RungBucket[];
  data_window: { firstTsIso: string | null; lastTsIso: string | null };
}

export function computeRangeSim(rows: RangeSimRow[], args: RangeSimArgs): RangeSimSummary {
  const cfg: LadderCfg = {
    policy: args.policy,
    rungs: args.rungs,
    widthZ: args.widthZ,
    widthBps: args.widthBps,
    minRungPrice: args.minRungPrice,
    maxRungPrice: args.maxRungPrice,
  };

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let oracles = 0;
  let minted = 0;
  let cost = 0;
  let payout = 0;
  const buckets = new Map<number, { n: number; hits: number; fairSum: number; cost: number; payout: number }>();

  for (const r of rows) {
    if (firstTs === null || r.tsMs < firstTs) firstTs = r.tsMs;
    if (lastTs === null || r.tsMs > lastTs) lastTs = r.tsMs;
    const tYears = (r.expiryMs - r.tsMs) / (365.25 * 24 * 3600 * 1000);
    if (!(tYears > 0)) continue;

    const ladder = buildLadder({ forward: r.forward, svi: r.svi, tYears, cfg });
    if (ladder.length === 0) continue;
    oracles++;

    for (const rung of ladder) {
      minted++;
      const rungCost = rung.fairPrice * (1 + args.fee) * args.notionalPerRung;
      const rungPayout = rangePays(rung, r.settlementPrice) ? args.notionalPerRung : 0;
      cost += rungCost;
      payout += rungPayout;
      const b = buckets.get(rung.offset) ?? { n: 0, hits: 0, fairSum: 0, cost: 0, payout: 0 };
      b.n++;
      if (rungPayout > 0) b.hits++;
      b.fairSum += rung.fairPrice;
      b.cost += rungCost;
      b.payout += rungPayout;
      buckets.set(rung.offset, b);
    }
  }

  const byOffset: RungBucket[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset, b]) => ({
      offset,
      n: b.n,
      hits: b.hits,
      hit_rate: b.n ? round(b.hits / b.n, 4) : null,
      avg_fair_price: b.n ? round(b.fairSum / b.n, 4) : null,
      cost_usdc: round(b.cost, 4),
      payout_usdc: round(b.payout, 4),
      pnl_usdc: round(b.payout - b.cost, 4),
      roi: b.cost > 0 ? round((b.payout - b.cost) / b.cost, 4) : null,
    }));

  const hits = byOffset.reduce((a, b) => a + b.hits, 0);
  return {
    policy: args.policy,
    rungs: args.rungs,
    width: {
      z: args.policy === 'sigma' ? args.widthZ : null,
      bps: args.policy === 'fixed_bps' ? args.widthBps : null,
    },
    fee: args.fee,
    notional_per_rung: args.notionalPerRung,
    oracles_simulated: oracles,
    rungs_minted: minted,
    total_cost_usdc: round(cost, 4),
    total_payout_usdc: round(payout, 4),
    total_pnl_usdc: round(payout - cost, 4),
    roi: cost > 0 ? round((payout - cost) / cost, 4) : null,
    ladder_hit_rate: minted > 0 ? round(hits / minted, 4) : null,
    by_offset: byOffset,
    data_window: {
      firstTsIso: firstTs != null ? new Date(firstTs).toISOString() : null,
      lastTsIso: lastTs != null ? new Date(lastTs).toISOString() : null,
    },
  };
}

function round(x: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(x * m) / m;
}
