/**
 * PLP + tail-hedge simulation — idea bank #2 ("PLP yield minus crash
 * insurance"), priced with real data from both sides:
 *
 *   - PLP yield: the REALIZED share-price series implied by on-chain
 *     supply/withdraw events (share price = amount/shares at each event).
 *   - Insurance cost: the price of a deep-OTM DOWN binary at
 *     F·(1 − z·σ_atm·√T), evaluated on every recorded surface snapshot,
 *     settled against what actually happened (payouts offset premiums).
 *
 * The honest headline this produces on today's testnet: PLP appreciation is
 * ~flat — the vault is the COUNTERPARTY to the calibration edge our other
 * strategies harvest — so "PLP yield minus insurance" nets negative until
 * the surface recalibrates or fees accrue to the vault. That is protocol
 * feedback with numbers, not a failed product: the same finding, seen from
 * the house's side of the table.
 */

import type { SVIParams } from 'svx-shared/types';
import { upAtStrike } from '../strategy/range-ladder.js';

export interface LpEvent {
  tsMs: number;
  amount: number;
  shares: number;
}

export interface PlpSimOracleRow {
  oracleId: string;
  tsMs: number;
  expiryMs: number;
  forward: number;
  svi: SVIParams;
  settlementPrice: number;
}

export interface PlpSimArgs {
  /** Crash strike distance in ATM sigmas (insure below F·(1 − z·σ√T)). */
  hedgeZ: number;
  /** Insurance notional as a fraction of PLP capital. */
  coverageFrac: number;
  /** Cost markup approximating the protocol fee on the hedge leg. */
  fee: number;
}

export interface PlpSimSummary {
  plp: {
    events: number;
    window_days: number | null;
    share_price_first: number | null;
    share_price_last: number | null;
    realized_apy: number | null;
  };
  hedge: {
    z: number;
    coverage_frac: number;
    fee: number;
    oracles_priced: number;
    avg_premium_frac: number | null;
    crash_hits: number;
    crash_hit_rate: number | null;
    avg_cycle_hours: number | null;
    /** (premium·(1+fee) − realized payout rate) annualized, per $1 capital. */
    annualized_drag_frac: number | null;
  };
  net_apy: number | null;
  data_window: { firstTsIso: string | null; lastTsIso: string | null };
}

export function computePlpSim(
  supplies: LpEvent[],
  withdrawals: LpEvent[],
  oracles: PlpSimOracleRow[],
  args: PlpSimArgs,
): PlpSimSummary {
  // ── Realized PLP share-price series ──
  const pricePts = [...supplies, ...withdrawals]
    .filter((e) => e.shares > 0 && e.amount > 0)
    .map((e) => ({ tsMs: e.tsMs, price: e.amount / e.shares }))
    .sort((a, b) => a.tsMs - b.tsMs);

  let realizedApy: number | null = null;
  let windowDays: number | null = null;
  const first = pricePts[0];
  const last = pricePts[pricePts.length - 1];
  if (first && last && last.tsMs > first.tsMs) {
    const years = (last.tsMs - first.tsMs) / (365.25 * 24 * 3600 * 1000);
    windowDays = round((last.tsMs - first.tsMs) / (24 * 3600 * 1000), 2);
    realizedApy = round((last.price / first.price - 1) / years, 4);
  }

  // ── Crash-insurance leg, priced per oracle cycle off the real surface ──
  let priced = 0;
  let premiumSum = 0;
  let hits = 0;
  let cycleMsSum = 0;
  for (const r of oracles) {
    const tYears = (r.expiryMs - r.tsMs) / (365.25 * 24 * 3600 * 1000);
    if (!(tYears > 0) || !(r.forward > 0)) continue;
    const w0 = wAtm(r.svi);
    if (!(w0 > 0)) continue;
    const sigmaAtm = Math.sqrt(w0 / tYears);
    const crashStrike = r.forward * (1 - args.hedgeZ * sigmaAtm * Math.sqrt(tYears));
    if (crashStrike <= 0) continue;
    // DOWN binary at the crash strike = 1 − P_up(K).
    const premium = 1 - upAtStrike(crashStrike, r.forward, r.svi);
    priced++;
    premiumSum += premium;
    cycleMsSum += r.expiryMs - r.tsMs;
    if (r.settlementPrice <= crashStrike) hits++;
  }

  let annualizedDrag: number | null = null;
  let avgPremium: number | null = null;
  let avgCycleHours: number | null = null;
  if (priced > 0 && cycleMsSum > 0) {
    avgPremium = premiumSum / priced;
    const avgCycleMs = cycleMsSum / priced;
    avgCycleHours = round(avgCycleMs / 3600_000, 2);
    const cyclesPerYear = (365.25 * 24 * 3600 * 1000) / avgCycleMs;
    const netCostPerCycle = avgPremium * (1 + args.fee) - hits / priced;
    annualizedDrag = round(args.coverageFrac * netCostPerCycle * cyclesPerYear, 4);
  }

  return {
    plp: {
      events: pricePts.length,
      window_days: windowDays,
      share_price_first: first ? round(first.price, 6) : null,
      share_price_last: last ? round(last.price, 6) : null,
      realized_apy: realizedApy,
    },
    hedge: {
      z: args.hedgeZ,
      coverage_frac: args.coverageFrac,
      fee: args.fee,
      oracles_priced: priced,
      avg_premium_frac: avgPremium != null ? round(avgPremium, 4) : null,
      crash_hits: hits,
      crash_hit_rate: priced ? round(hits / priced, 4) : null,
      avg_cycle_hours: avgCycleHours,
      annualized_drag_frac: annualizedDrag,
    },
    net_apy:
      realizedApy != null && annualizedDrag != null ? round(realizedApy - annualizedDrag, 4) : null,
    data_window: {
      firstTsIso: first ? new Date(first.tsMs).toISOString() : null,
      lastTsIso: last ? new Date(last.tsMs).toISOString() : null,
    },
  };
}

function wAtm(svi: SVIParams): number {
  // Total variance at k=0: a + b(ρ(−m) + √(m² + σ²)).
  return svi.a + svi.b * (svi.rho * (0 - svi.m) + Math.sqrt(svi.m * svi.m + svi.sigma * svi.sigma));
}

function round(x: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(x * m) / m;
}
