/**
 * Cross-venue pair recorder: Predict 5-minute BTC windows vs Polymarket's
 * "Bitcoin Up or Down" 5-minute windows — the same question on two venues.
 *
 * On 2026-09-25 one window was quoted 19¢ Up on Predict and 34¢ Up on
 * Polymarket, so Predict-Up + Polymarket-Down cost 94.1¢ all-in for a pair
 * where one leg must pay $1 — IF both venues settle the same way. They use
 * different rules:
 *
 *   Predict     Up iff Pyth spot at expiry  >  reference (previous window's
 *               settlement observation)
 *   Polymarket  Up iff Chainlink 60s TWAP at the end  >=  price at the start
 *
 * So a pair can lose BOTH legs when the rules disagree. This recorder prices
 * both venues at the same instant (Predict all-in cost from the market's fee
 * policy; Polymarket best ask + depth + its published taker fee
 * rate·p·(1−p)^exponent), resolves both outcomes, and GET /cross-venue
 * reports how often the pair costs < $1 after fees and what it realized
 * once disagreements are counted. Nothing trades.
 */

import axios from 'axios';
import type { CrossVenuePairRow, LedgerStore } from '../ledger/store.js';
import { boardPrice, estimateMintCost, listSdkMarkets } from '../pricing/predict-sdk.js';
import { PredictV2Client, type PredictReader } from '../pricing/predict-v2.js';
import { makeSuiClient, suiNetwork } from '../exec/sui-client.js';
import { log } from '../util/log.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const WINDOW_MS = 5 * 60_000;

/** Decision points (time to expiry). The window opens 300s before expiry. */
const SLOTS = [
  { slot: 't4m', minMs: 220_000, maxMs: 260_000 },
  { slot: 't2m', minMs: 100_000, maxMs: 140_000 },
  { slot: 't50s', minMs: 40_000, maxMs: 60_000 },
];

interface PmWindow {
  conditionId: string;
  endMs: number;
  upToken: string;
  downToken: string;
  feeRate: number | null;
  feeExponent: number | null;
}

let pmCache: { atMs: number; data: PmWindow[] } | null = null;

/** Minutes past midnight for "10:45AM" style labels. */
function clockMinutes(label: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(AM|PM)$/.exec(label);
  if (!m) return null;
  const h = (Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0);
  return h * 60 + Number(m[2]);
}

/** Open Polymarket BTC Up/Down windows that span exactly five minutes. */
export async function listPmFiveMinuteWindows(nowMs = Date.now()): Promise<PmWindow[]> {
  if (pmCache && nowMs - pmCache.atMs < 20_000) return pmCache.data;
  const { data } = await axios.get<Array<Record<string, unknown>>>(`${GAMMA}/markets`, {
    params: {
      closed: false,
      active: true,
      limit: 200,
      order: 'endDate',
      ascending: true,
      end_date_min: new Date(nowMs).toISOString(),
    },
    timeout: 8_000,
  });
  const out: PmWindow[] = [];
  for (const m of data ?? []) {
    const q = String(m.question ?? '');
    const range = /^Bitcoin Up or Down - .*?(\d{1,2}:\d{2}(?:AM|PM))-(\d{1,2}:\d{2}(?:AM|PM)) ET$/.exec(q);
    if (!range) continue;
    const a = clockMinutes(range[1]!);
    const b = clockMinutes(range[2]!);
    if (a == null || b == null || (b - a + 1440) % 1440 !== 5) continue;
    let tokens: string[] = [];
    let outcomes: string[] = [];
    try {
      tokens = JSON.parse(String(m.clobTokenIds ?? '[]'));
      outcomes = JSON.parse(String(m.outcomes ?? '[]'));
    } catch {
      continue;
    }
    const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up');
    const downIdx = outcomes.findIndex((o) => o.toLowerCase() === 'down');
    if (upIdx < 0 || downIdx < 0 || !tokens[upIdx] || !tokens[downIdx]) continue;
    const fs = m.feeSchedule as { rate?: number; exponent?: number } | undefined;
    out.push({
      conditionId: String(m.conditionId),
      endMs: Date.parse(String(m.endDate)),
      upToken: tokens[upIdx]!,
      downToken: tokens[downIdx]!,
      feeRate: m.feesEnabled === false ? 0 : (fs?.rate ?? null),
      feeExponent: fs?.exponent ?? null,
    });
  }
  pmCache = { atMs: nowMs, data: out };
  return out;
}

async function bestAsk(tokenId: string): Promise<{ price: number; size: number } | null> {
  try {
    const { data } = await axios.get<{ asks?: Array<{ price: string; size: string }> }>(
      `${CLOB}/book`,
      { params: { token_id: tokenId }, timeout: 5_000 },
    );
    const asks = (data.asks ?? []).map((x) => ({ price: Number(x.price), size: Number(x.size) }));
    if (!asks.length) return null;
    const price = Math.min(...asks.map((x) => x.price));
    const size = asks.filter((x) => x.price === price).reduce((s, x) => s + x.size, 0);
    return { price, size };
  } catch {
    return null;
  }
}

/** A Predict market is the 5-minute window iff its reference was observed
 *  exactly one window before expiry (a 1-minute market expiring at the same
 *  instant anchors 60s earlier — a different bet). */
async function isFiveMinuteWindow(marketId: string, expiryMs: number): Promise<boolean> {
  try {
    const res = await makeSuiClient().getObject({ objectId: marketId, include: { json: true } });
    const se = (res.object?.json as { strike_exposure?: Record<string, unknown> } | undefined)
      ?.strike_exposure;
    const src = Number(se?.reference_tick_source_timestamp_ms);
    return Number.isFinite(src) && expiryMs - src === WINDOW_MS;
  } catch {
    return false;
  }
}

const fiveMinCache = new Map<string, boolean>();

export async function recordCrossVenuePairs(deps: {
  predict: PredictReader;
  ledger: LedgerStore;
  nowMs?: number;
  /** Spot reference for the row (Binance mid when available). */
  spotMid?: number | null;
}): Promise<number> {
  const { predict, ledger } = deps;
  const now = deps.nowMs ?? Date.now();
  const markets = await listSdkMarkets();
  const due = markets.filter((m) =>
    m.referencePrice != null &&
    SLOTS.some(
      (s) =>
        m.expiryMs - now >= s.minMs &&
        m.expiryMs - now <= s.maxMs &&
        !ledger.hasCrossVenuePair(m.id, s.slot),
    ),
  );
  if (!due.length) return 0;
  const pm = await listPmFiveMinuteWindows(now).catch(() => [] as PmWindow[]);
  let recorded = 0;
  for (const m of due) {
    const w = pm.find((x) => x.endMs === m.expiryMs);
    if (!w) continue;
    if (!fiveMinCache.has(m.id)) fiveMinCache.set(m.id, await isFiveMinuteWindow(m.id, m.expiryMs));
    if (!fiveMinCache.get(m.id)) continue;
    const ttm = m.expiryMs - now;
    const slot = SLOTS.find((s) => ttm >= s.minMs && ttm <= s.maxMs)!.slot;
    const snap = await predict.snapshotOracle(m.id).catch(() => null);
    if (!snap || snap.isSettled) continue;
    const [board, askUp, askDown] = await Promise.all([
      boardPrice(snap.underlyingAsset, m.expiryMs, 'reference'),
      bestAsk(w.upToken),
      bestAsk(w.downToken),
    ]);
    if (!board) continue;
    const meta = predict instanceof PredictV2Client ? predict.marketMetaFor(m.id) : undefined;
    const cost = (side: 'up' | 'down') =>
      meta?.feePolicy
        ? (estimateMintCost({
            fees: meta.feePolicy,
            expiryMs: m.expiryMs,
            nowMs: now,
            sideProbability: side === 'up' ? board.up : board.down,
            direction: side,
            quantity: 100,
          })?.costPerContract ?? null)
        : null;
    const ok = ledger.insertCrossVenuePair({
      network: suiNetwork(),
      marketId: m.id,
      pmConditionId: w.conditionId,
      slot,
      expiryMs: m.expiryMs,
      recordedAtMs: now,
      ttmMs: ttm,
      predReference: m.referencePrice!,
      predBoardUp: board.up,
      predCostUp: cost('up'),
      predCostDown: cost('down'),
      pmAskUp: askUp?.price ?? null,
      pmAskDown: askDown?.price ?? null,
      pmDepthUp: askUp?.size ?? null,
      pmDepthDown: askDown?.size ?? null,
      pmFeeRate: w.feeRate,
      pmFeeExponent: w.feeExponent,
      spotMid: deps.spotMid ?? null,
    });
    if (ok) recorded++;
  }
  if (recorded) log.info('svx.cross_venue.recorded', { pairs: recorded });
  return recorded;
}

/** Polymarket resolution: `closed: true` is load-bearing — gamma hides closed
 *  markets by default (the 2026-07 settlement incident). */
async function pmOutcomeUp(conditionId: string): Promise<boolean | null> {
  try {
    const { data } = await axios.get<Array<Record<string, unknown>>>(`${GAMMA}/markets`, {
      params: { condition_ids: conditionId, closed: true, limit: 1 },
      timeout: 8_000,
    });
    const m = data?.[0];
    if (!m) return null;
    const outcomes: string[] = JSON.parse(String(m.outcomes ?? '[]'));
    const prices: number[] = JSON.parse(String(m.outcomePrices ?? '[]')).map(Number);
    const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up');
    if (upIdx < 0 || prices.length !== outcomes.length) return null;
    if (prices[upIdx]! >= 0.99) return true;
    if (prices[upIdx]! <= 0.01) return false;
    return null; // not final yet
  } catch {
    return null;
  }
}

export async function resolveCrossVenuePairs(deps: {
  predict: PredictReader;
  ledger: LedgerStore;
  nowMs?: number;
}): Promise<number> {
  const now = deps.nowMs ?? Date.now();
  let resolved = 0;
  for (const p of deps.ledger.unresolvedCrossVenuePairs(now - 15_000)) {
    if (p.needPred) {
      const snap = await deps.predict.snapshotOracle(p.marketId).catch(() => null);
      if (snap?.isSettled && snap.settlementPrice != null) {
        resolved += deps.ledger.resolveCrossVenuePred(p.marketId, snap.settlementPrice, now);
      }
    }
    if (p.needPm) {
      const up = await pmOutcomeUp(p.pmConditionId);
      if (up != null) resolved += deps.ledger.resolveCrossVenuePm(p.pmConditionId, up, now);
    }
  }
  if (resolved) log.info('svx.cross_venue.resolved', { updates: resolved });
  deps.ledger.pruneCrossVenuePairs(now - 3 * 86_400_000);
  return resolved;
}

// ── report ───────────────────────────────────────────────────────────────────

/** Polymarket taker fee per share: rate · (p(1−p))^exponent (USDC). */
export function pmTakerFee(price: number, rate: number | null, exponent: number | null): number {
  if (!rate) return 0;
  return rate * Math.pow(price * (1 - price), exponent ?? 1);
}

export interface CrossVenueComboStats {
  combo: 'predUp_pmDown' | 'pmUp_predDown';
  slot: string;
  pairs: number;
  /** Pairs whose all-in cost (both legs, both fees) was below $1. */
  underDollar: number;
  avgCostWhenUnder: number | null;
  /** Realized payout − cost per pair, over the under-$1 pairs only. */
  realizedPnlWhenUnder: number | null;
  /** Under-$1 pairs where the venues disagreed and BOTH legs lost. */
  bothLost: number;
  bothWon: number;
}

export function scoreCrossVenue(rows: CrossVenuePairRow[]): {
  pairs: number;
  windows: number;
  /** Share of windows where the two settlement rules gave different answers. */
  disagreementRate: number | null;
  combos: CrossVenueComboStats[];
} {
  const slots = ['all', ...new Set(rows.map((r) => r.slot))];
  const combos: CrossVenueComboStats[] = [];
  for (const combo of ['predUp_pmDown', 'pmUp_predDown'] as const) {
    for (const slot of slots) {
      const set = rows.filter((r) => slot === 'all' || r.slot === slot);
      let pairs = 0;
      let under = 0;
      let costSum = 0;
      let pnlSum = 0;
      let bothLost = 0;
      let bothWon = 0;
      for (const r of set) {
        const predCost = combo === 'predUp_pmDown' ? r.predCostUp : r.predCostDown;
        const pmAsk = combo === 'predUp_pmDown' ? r.pmAskDown : r.pmAskUp;
        if (predCost == null || pmAsk == null) continue;
        pairs++;
        const cost = predCost + pmAsk + pmTakerFee(pmAsk, r.pmFeeRate, r.pmFeeExponent);
        if (cost >= 1) continue;
        under++;
        costSum += cost;
        const predWins = combo === 'predUp_pmDown' ? r.predOutcomeUp : !r.predOutcomeUp;
        const pmWins = combo === 'predUp_pmDown' ? !r.pmOutcomeUp : r.pmOutcomeUp;
        const payout = (predWins ? 1 : 0) + (pmWins ? 1 : 0);
        if (payout === 0) bothLost++;
        if (payout === 2) bothWon++;
        pnlSum += payout - cost;
      }
      if (!pairs) continue;
      combos.push({
        combo,
        slot,
        pairs,
        underDollar: under,
        avgCostWhenUnder: under ? costSum / under : null,
        realizedPnlWhenUnder: under ? pnlSum / under : null,
        bothLost,
        bothWon,
      });
    }
  }
  // One vote per window (each window is recorded at up to three slots).
  const windows = new Map<string, boolean>();
  for (const r of rows) windows.set(r.marketId, r.predOutcomeUp !== r.pmOutcomeUp);
  const disagreementRate = windows.size
    ? [...windows.values()].filter(Boolean).length / windows.size
    : null;
  return { pairs: rows.length, windows: windows.size, disagreementRate, combos };
}
