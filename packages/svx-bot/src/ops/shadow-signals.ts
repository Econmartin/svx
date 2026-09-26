/**
 * Shadow signal tracker — "could any signal beat the fee?", answered with
 * live data and zero risk.
 *
 * Mainnet Predict lists 1m and 5m BTC up/down windows whose strike is the
 * on-chain reference price. Buying either side costs the board price plus a
 * fee of 0.204·√(p(1−p)) per contract (×3 in the final minute), so at ~50¢ a
 * signal must be right ~60% of the time just to break even. A backtest on
 * 12.9 days of settlements found plain momentum / mean reversion at 50%.
 *
 * This recorder looks for anything better. At two decision points per market
 * (≈50s and ≈4m before expiry) it stores the board price, the all-in cost of
 * each side, and every external signal we can read cheaply:
 *
 *   - Binance BTCUSDT 1m/5m/15m momentum, top-of-book imbalance and taker
 *     buy ratio (data-api.binance.vision — the public, non-geo-blocked mirror)
 *   - OKX perpetual funding rate, Hyperliquid BTC perp mid
 *   - a Binance-implied fair value: the chain's own rolled SVI surface priced
 *     off Binance mid (basis-adjusted) instead of the on-chain forward — the
 *     direct test of "does the chain's price lag the world?"
 *
 * Every row resolves against the settlement; GET /shadow-signals scores each
 * signal on hit rate AND fee-inclusive PnL per contract. Nothing here trades.
 */

import axios from 'axios';
import type { LedgerStore, ShadowDecisionRow } from '../ledger/store.js';
import { binaryUpFromTotalVariance } from '../pricing/bs.js';
import { boardPrice, estimateMintCost, listSdkMarkets } from '../pricing/predict-sdk.js';
import { PredictV2Client, type PredictReader } from '../pricing/predict-v2.js';
import { evalTotalVariance } from '../pricing/svi.js';
import { suiNetwork } from '../exec/sui-client.js';
import { log } from '../util/log.js';
import { fadeSpikeSide } from '../strategy/fade-spike.js';
import type { ShadowDecisionInput } from '../ledger/store.js';

/** Decision points, as time-to-expiry windows. One row per market per slot. */
const SLOTS: Array<{ slot: string; minMs: number; maxMs: number }> = [
  // Last-minute checkpoint for the spike-fade pattern; clear of the 10s
  // pre-expiry no-trade window.
  { slot: 't30s', minMs: 22_000, maxMs: 36_000 },
  { slot: 't50s', minMs: 40_000, maxMs: 60_000 },
  { slot: 't4m', minMs: 220_000, maxMs: 260_000 },
];

const BINANCE = 'https://data-api.binance.vision/api/v3';
const OKX_FUNDING = 'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP';
const HL_INFO = 'https://api.hyperliquid.xyz/info';

export interface ExternalSignals {
  binMid: number | null;
  mom1m: number | null;
  mom5m: number | null;
  mom15m: number | null;
  /** (bid qty − ask qty) / total over the top 20 levels, −1..1. */
  bookImb: number | null;
  /** Taker-buy share of volume over the last 3 minutes, 0..1. */
  takerBuyRatio: number | null;
  funding: number | null;
  /** Hyperliquid BTC perp mid. */
  hlMid: number | null;
  /** Binance log return over the last 30 seconds (1s candles). */
  mom30s: number | null;
}

let extCache: { atMs: number; v: ExternalSignals } | null = null;

/** Every source is optional: a failed fetch yields nulls, never a throw. */
export async function fetchExternalSignals(nowMs = Date.now()): Promise<ExternalSignals> {
  if (extCache && nowMs - extCache.atMs < 5_000) return extCache.v;
  const get = <T>(url: string) =>
    axios
      .get<T>(url, { timeout: 4_000 })
      .then((r) => r.data)
      .catch(() => null);
  const [klines, depth, funding, hlMids, secs] = await Promise.all([
    // [openTime, open, high, low, close, volume, closeTime, quoteVol, trades, takerBuyBase, ...]
    get<Array<Array<string | number>>>(`${BINANCE}/klines?symbol=BTCUSDT&interval=1m&limit=16`),
    get<{ bids: [string, string][]; asks: [string, string][] }>(
      `${BINANCE}/depth?symbol=BTCUSDT&limit=20`,
    ),
    get<{ data?: Array<{ fundingRate?: string }> }>(OKX_FUNDING),
    axios
      .post<Record<string, string>>(HL_INFO, { type: 'allMids' }, { timeout: 4_000 })
      .then((r) => r.data)
      .catch(() => null),
    get<Array<Array<string | number>>>(`${BINANCE}/klines?symbol=BTCUSDT&interval=1s&limit=31`),
  ]);
  const v: ExternalSignals = {
    binMid: null,
    mom1m: null,
    mom5m: null,
    mom15m: null,
    bookImb: null,
    takerBuyRatio: null,
    funding: null,
    hlMid: null,
    mom30s: null,
  };
  if (depth?.bids?.length && depth.asks?.length) {
    const bid = Number(depth.bids[0]![0]);
    const ask = Number(depth.asks[0]![0]);
    v.binMid = (bid + ask) / 2;
    const bq = depth.bids.reduce((a, [, q]) => a + Number(q), 0);
    const aq = depth.asks.reduce((a, [, q]) => a + Number(q), 0);
    if (bq + aq > 0) v.bookImb = (bq - aq) / (bq + aq);
  }
  if (Array.isArray(klines) && klines.length >= 16) {
    const close = (i: number) => Number(klines[klines.length - 1 - i]![4]);
    const last = v.binMid ?? close(0);
    // Returns from the close N minutes back; the current candle is still open.
    v.mom1m = Math.log(last / close(1));
    v.mom5m = Math.log(last / close(5));
    v.mom15m = Math.log(last / close(15));
    const recent = klines.slice(-3);
    const vol = recent.reduce((a, k) => a + Number(k[5]), 0);
    const takerBuy = recent.reduce((a, k) => a + Number(k[9]), 0);
    if (vol > 0) v.takerBuyRatio = takerBuy / vol;
    if (v.binMid == null) v.binMid = last;
  }
  const f = Number(funding?.data?.[0]?.fundingRate);
  if (Number.isFinite(f)) v.funding = f;
  if (Array.isArray(secs) && secs.length >= 25) {
    const first = Number(secs[0]![4]);
    const last = Number(secs[secs.length - 1]![4]);
    if (first > 0 && last > 0) v.mom30s = Math.log(last / first);
  }
  const hl = Number(hlMids?.BTC);
  if (Number.isFinite(hl) && hl > 0) v.hlMid = hl;
  extCache = { atMs: nowMs, v };
  return v;
}

/** EWMA of venue price / chain forward, per venue, so the implied-value
 *  signals measure the MOVE, not the stablecoin or perp basis. */
const basisEwma = new Map<string, number>();

function impliedUp(
  venue: string,
  mid: number | null,
  snap: { forward: number; svi: import('svx-shared/types').SVIParams },
  reference: number,
): number | null {
  if (mid == null || !(snap.forward > 0)) return null;
  const ratio = mid / snap.forward;
  const prev = basisEwma.get(venue);
  const basis = prev == null ? ratio : prev * 0.9 + ratio * 0.1;
  basisEwma.set(venue, basis);
  const fwd = mid / basis;
  const w = evalTotalVariance(Math.log(reference / fwd), snap.svi);
  const up = binaryUpFromTotalVariance(reference, fwd, w);
  return Number.isFinite(up) ? up : null;
}

/** A freshly recorded decision, with what an executor needs to act on it. */
export interface ShadowDecisionEvent {
  decision: ShadowDecisionInput;
  underlying: string;
}

export async function recordShadowDecisions(deps: {
  predict: PredictReader;
  ledger: LedgerStore;
  nowMs?: number;
  /** Called once per newly recorded decision (e.g. the fade-spike executor). */
  onDecision?: (e: ShadowDecisionEvent) => Promise<void>;
}): Promise<number> {
  const { predict, ledger } = deps;
  const now = deps.nowMs ?? Date.now();
  const due = (await listSdkMarkets()).filter(
    (m) =>
      m.referencePrice != null &&
      SLOTS.some(
        (s) =>
          m.expiryMs - now >= s.minMs &&
          m.expiryMs - now <= s.maxMs &&
          !ledger.hasShadowDecision(m.id, s.slot),
      ),
  );
  if (!due.length) return 0;
  const ext = await fetchExternalSignals(now);
  let recorded = 0;
  for (const m of due) {
    const ttm = m.expiryMs - now;
    const slot = SLOTS.find((s) => ttm >= s.minMs && ttm <= s.maxMs)!.slot;
    const snap = await predict.snapshotOracle(m.id).catch(() => null);
    if (!snap || snap.isSettled || now - snap.timestampMs > 30_000) continue;
    const board = await boardPrice(snap.underlyingAsset, m.expiryMs, 'reference');
    if (!board) continue;
    const reference = m.referencePrice!;
    const meta = predict instanceof PredictV2Client ? predict.marketMetaFor(m.id) : undefined;
    const cost = (side: 'up' | 'down') => {
      if (!meta?.feePolicy) return null;
      // Per-contract cost is size-independent; 100 clears the min premium.
      return (
        estimateMintCost({
          fees: meta.feePolicy,
          expiryMs: m.expiryMs,
          nowMs: now,
          sideProbability: side === 'up' ? board.up : board.down,
          direction: side,
          quantity: 100,
        })?.costPerContract ?? null
      );
    };
    const binImpliedUp = impliedUp('binance', ext.binMid, snap, reference);
    const binBasis = basisEwma.get('binance');
    const binVsRef = ext.binMid != null && binBasis ? ext.binMid / binBasis - reference : null;
    const hlImpliedUp = impliedUp('hyperliquid', ext.hlMid, snap, reference);
    const decision: ShadowDecisionInput = {
      network: suiNetwork(),
      marketId: m.id,
      slot,
      expiryMs: m.expiryMs,
      recordedAtMs: now,
      ttmMs: ttm,
      reference,
      forward: snap.forward,
      boardUp: board.up,
      costUp: cost('up'),
      costDown: cost('down'),
      binMid: ext.binMid,
      binImpliedUp,
      mom1m: ext.mom1m,
      mom5m: ext.mom5m,
      mom15m: ext.mom15m,
      bookImb: ext.bookImb,
      takerBuyRatio: ext.takerBuyRatio,
      funding: ext.funding,
      hlMid: ext.hlMid,
      hlImpliedUp,
      mom30s: ext.mom30s,
      binVsRef,
    };
    const ok = ledger.insertShadowDecision(decision);
    if (ok && deps.onDecision) {
      await deps.onDecision({ decision, underlying: snap.underlyingAsset }).catch((e) =>
        log.warn('svx.shadow.on_decision_error', {
          err: e instanceof Error ? e.message : String(e),
        }),
      );
    }
    if (ok) recorded++;
  }
  if (recorded) log.info('svx.shadow.recorded', { decisions: recorded });
  return recorded;
}

export async function resolveShadowDecisions(deps: {
  predict: PredictReader;
  ledger: LedgerStore;
  nowMs?: number;
}): Promise<number> {
  const now = deps.nowMs ?? Date.now();
  let resolved = 0;
  for (const marketId of deps.ledger.unsettledShadowMarkets(now - 10_000)) {
    const snap = await deps.predict.snapshotOracle(marketId).catch(() => null);
    if (!snap?.isSettled || snap.settlementPrice == null) continue;
    resolved += deps.ledger.resolveShadowMarket(marketId, snap.settlementPrice, now);
  }
  if (resolved) log.info('svx.shadow.resolved', { decisions: resolved });
  deps.ledger.pruneShadowDecisions(now - 7 * 86_400_000);
  return resolved;
}

// ── scoring ──────────────────────────────────────────────────────────────────

type Pick = 'up' | 'down' | null;
const sign = (x: number | null, dead = 0): Pick =>
  x == null || Math.abs(x) <= dead ? null : x > 0 ? 'up' : 'down';
const flip = (p: Pick): Pick => (p == null ? null : p === 'up' ? 'down' : 'up');

/** Each signal maps a decision row to a side (or abstains). Follow AND fade
 *  variants are both listed: their hit rates mirror, their costs do not. */
export const SHADOW_SIGNALS: Record<string, (r: ShadowDecisionRow) => Pick> = {
  always_up: () => 'up',
  always_down: () => 'down',
  board_favourite: (r) => (r.boardUp >= 0.5 ? 'up' : 'down'),
  board_underdog: (r) => (r.boardUp >= 0.5 ? 'down' : 'up'),
  mom_1m_follow: (r) => sign(r.mom1m),
  mom_1m_fade: (r) => flip(sign(r.mom1m)),
  mom_5m_follow: (r) => sign(r.mom5m),
  mom_5m_fade: (r) => flip(sign(r.mom5m)),
  mom_15m_follow: (r) => sign(r.mom15m),
  mom_15m_fade: (r) => flip(sign(r.mom15m)),
  book_imbalance: (r) => sign(r.bookImb, 0.2),
  taker_flow: (r) => sign(r.takerBuyRatio == null ? null : r.takerBuyRatio - 0.5, 0.05),
  funding_contrarian: (r) => flip(sign(r.funding)),
  // The latency test: act only when Binance-implied value disagrees with the
  // board by more than a few points.
  binance_lead_3pp: (r) =>
    r.binImpliedUp == null ? null : sign(r.binImpliedUp - r.boardUp, 0.03),
  binance_lead_8pp: (r) =>
    r.binImpliedUp == null ? null : sign(r.binImpliedUp - r.boardUp, 0.08),
  hl_lead_3pp: (r) =>
    r.hlImpliedUp == null ? null : sign(r.hlImpliedUp - r.boardUp, 0.03),
  // The pattern three mainnet wallets profit from (z 3.6–6.6, 2026-09-25):
  // in the last minute, after BTC ran ≥$20 past the strike over the prior
  // 30s, buy the now-cheap far side (≤30¢) betting the spike partly reverses.
  fade_spike: (r) => fadeSpike(r, 20, 0.3),
  fade_spike_40: (r) => fadeSpike(r, 40, 0.3),
  // Control: same cheap far side, no spike requirement — separates "cheap
  // last-minute underdogs are underpriced" from "spikes reverse".
  cheap_far_side: (r) => {
    if (r.ttmMs > 60_000 || r.binVsRef == null) return null;
    const far: Pick = r.binVsRef > 0 ? 'down' : 'up';
    const farPrice = far === 'up' ? r.boardUp : 1 - r.boardUp;
    return farPrice <= 0.3 ? far : null;
  },
};

function fadeSpike(r: ShadowDecisionRow, minUsd: number, maxPrice: number): Pick {
  return fadeSpikeSide(r, minUsd, maxPrice);
}

export interface ShadowSignalScore {
  signal: string;
  slot: string;
  n: number;
  hitRate: number;
  /** Two standard errors on the hit rate. */
  noise: number;
  avgCost: number;
  /** Realized payout minus all-in cost, per $1 contract. */
  pnlPerContract: number;
}

export function scoreShadowSignals(rows: ShadowDecisionRow[]): ShadowSignalScore[] {
  const out: ShadowSignalScore[] = [];
  const slots = ['all', ...new Set(rows.map((r) => r.slot))];
  for (const [name, fn] of Object.entries(SHADOW_SIGNALS)) {
    for (const slot of slots) {
      let n = 0;
      let hits = 0;
      let cost = 0;
      for (const r of rows) {
        if (slot !== 'all' && r.slot !== slot) continue;
        const pick = fn(r);
        const c = pick === 'up' ? r.costUp : pick === 'down' ? r.costDown : null;
        if (pick == null || c == null) continue;
        n++;
        cost += c;
        if ((pick === 'up') === r.outcomeUp) hits++;
      }
      if (!n) continue;
      const hitRate = hits / n;
      out.push({
        signal: name,
        slot,
        n,
        hitRate,
        noise: 2 * Math.sqrt(0.25 / n),
        avgCost: cost / n,
        pnlPerContract: hitRate - cost / n,
      });
    }
  }
  return out.sort((a, b) => b.pnlPerContract - a.pnlPerContract);
}
