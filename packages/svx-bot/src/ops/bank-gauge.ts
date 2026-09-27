/**
 * Bank gauge: are we ahead of or behind what the switched-on strategies
 * should have made, and does the account agree with the ledger?
 *
 * Three numbers since live trading began:
 *
 *   Ledger    Σ (payout − cost) over settled live trades — what we booked.
 *   Expected  Σ contracts × the strategy's profit per contract at entry —
 *             what the switchboard scores said those same trades were worth.
 *   Bank      the account balance moved against the ledger since a baseline
 *             snapshot (drift ≈ 0 means the ledger is telling the truth).
 *
 * Ledger − Expected is luck. Each $1 contract is a coin that pays 1 with
 * probability p (≈ cost + expected edge), so its outcome has variance
 * p(1−p) per contract²; summing over trades gives a σ for "normal swing".
 * A drop from +$110 to +$20 inside ±2σ of Expected is a bad run, not a
 * broken strategy.
 */

import type { LedgerStore } from '../ledger/store.js';
import type { TradeRecord } from 'svx-shared/types';
import { HARVEST_KEY, strategyTagFor, type SwitchEntry } from '../strategy/switchboard.js';

export const PREDICT_BASELINE_KEY = 'predict_reconcile_baseline';

interface Baseline {
  balanceUsdc: number;
  offsetUsdc: number;
  atMs: number;
}

export interface BankGauge {
  liveStartMs: number | null;
  ledger: { pnlUsdc: number; settled: number; wins: number; open: number; openCostUsdc: number };
  expected: {
    /** Σ expected PnL over settled trades we could score. */
    pnlUsdc: number;
    /** Ledger PnL of the same scored trades (unscored ones excluded). */
    actualUsdc: number;
    /** actualUsdc − pnlUsdc: positive = running hot. */
    luckUsdc: number;
    /** One standard deviation of normal swing around pnlUsdc. */
    sigmaUsdc: number;
    /** luck in σ; null until there is any variance. */
    z: number | null;
    trades: number;
  };
  /** Live trades with no switchboard score (other strategies). */
  unscored: { trades: number; pnlUsdc: number };
  byStrategy: Array<{ key: string; trades: number; actualUsdc: number; expectedUsdc: number }>;
  /** Cumulative Ledger vs Expected, one point per settled scored trade. */
  series: Array<{ atMs: number; actual: number; expected: number; sigma: number }>;
  bank: {
    balanceUsdc: number | null;
    /** Balance change since the baseline snapshot. */
    sinceBaselineUsdc: number | null;
    /** Balance move the ledger does not explain; ≈0 when truthful. */
    driftUsdc: number | null;
    baselineAtMs: number | null;
  };
}

/** Switchboard key a live trade was placed under, if any. */
function switchKey(t: TradeRecord): string | null {
  if (t.strategy === 'calibration_harvest') return t.signalId === 'harvest_v2' ? HARVEST_KEY : null;
  if (!['fade_spike', 'auto_shadow', 'edge_jump', 'edge_vol'].includes(t.strategy ?? '')) return null;
  const signal = t.signalId.split('@')[0] ?? '';
  return t.signalId.includes('@') && strategyTagFor(signal) === t.strategy ? t.signalId : null;
}

/**
 * Where the account balance should sit relative to its starting point if the
 * ledger is right: booked PnL, minus cash still out in open positions, minus
 * winnings booked but not yet claimed into the account.
 */
export function predictLedgerOffsetUsdc(trades: TradeRecord[]): number {
  let offset = 0;
  for (const t of trades) {
    if (!t.settled) {
      offset -= t.costUsdc;
      continue;
    }
    offset += t.pnlUsdc ?? (t.payoutUsdc ?? 0) - t.costUsdc;
    const unclaimed = t.redeemTxDigest == null || t.redeemTxDigest === 'auto_delivered_v2';
    if ((t.payoutUsdc ?? 0) > 0 && unclaimed) offset -= t.payoutUsdc ?? 0;
  }
  return offset;
}

export function bankGauge(
  ledger: LedgerStore,
  board: SwitchEntry[],
  balanceUsdc: number | null,
  nowMs = Date.now(),
): BankGauge {
  const liveStartMs = ledger.firstLivePredictTradeMs();
  const allLive = ledger.livePredictTradesSince(0);
  const sinceStart = liveStartMs == null ? [] : allLive.filter((t) => t.timestampMs >= liveStartMs);
  const edgeByKey = new Map(board.map((e) => [e.key, e.pnlPerContract]));

  const settled = sinceStart
    .filter((t) => t.settled)
    .sort((a, b) => (a.settledAtMs ?? a.timestampMs) - (b.settledAtMs ?? b.timestampMs));
  const open = sinceStart.filter((t) => !t.settled);
  const pnlOf = (t: TradeRecord) => t.pnlUsdc ?? (t.payoutUsdc ?? 0) - t.costUsdc;

  let actual = 0;
  let expected = 0;
  let variance = 0;
  let scored = 0;
  const unscored = { trades: 0, pnlUsdc: 0 };
  const byKey = new Map<string, { trades: number; actualUsdc: number; expectedUsdc: number }>();
  const series: BankGauge['series'] = [];
  for (const t of settled) {
    const key = switchKey(t);
    const edge = t.edgeAtExec ?? (key ? edgeByKey.get(key) : undefined);
    if (!key || edge == null || !(t.quantityDusdc > 0)) {
      unscored.trades++;
      unscored.pnlUsdc += pnlOf(t);
      continue;
    }
    const q = t.quantityDusdc;
    const p = Math.min(0.999, Math.max(0.001, t.costUsdc / q + edge));
    scored++;
    actual += pnlOf(t);
    expected += q * edge;
    variance += q * q * p * (1 - p);
    const row = byKey.get(key) ?? { trades: 0, actualUsdc: 0, expectedUsdc: 0 };
    row.trades++;
    row.actualUsdc += pnlOf(t);
    row.expectedUsdc += q * edge;
    byKey.set(key, row);
    series.push({
      atMs: t.settledAtMs ?? t.timestampMs,
      actual: round(actual),
      expected: round(expected),
      sigma: round(Math.sqrt(variance)),
    });
  }
  const sigma = Math.sqrt(variance);

  // Account-vs-ledger drift, against a snapshot taken the first time both
  // are known. `svx rebaseline` clears it after a deposit or withdrawal.
  const offset = predictLedgerOffsetUsdc(allLive);
  let baseline: Baseline | null = null;
  try {
    const raw = ledger.getMeta(PREDICT_BASELINE_KEY);
    baseline = raw ? (JSON.parse(raw) as Baseline) : null;
  } catch {
    baseline = null;
  }
  if (!baseline && balanceUsdc != null && balanceUsdc > 0) {
    baseline = { balanceUsdc, offsetUsdc: offset, atMs: nowMs };
    ledger.setMeta(PREDICT_BASELINE_KEY, JSON.stringify(baseline));
  }
  const sinceBaseline = baseline && balanceUsdc != null ? balanceUsdc - baseline.balanceUsdc : null;

  return {
    liveStartMs,
    ledger: {
      pnlUsdc: round(settled.reduce((a, t) => a + pnlOf(t), 0)),
      settled: settled.length,
      wins: settled.filter((t) => (t.payoutUsdc ?? 0) > 0).length,
      open: open.length,
      openCostUsdc: round(open.reduce((a, t) => a + t.costUsdc, 0)),
    },
    expected: {
      pnlUsdc: round(expected),
      actualUsdc: round(actual),
      luckUsdc: round(actual - expected),
      sigmaUsdc: round(sigma),
      z: sigma > 0 ? Number(((actual - expected) / sigma).toFixed(2)) : null,
      trades: scored,
    },
    unscored: { trades: unscored.trades, pnlUsdc: round(unscored.pnlUsdc) },
    byStrategy: [...byKey.entries()]
      .map(([key, r]) => ({
        key,
        trades: r.trades,
        actualUsdc: round(r.actualUsdc),
        expectedUsdc: round(r.expectedUsdc),
      }))
      .sort((a, b) => b.trades - a.trades),
    series,
    bank: {
      balanceUsdc: balanceUsdc == null ? null : round(balanceUsdc),
      sinceBaselineUsdc: sinceBaseline == null ? null : round(sinceBaseline),
      driftUsdc:
        baseline && sinceBaseline != null ? round(sinceBaseline - (offset - baseline.offsetUsdc)) : null,
      baselineAtMs: baseline?.atMs ?? null,
    },
  };
}

const round = (x: number) => Math.round(x * 100) / 100;
