/**
 * Edge trackers — read-only probes for the two edges the 2026-09-27 study
 * left open. Both write to `edge_probes`, which the switchboard never
 * reads, so nothing here can trade.
 *
 * 1. JUMP (lead-lag). On the launch tape (4,172 fills), when Binance had
 *    moved > $15 toward the bought side in the 2s before a fill, that side
 *    won 72% against a 46% price (+14¢/contract after fees, n=61); the effect
 *    was gone by 10s. The chain's Pyth spot is only ~0.28s old at a fill, so
 *    the lag is in the feed's aggregation, not staleness. What the tape
 *    cannot say is whether WE are fast enough. So: a Binance websocket
 *    fires on a ≥ $10 move within 2s, reads the chain's exact board price
 *    at once (q1), again at ≈ +0.6s (q2) and ≈ +1.2s (q3) — the span in
 *    which our mint would land — and scores the jump side at each against
 *    the settlement.
 *
 * 2. VOL_REGIME. The chain's SVI vol updates slowly; the last 15 minutes of
 *    realized vol (×1.35) predicted the size of the next move better (corr
 *    0.46 vs 0.35). Quiet regimes made central windows win 69% vs 56%
 *    priced; busy regimes underpriced underdogs. After fees the edge was
 *    inside the noise on 3 days, so this records exact chain quotes for
 *    up / down / central $25-$50-$100 windows at t4m, t2m and t65s (before
 *    the last-minute fee ramp), with realized and chain vol, and scores
 *    them by regime.
 *
 * GET /edge-trackers reports both. SVX_EDGE_TRACKERS=false disables.
 *
 * Both also sit on the strategy switchboard (user's rule, 2026-09-27):
 * `binance_jump@jump` (first trigger per market, scored at q2) and
 * `vol_model@<slot>` (the model trader's pick at ≥ 3¢ modelled edge). They
 * trade through the hooks below when green and stay idle when red.
 */

import axios from 'axios';
import WebSocket from 'ws';
import { pricing as sdkPricing } from '@mysten/deepbook-v3/predict';
import type { EdgeProbeRow, LedgerStore } from '../ledger/store.js';
import { normalCdf } from '../pricing/bs.js';
import {
  boardPrice,
  estimateBoundaryCost,
  estimateMintCost,
  listSdkMarkets,
  marketFeePolicy,
  resolvedPricer,
  type SdkMarket,
} from '../pricing/predict-sdk.js';
import type { PredictReader } from '../pricing/predict-v2.js';
import type { ShadowSignalScore } from './shadow-signals.js';
import { suiNetwork } from '../exec/sui-client.js';
import { log } from '../util/log.js';

export function edgeTrackersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SVX_EDGE_TRACKERS !== 'false';
}

type Side = 'up' | 'down';

/** Payout rule shared by both trackers: (lower, upper], null = infinite. */
export function pays(lower: number | null, upper: number | null, settlement: number): boolean {
  return (lower == null || settlement > lower) && (upper == null || settlement <= upper);
}

interface Stat {
  n: number;
  /** Mean board probability of the bought outcome. */
  priced: number;
  won: number;
  allIn: number;
  pnlPerContract: number;
  /** Two standard errors on the win rate. */
  noise: number;
}

function stat(xs: Array<{ prob: number; cost: number; win: boolean }>): Stat | null {
  if (!xs.length) return null;
  const n = xs.length;
  const won = xs.filter((x) => x.win).length / n;
  const allIn = xs.reduce((a, x) => a + x.cost, 0) / n;
  const r = (v: number) => Number(v.toFixed(4));
  return {
    n,
    priced: r(xs.reduce((a, x) => a + x.prob, 0) / n),
    won: r(won),
    allIn: r(allIn),
    pnlPerContract: r(won - allIn),
    noise: r(2 * Math.sqrt((won * (1 - won)) / n)),
  };
}

// ── 1. jump tracker ─────────────────────────────────────────────────────────

const JUMP_USD = 10;
const JUMP_WINDOW_MS = 2_000;
const JUMP_COOLDOWN_MS = 3_000;
/** Extra delays before the second and third quotes: q2 ≈ +0.6s (a fast
 *  sign-submit-land), q3 ≈ +1.2s (a slow one). The first live jump showed
 *  the chain repricing a $29 drop from 37% to 3% UP between q1 and +1.2s. */
const Q2_DELAY_MS = 400;
const Q3_DELAY_MS = 600;
/** Skip markets this close to expiry (the chain's own no-trade window). */
const MIN_TTM_MS = 12_000;

/**
 * Rolling Binance mid buffer. `push` returns the 2s move when it crosses
 * the threshold (and the cooldown has passed), else null. Pure.
 */
export class JumpDetector {
  private buf: Array<[number, number]> = [];
  private lastFireMs = -Infinity;

  constructor(
    private readonly thresholdUsd = JUMP_USD,
    private readonly windowMs = JUMP_WINDOW_MS,
    private readonly cooldownMs = JUMP_COOLDOWN_MS,
  ) {}

  push(tMs: number, mid: number): number | null {
    this.buf.push([tMs, mid]);
    while (this.buf.length && this.buf[0]![0] < tMs - this.windowMs - 1_000) this.buf.shift();
    // Oldest sample still inside the window; needs ~the full window of history.
    const past = this.buf.find(([t]) => t >= tMs - this.windowMs);
    if (!past || tMs - past[0] < this.windowMs * 0.75) return null;
    const move = mid - past[1];
    if (Math.abs(move) < this.thresholdUsd || tMs - this.lastFireMs < this.cooldownMs) return null;
    this.lastFireMs = tMs;
    return move;
  }
}

export interface JumpQuote {
  atMs: number;
  /** Board UP probability at the reference strike. */
  up: number;
  /** All-in cost per contract of the jump side. */
  cost: number | null;
}

export interface JumpPayload {
  side: Side;
  move2sUsd: number;
  binMid: number;
  reference: number;
  triggerMs: number;
  q1: JumpQuote | null;
  q2: JumpQuote | null;
  q3?: JumpQuote | null;
}

const BINANCE_WS = 'wss://data-stream.binance.vision/ws/btcusdt@bookTicker';

/**
 * Starts the websocket and returns a stop function. Markets refresh every
 * 10s; one trigger is handled at a time (a jump that lands while the last
 * one is still quoting is dropped — rows stay independent).
 */
/** A jump, with the first chain quote for every live market — fired before q2/q3 are read. */
export interface JumpEvent {
  triggerMs: number;
  side: Side;
  move2sUsd: number;
  markets: Array<{ market: SdkMarket; q1: JumpQuote }>;
}

export function startJumpTracker(deps: {
  ledger: LedgerStore;
  thresholdUsd?: number;
  /** Switchboard executor; must not block (errors are its own). */
  onJump?: (e: JumpEvent) => void;
}): () => void {
  const detector = new JumpDetector(deps.thresholdUsd ?? JUMP_USD);
  let markets: SdkMarket[] = [];
  let busy = false;
  let stopped = false;
  let ws: WebSocket | null = null;
  let lastMsgMs = Date.now();

  const refresh = () =>
    listSdkMarkets()
      .then((m) => {
        markets = m;
      })
      .catch(() => undefined);
  void refresh();
  const marketTimer = setInterval(refresh, 10_000);

  const quote = async (m: SdkMarket, side: Side): Promise<JumpQuote | null> => {
    const board = await boardPrice('BTC', m.expiryMs, 'reference');
    if (!board) return null;
    const atMs = Date.now();
    const fees = await marketFeePolicy(m.id);
    const cost = fees
      ? (estimateMintCost({
          fees,
          expiryMs: m.expiryMs,
          nowMs: atMs,
          sideProbability: side === 'up' ? board.up : board.down,
          direction: side,
          quantity: 100,
        })?.costPerContract ?? null)
      : null;
    return { atMs, up: board.up, cost };
  };

  const onJump = async (triggerMs: number, move: number, binMid: number) => {
    const side: Side = move > 0 ? 'up' : 'down';
    const live = markets.filter(
      (m) =>
        m.referencePrice != null && !m.mintPaused && m.expiryMs - triggerMs >= MIN_TTM_MS,
    );
    if (!live.length) return;
    const round = () => Promise.all(live.map((m) => quote(m, side).catch(() => null)));
    const q1s = await round();
    if (deps.onJump) {
      const withQuote = live.flatMap((market, i) => (q1s[i] ? [{ market, q1: q1s[i]! }] : []));
      if (withQuote.length) {
        deps.onJump({ triggerMs, side, move2sUsd: payload2dp(move), markets: withQuote });
      }
    }
    await new Promise((r) => setTimeout(r, Q2_DELAY_MS));
    const q2s = await round();
    await new Promise((r) => setTimeout(r, Q3_DELAY_MS));
    const q3s = await round();
    let n = 0;
    live.forEach((m, i) => {
      const payload: JumpPayload = {
        side,
        move2sUsd: Number(move.toFixed(2)),
        binMid,
        reference: m.referencePrice!,
        triggerMs,
        q1: q1s[i] ?? null,
        q2: q2s[i] ?? null,
        q3: q3s[i] ?? null,
      };
      if (!payload.q1 && !payload.q2 && !payload.q3) return;
      const ok = deps.ledger.insertEdgeProbe({
        id: `jump:${m.id}:${triggerMs}`,
        network: suiNetwork(),
        kind: 'jump',
        marketId: m.id,
        slot: 'jump',
        expiryMs: m.expiryMs,
        recordedAtMs: triggerMs,
        ttmMs: m.expiryMs - triggerMs,
        payload,
      });
      if (ok) n++;
    });
    if (n) log.info('svx.edge.jump_recorded', { move: payload2dp(move), side, markets: n });
  };

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(BINANCE_WS);
    ws.on('message', (raw) => {
      lastMsgMs = Date.now();
      let msg: { b?: string; a?: string };
      try {
        msg = JSON.parse(String(raw)) as { b?: string; a?: string };
      } catch {
        return;
      }
      const mid = (Number(msg.b) + Number(msg.a)) / 2;
      if (!(mid > 0)) return;
      const now = Date.now();
      const move = detector.push(now, mid);
      if (move == null || busy) return;
      busy = true;
      onJump(now, move, mid)
        .catch((e) =>
          log.warn('svx.edge.jump_error', { err: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => {
          busy = false;
        });
    });
    ws.on('error', (e) => log.warn('svx.edge.ws_error', { err: e.message }));
    ws.on('close', () => {
      if (!stopped) setTimeout(connect, 5_000);
    });
  };
  connect();
  // A silent socket (no ticks for 30s) is a dead one.
  const watchdog = setInterval(() => {
    if (Date.now() - lastMsgMs > 30_000) {
      lastMsgMs = Date.now();
      ws?.terminate();
    }
  }, 10_000);
  log.info('svx.edge.jump_tracker_started', { thresholdUsd: deps.thresholdUsd ?? JUMP_USD, windowMs: JUMP_WINDOW_MS });

  return () => {
    stopped = true;
    clearInterval(marketTimer);
    clearInterval(watchdog);
    ws?.terminate();
  };
}

const payload2dp = (x: number) => Number(x.toFixed(2));

export interface JumpReport {
  /** Median ms from trigger to each quote. */
  latencyMs: { q1: number | null; q2: number | null; q3: number | null };
  /** Every recorded row, by 2s move size and by quote. */
  byMove: Array<{ move: string; q1: Stat | null; q2: Stat | null; q3: Stat | null }>;
  /** Final-minute markets pay up to 3× fee: split out. */
  byTtm: Array<{ ttm: string; q2: Stat | null }>;
  /** First trigger per market only — rows within a market are correlated. */
  firstPerMarketQ2: Stat | null;
}

export function scoreJumps(rows: Array<EdgeProbeRow<JumpPayload>>): JumpReport {
  const leg = (r: EdgeProbeRow<JumpPayload>, q: JumpQuote | null) => {
    if (!q || q.cost == null) return null;
    const p = r.payload;
    const prob = p.side === 'up' ? q.up : 1 - q.up;
    const win = p.side === 'up' ? r.settlementPrice > p.reference : r.settlementPrice <= p.reference;
    return { prob, cost: q.cost, win };
  };
  const moveBucket = (m: number) => {
    const a = Math.abs(m);
    return a < 15 ? '$10-15' : a < 25 ? '$15-25' : '$25+';
  };
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1]!;
  };
  const byMove = ['$10-15', '$15-25', '$25+'].map((move) => {
    const rs = rows.filter((r) => moveBucket(r.payload.move2sUsd) === move);
    const pick = (k: 'q1' | 'q2' | 'q3') =>
      stat(rs.map((r) => leg(r, r.payload[k] ?? null)).filter((x) => x != null));
    return { move, q1: pick('q1'), q2: pick('q2'), q3: pick('q3') };
  });
  const byTtm = [
    { ttm: 'final 60s (fee ramp)', f: (t: number) => t < 60_000 },
    { ttm: '60s+', f: (t: number) => t >= 60_000 },
  ].map(({ ttm, f }) => ({
    ttm,
    q2: stat(
      rows.filter((r) => f(r.ttmMs)).map((r) => leg(r, r.payload.q2)).filter((x) => x != null),
    ),
  }));
  const seen = new Set<string>();
  const first = rows.filter((r) => (seen.has(r.marketId) ? false : (seen.add(r.marketId), true)));
  const lat = (k: 'q1' | 'q2' | 'q3') =>
    median(rows.flatMap((r) => (r.payload[k] ? [r.payload[k]!.atMs - r.payload.triggerMs] : [])));
  return {
    latencyMs: { q1: lat('q1'), q2: lat('q2'), q3: lat('q3') },
    byMove,
    byTtm,
    firstPerMarketQ2: stat(first.map((r) => leg(r, r.payload.q2)).filter((x) => x != null)),
  };
}

// ── 2. vol-regime tracker ───────────────────────────────────────────────────

const VOL_SLOTS: Array<{ slot: string; minMs: number; maxMs: number }> = [
  { slot: 't4m', minMs: 220_000, maxMs: 260_000 },
  { slot: 't2m', minMs: 100_000, maxMs: 140_000 },
  // Last checkpoint before the final-minute fee ramp.
  { slot: 't65s', minMs: 61_000, maxMs: 80_000 },
];
/** Realized-vol scale fitted on the launch tape (log-loss optimum 1.2–1.35). */
export const RV_SCALE = 1.35;
const WINDOW_WIDTHS = [25, 50, 100];

export interface VolCandidate {
  name: string;
  lower: number | null;
  upper: number | null;
  /** Chain probability of the order paying. */
  prob: number;
  cost: number;
}

export interface VolRegimePayload {
  forward: number;
  reference: number;
  /** RMS of 1s Binance mid changes over the last 15 / 5 minutes, $ per √s. */
  rv15: number;
  rv5: number | null;
  /** The chain's at-the-money standard deviation to expiry, in $. */
  chainSdUsd: number;
  candidates: VolCandidate[];
}

let rvCache: { atMs: number; rv15: number | null; rv5: number | null; rv2: number | null } | null = null;

/** RMS of successive 1s closes, in $ per √s. Null on any fetch failure. */
export function rmsPerSqrtSecond(closes: number[]): number | null {
  if (closes.length < 30) return null;
  let s = 0;
  for (let i = 1; i < closes.length; i++) s += (closes[i]! - closes[i - 1]!) ** 2;
  return Math.sqrt(s / (closes.length - 1));
}

let rv60Cache: { atMs: number; rv60: number | null } | null = null;

/** Last hour's realized vol from 1m closes, in $ per √s (1m RMS / √60). */
async function realizedVolHour(nowMs: number): Promise<number | null> {
  if (rv60Cache && nowMs - rv60Cache.atMs < 30_000) return rv60Cache.rv60;
  const k = await axios
    .get<Array<Array<string | number>>>(
      'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=61',
      { timeout: 5_000 },
    )
    .then((r) => r.data)
    .catch(() => null);
  const closes = Array.isArray(k) ? k.map((x) => Number(x[4])).filter((x) => x > 0) : [];
  const perMin = closes.length >= 50 ? rmsPerSqrtSecond(closes) : null;
  rv60Cache = { atMs: nowMs, rv60: perMin == null ? null : perMin / Math.sqrt(60) };
  return rv60Cache.rv60;
}

async function realizedVol(
  nowMs: number,
): Promise<{ rv15: number | null; rv5: number | null; rv2: number | null }> {
  if (rvCache && nowMs - rvCache.atMs < 5_000) return rvCache;
  const k = await axios
    .get<Array<Array<string | number>>>(
      'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=901',
      { timeout: 5_000 },
    )
    .then((r) => r.data)
    .catch(() => null);
  const closes = Array.isArray(k) ? k.map((x) => Number(x[4])).filter((x) => x > 0) : [];
  rvCache = {
    atMs: nowMs,
    rv15: closes.length >= 800 ? rmsPerSqrtSecond(closes) : null,
    rv5: closes.length >= 300 ? rmsPerSqrtSecond(closes.slice(-301)) : null,
    rv2: closes.length >= 120 ? rmsPerSqrtSecond(closes.slice(-121)) : null,
  };
  return rvCache;
}

type Svi = { a: number; b: number; rho: number; m: number; sigma: number };
const totalVariance = (k: number, s: Svi) =>
  s.a + s.b * (s.rho * (k - s.m) + Math.sqrt((k - s.m) ** 2 + s.sigma ** 2));

export interface VolRegimeEvent {
  market: SdkMarket;
  slot: string;
  ttmMs: number;
  payload: VolRegimePayload;
}

export async function recordVolRegime(deps: {
  ledger: LedgerStore;
  nowMs?: number;
  /** Switchboard executor, called once per newly recorded row. */
  onRecorded?: (e: VolRegimeEvent) => Promise<void>;
}): Promise<number> {
  const { ledger } = deps;
  const now = deps.nowMs ?? Date.now();
  const slotOf = (m: SdkMarket) =>
    VOL_SLOTS.find((s) => m.expiryMs - now >= s.minMs && m.expiryMs - now <= s.maxMs);
  const due = (await listSdkMarkets()).filter((m) => {
    const s = slotOf(m);
    return m.referencePrice != null && !m.mintPaused && s && !ledger.hasEdgeProbe(m.id, 'vol_regime', s.slot);
  });
  if (!due.length) return 0;
  const { rv15, rv5 } = await realizedVol(now);
  if (rv15 == null) return 0;
  let recorded = 0;
  for (const m of due) {
    const slot = slotOf(m)!.slot;
    const [pricer, fees, board] = await Promise.all([
      resolvedPricer('BTC', m.expiryMs).catch(() => null),
      marketFeePolicy(m.id),
      boardPrice('BTC', m.expiryMs, 'reference'),
    ]);
    if (!pricer || !fees || !board) continue;
    const quotedAt = Date.now();
    const F = pricer.forward;
    // The SDK's exact float port of the chain's digital (skew-corrected).
    const up = (k: number) => sdkPricing.upProbability({ forward: F, svi: pricer.svi }, k);
    const reference = m.referencePrice!;
    const grid = m.admissionTickSize > 0 ? m.admissionTickSize : 1;
    const snap = (x: number) => Math.round(x / grid) * grid;
    const cand = (name: string, lower: number | null, upper: number | null, lowerUp: number | null, higherUp: number | null) => {
      const q = estimateBoundaryCost({ fees, expiryMs: m.expiryMs, nowMs: quotedAt, lowerUp, higherUp, quantity: 100 });
      return q ? { name, lower, upper, prob: Number(q.probability.toFixed(6)), cost: Number(q.costPerContract.toFixed(6)) } : null;
    };
    const candidates = [
      // Binaries use the board's own quote at the reference strike.
      cand('up', reference, null, board.up, null),
      cand('down', null, reference, null, board.up),
      ...WINDOW_WIDTHS.map((w) => {
        const lo = snap(F - w / 2);
        const hi = Math.max(lo + grid, snap(F + w / 2));
        return cand(`W${w}`, lo, hi, up(lo), up(hi));
      }),
    ].filter((c) => c != null);
    const payload: VolRegimePayload = {
      forward: F,
      reference,
      rv15,
      rv5,
      chainSdUsd: Number((F * Math.sqrt(Math.max(0, totalVariance(0, pricer.svi)))).toFixed(3)),
      candidates,
    };
    if (
      ledger.insertEdgeProbe({
        id: `vol:${m.id}:${slot}`,
        network: suiNetwork(),
        kind: 'vol_regime',
        marketId: m.id,
        slot,
        expiryMs: m.expiryMs,
        recordedAtMs: quotedAt,
        ttmMs: m.expiryMs - quotedAt,
        payload,
      })
    ) {
      recorded++;
      await deps
        .onRecorded?.({ market: m, slot, ttmMs: m.expiryMs - quotedAt, payload })
        .catch((e) =>
          log.warn('svx.edge.vol_exec_error', { err: e instanceof Error ? e.message : String(e) }),
        );
    }
  }
  if (recorded) log.info('svx.edge.vol_recorded', { rows: recorded });
  return recorded;
}

// ── 3. tail tracker ─────────────────────────────────────────────────────────
//
// Found 2026-09-28 on the wallet watch: three bots buying BOTH far-out sides
// (2–4¢) of 1m and 5m markets 1–2 minutes before expiry won 15–24% against
// 2–4% priced (+215% on ~$1.8k) the day BTC volatility came back after a
// quiet weekend — when realized movement ran far above what the chain
// priced. Around 21:00 that day new markets raised the entry floor from 1¢
// to 5¢ (admission band 5–95%) and the bots stopped: sub-5¢ tails can no
// longer be minted. This records, for every market at those checkpoints,
// the far up/down strikes the chain prices at 5–10¢ (all-in cost from the
// market's fee policy — ~9.5¢ for a 5¢ side near expiry) plus realized vs
// chain vol, so the switchboard can score "buy both 6¢ tails" (tail) and the
// same only when realized vol runs hot (tail_hot) before any money goes near
// it. Targets the market refuses are not recorded. Live trading
// additionally needs SVX_TAIL_LIVE=true.

export const TAIL_SLOTS: Array<{ slot: string; minMs: number; maxMs: number }> = [
  // W1/W3 buy at 119s left; 1m markets are already listed then.
  { slot: 't2m', minMs: 100_000, maxMs: 140_000 },
  // W2's median entry (71s), still before the final-minute fee ramp.
  { slot: 't70s', minMs: 61_000, maxMs: 85_000 },
];
// By the next morning some markets admitted only 10–90¢ per boundary, so
// the ladder runs up to 15¢ and the strategies take, per side, the cheapest
// rung the market actually admits (inadmissible rungs are never recorded).
export const TAIL_TARGETS = [0.05, 0.06, 0.08, 0.1, 0.12, 0.15];
/** Tail strategies skip sides dearer than this (the edge is in cheap tails). */
export const TAIL_MAX_TARGET = 0.15;
/** tail_hot trades only when realized vol (scaled) exceeds chain vol by this. */
export const TAIL_HOT_RATIO = 1.1;

export interface TailQuote {
  direction: 'up' | 'down';
  target: number;
  strike: number;
  /** Chain probability of the side paying. */
  prob: number;
  /** All-in cost per contract (premium + fees). */
  cost: number;
}

export interface TailPayload {
  forward: number;
  reference: number;
  rv15: number;
  rv5: number | null;
  /** Last 2 minutes / last hour of realized vol, $ per √s (rows from 2026-09-29). */
  rv2?: number | null;
  rv60?: number | null;
  chainSdUsd: number;
  quotes: TailQuote[];
}

export interface TailEvent {
  market: SdkMarket;
  slot: string;
  ttmMs: number;
  payload: TailPayload;
}

/**
 * The strike on `grid` whose side pays with probability closest to `target`,
 * searched outward from the forward (up: above it, down: below it).
 */
export function tailStrike(
  up: (k: number) => number,
  forward: number,
  direction: 'up' | 'down',
  target: number,
  grid: number,
  span: number,
): number | null {
  const side = (k: number) => (direction === 'up' ? up(k) : 1 - up(k));
  const sign = direction === 'up' ? 1 : -1;
  let near = 0;
  let far = span;
  if (!(side(forward + sign * far) < target)) return null;
  for (let i = 0; i < 40; i++) {
    const mid = (near + far) / 2;
    if (side(forward + sign * mid) > target) near = mid;
    else far = mid;
  }
  const k = Math.round((forward + sign * far) / grid) * grid;
  return k > 0 ? k : null;
}

export async function recordTail(deps: {
  ledger: LedgerStore;
  nowMs?: number;
  onRecorded?: (e: TailEvent) => Promise<void>;
}): Promise<number> {
  const { ledger } = deps;
  const now = deps.nowMs ?? Date.now();
  const slotOf = (m: SdkMarket) =>
    TAIL_SLOTS.find((s) => m.expiryMs - now >= s.minMs && m.expiryMs - now <= s.maxMs);
  const due = (await listSdkMarkets()).filter((m) => {
    const s = slotOf(m);
    // No reference needed: a 1m market is tradable ~2 min out, before its own
    // minute (and reference) starts — exactly when the tail bots buy.
    return !m.mintPaused && s && !ledger.hasEdgeProbe(m.id, 'tail', s.slot);
  });
  if (!due.length) return 0;
  const { rv15, rv5, rv2 } = await realizedVol(now);
  if (rv15 == null) return 0;
  const rv60 = await realizedVolHour(now);
  let recorded = 0;
  for (const m of due) {
    const slot = slotOf(m)!.slot;
    const [pricer, fees] = await Promise.all([
      resolvedPricer('BTC', m.expiryMs).catch(() => null),
      marketFeePolicy(m.id),
    ]);
    if (!pricer || !fees) continue;
    const quotedAt = Date.now();
    const F = pricer.forward;
    const up = (k: number) => sdkPricing.upProbability({ forward: F, svi: pricer.svi }, k);
    const grid = m.admissionTickSize > 0 ? m.admissionTickSize : 1;
    const chainSdUsd = Number((F * Math.sqrt(Math.max(0, totalVariance(0, pricer.svi)))).toFixed(3));
    const span = Math.max(50, 12 * chainSdUsd);
    const quotes: TailQuote[] = [];
    for (const direction of ['up', 'down'] as const) {
      for (const target of TAIL_TARGETS) {
        const strike = tailStrike(up, F, direction, target, grid, span);
        if (strike == null) continue;
        const u = up(strike);
        const q = estimateBoundaryCost({
          fees,
          expiryMs: m.expiryMs,
          nowMs: quotedAt,
          lowerUp: direction === 'up' ? u : null,
          higherUp: direction === 'up' ? null : u,
          quantity: 100,
        });
        if (!q) continue;
        quotes.push({
          direction,
          target,
          strike,
          prob: Number(q.probability.toFixed(6)),
          cost: Number(q.costPerContract.toFixed(6)),
        });
      }
    }
    if (!quotes.length) continue;
    const payload: TailPayload = { forward: F, reference: m.referencePrice ?? F, rv15, rv5, rv2, rv60, chainSdUsd, quotes };
    if (
      ledger.insertEdgeProbe({
        id: `tail:${m.id}:${slot}`,
        network: suiNetwork(),
        kind: 'tail',
        marketId: m.id,
        slot,
        expiryMs: m.expiryMs,
        recordedAtMs: quotedAt,
        ttmMs: m.expiryMs - quotedAt,
        payload,
      })
    ) {
      recorded++;
      await deps
        .onRecorded?.({ market: m, slot, ttmMs: m.expiryMs - quotedAt, payload })
        .catch((e) =>
          log.warn('svx.edge.tail_exec_error', { err: e instanceof Error ? e.message : String(e) }),
        );
    }
  }
  if (recorded) log.info('svx.edge.tail_recorded', { rows: recorded });
  return recorded;
}

/** The side of a tail quote, as an order range: up = (strike, ∞), down = (−∞, strike]. */
export const tailRange = (q: TailQuote): { lower: number | null; upper: number | null } =>
  q.direction === 'up' ? { lower: q.strike, upper: null } : { lower: null, upper: q.strike };

/**
 * What a tail strategy buys on one recorded row: on each side, the cheapest
 * rung the market admits (inside the bot's price band, at most
 * TAIL_MAX_TARGET); `tail_hot` only while realized vol runs hot against the
 * chain's.
 */
export function tailPicks(signal: TailSignal, p: TailPayload, ttmMs: number): TailQuote[] {
  if (signal === 'tail_hot') {
    const ratio = regimeRatio(p, ttmMs);
    if (ratio == null || ratio < TAIL_HOT_RATIO) return [];
  }
  if (signal === 'tail_burst') {
    const burst = burstRatio(p);
    if (burst == null || burst < TAIL_BURST_RATIO) return [];
  }
  const picks: TailQuote[] = [];
  for (const direction of ['up', 'down'] as const) {
    const cheapest = p.quotes
      .filter((q) => q.direction === direction && q.target <= TAIL_MAX_TARGET && inTradeBand(q.prob))
      .sort((a, b) => a.target - b.target)[0];
    if (cheapest) picks.push(cheapest);
  }
  return picks;
}

export type TailSignal = 'tail' | 'tail_hot' | 'tail_burst';

/**
 * Short-term vol against its own last hour. A sibling analysis of 3,085 fills
 * (2026-09-29) found moves past 2 chain-sd 19.7% of the time when the last
 * 2 minutes ran ≥ 1.2× the hour, vs 10% when calm (4.6% if the chain were
 * right): the fat tails concentrate in bursts. tail_burst is paper-only.
 */
export const TAIL_BURST_RATIO = 1.2;
export const burstRatio = (p: Pick<TailPayload, 'rv2' | 'rv60'>): number | null =>
  p.rv2 != null && p.rv60 != null && p.rv60 > 0 ? p.rv2 / p.rv60 : null;

/** Switchboard candidates `tail@<slot>`, `tail_hot@<slot>`, `tail_burst@<slot>`: each side is one decision. */
export function tailSwitchScores(rows: Array<EdgeProbeRow<TailPayload>>): ShadowSignalScore[] {
  const out: ShadowSignalScore[] = [];
  for (const s of TAIL_SLOTS) {
    for (const signal of ['tail', 'tail_hot', 'tail_burst'] as const) {
      const seq = rows
        .filter((r) => r.slot === s.slot)
        .flatMap((r) =>
          tailPicks(signal, r.payload, r.ttmMs).map((q) => {
            const { lower, upper } = tailRange(q);
            return { cost: q.cost, win: pays(lower, upper, r.settlementPrice), market: r.marketId, atMs: r.expiryMs };
          }),
        );
      const sc = sequenceScore(signal, s.slot, seq);
      if (sc) out.push(sc);
    }
  }
  return out;
}

export interface TailReport {
  rows: number;
  /** Per checkpoint × target: every side quoted, and the same split by vol regime. */
  bySlot: Array<{
    slot: string;
    target: number;
    all: Stat | null;
    hot: Stat | null;
    cool: Stat | null;
    avgDistanceUsd: number | null;
  }>;
}

export function scoreTail(rows: Array<EdgeProbeRow<TailPayload>>): TailReport {
  const bySlot: TailReport['bySlot'] = [];
  for (const s of TAIL_SLOTS) {
    for (const target of TAIL_TARGETS) {
      const pts: Array<{ prob: number; cost: number; win: boolean; hot: boolean; dist: number }> = [];
      for (const r of rows) {
        if (r.slot !== s.slot) continue;
        const ratio = regimeRatio(r.payload, r.ttmMs);
        for (const q of r.payload.quotes) {
          if (q.target !== target) continue;
          const { lower, upper } = tailRange(q);
          pts.push({
            prob: q.prob,
            cost: q.cost,
            win: pays(lower, upper, r.settlementPrice),
            hot: ratio != null && ratio >= TAIL_HOT_RATIO,
            dist: Math.abs(q.strike - r.payload.forward),
          });
        }
      }
      bySlot.push({
        slot: s.slot,
        target,
        all: stat(pts),
        hot: stat(pts.filter((x) => x.hot)),
        cool: stat(pts.filter((x) => !x.hot)),
        avgDistanceUsd: pts.length ? Number((pts.reduce((a, x) => a + x.dist, 0) / pts.length).toFixed(1)) : null,
      });
    }
  }
  return { rows: rows.length, bySlot };
}

/** Realized (scaled) over chain sd: < 1 means the chain expects more movement than recent history. */
export function regimeRatio(p: Pick<VolRegimePayload, 'rv15' | 'chainSdUsd'>, ttmMs: number): number | null {
  if (!(p.chainSdUsd > 0)) return null;
  return (RV_SCALE * p.rv15 * Math.sqrt(ttmMs / 1000)) / p.chainSdUsd;
}

const REGIMES = [
  { name: 'chain vol far above realized (<0.7)', max: 0.7 },
  { name: '0.7-0.9', max: 0.9 },
  { name: '0.9-1.1', max: 1.1 },
  { name: '1.1-1.4', max: 1.4 },
  { name: 'chain vol far below realized (>1.4)', max: Infinity },
];

/**
 * The model trader's pick: price every candidate off
 * N(forward, RV_SCALE·rv15·√T) and take the largest fair − all-in above
 * `minEdge`. Null when nothing clears it.
 */
export function volModelPick(
  p: VolRegimePayload,
  ttmMs: number,
  minEdge: number,
  /** Multiplier on the modelled sd (vol_clock passes the clock factor). */
  sdScale = 1,
): { candidate: VolCandidate; fair: number; edge: number } | null {
  const sd = RV_SCALE * p.rv15 * Math.sqrt(ttmMs / 1000) * sdScale;
  if (!(sd > 0)) return null;
  const cdf = (x: number | null, dflt: number) => (x == null ? dflt : normalCdf((x - p.forward) / sd));
  let best: { candidate: VolCandidate; fair: number; edge: number } | null = null;
  for (const c of p.candidates) {
    const fair = cdf(c.upper, 1) - cdf(c.lower, 0);
    const edge = fair - c.cost;
    if (edge > minEdge && (!best || edge > best.edge)) best = { candidate: c, fair, edge };
  }
  return best;
}

// ── clock wave ──────────────────────────────────────────────────────────────
//
// BTC 1s return variance by minute of the hour, relative to the mean, from
// 5.4 days of Binance 1s data (sibling analysis, 2026-09-29). The loudest
// stable feature: :57–:59 run ~0.5–0.65× and :00–:02 ~1.1–1.4× on most days
// (halves correlate 0.47 — real but noisy). vol_clock scales vol_model's sd
// by the square root of the mean multiplier over a market's remaining time.
export const MINUTE_OF_HOUR_VARIANCE = [
  1.25, 1.1, 1.39, 1.15, 1.2, 1.04, 1.28, 1.24, 1.03, 0.93, 1.03, 0.99, 0.85, 0.94, 1.02,
  1.29, 1.46, 1.18, 1.06, 0.93, 0.98, 1.13, 0.74, 0.96, 0.86, 0.88, 0.75, 0.77, 1.22, 0.8,
  1.42, 1.15, 1.18, 0.91, 1.05, 1.28, 0.91, 0.97, 1.12, 1.08, 0.88, 0.77, 0.69, 0.86, 0.82,
  0.87, 1.09, 1.09, 1.01, 1.44, 1.09, 0.88, 1.0, 0.95, 0.8, 0.77, 0.67, 0.65, 0.62, 0.49,
];

/** √(mean minute-of-hour variance multiplier over [fromMs, toMs)), by the second. */
export function clockSdFactor(fromMs: number, toMs: number): number {
  const a = Math.floor(fromMs / 1000);
  const b = Math.max(a + 1, Math.floor(toMs / 1000));
  let s = 0;
  for (let t = a; t < b; t++) s += MINUTE_OF_HOUR_VARIANCE[Math.floor(t / 60) % 60]!;
  return Math.sqrt(s / (b - a));
}

/** Minimum modelled edge for the switchboard's vol_model strategies. */
export const VOL_MODEL_MIN_EDGE = 0.03;

export interface VolRegimeReport {
  rows: number;
  /** Candidate × regime: does the regime predict mispricing after fees? */
  byRegime: Array<{ regime: string; candidates: Record<string, Stat | null> }>;
  /**
   * Model trader: price every candidate off N(forward, RV_SCALE·rv15·√T),
   * buy the one with the largest fair − all-in if it clears the threshold.
   * One pick per row.
   */
  modelTrader: Array<{ minEdge: number; slot: string; stat: Stat | null; picks: Record<string, number> }>;
}

export function scoreVolRegime(rows: Array<EdgeProbeRow<VolRegimePayload>>): VolRegimeReport {
  const names = ['up', 'down', ...WINDOW_WIDTHS.map((w) => `W${w}`)];
  const byRegime = REGIMES.map((g, i) => {
    const lo = i === 0 ? -Infinity : REGIMES[i - 1]!.max;
    const rs = rows.filter((r) => {
      const x = regimeRatio(r.payload, r.ttmMs);
      return x != null && x >= lo && x < g.max;
    });
    const candidates: Record<string, Stat | null> = {};
    for (const n of names) {
      candidates[n] = stat(
        rs.flatMap((r) =>
          r.payload.candidates
            .filter((c) => c.name === n)
            .map((c) => ({ prob: c.prob, cost: c.cost, win: pays(c.lower, c.upper, r.settlementPrice) })),
        ),
      );
    }
    return { regime: g.name, candidates };
  });
  const modelTrader: VolRegimeReport['modelTrader'] = [];
  for (const minEdge of [0.03, 0.06]) {
    for (const slot of ['all', ...VOL_SLOTS.map((s) => s.slot)]) {
      const picks: Record<string, number> = {};
      const xs: Array<{ prob: number; cost: number; win: boolean }> = [];
      for (const r of rows) {
        if (slot !== 'all' && r.slot !== slot) continue;
        const best = volModelPick(r.payload, r.ttmMs, minEdge);
        if (!best) continue;
        const c = best.candidate;
        picks[c.name] = (picks[c.name] ?? 0) + 1;
        xs.push({ prob: c.prob, cost: c.cost, win: pays(c.lower, c.upper, r.settlementPrice) });
      }
      modelTrader.push({ minEdge, slot, stat: stat(xs), picks });
    }
  }
  return { rows: rows.length, byRegime, modelTrader };
}

// ── switchboard scores ──────────────────────────────────────────────────────

/** The executors' entry band: Predict refuses below its 1% min; the auto
 *  executors keep to 2–97¢. Scores use the same band so they match trades. */
export const inTradeBand = (prob: number) => prob >= 0.02 && prob <= 0.97;

export function sequenceScore(
  signal: string,
  slot: string,
  seq: Array<{ cost: number; win: boolean; market?: string; atMs?: number }>,
): ShadowSignalScore | null {
  const n = seq.length;
  if (!n) return null;
  const pnls = seq.map((x) => (x.win ? 1 : 0) - x.cost);
  const mean = pnls.reduce((a, x) => a + x, 0) / n;
  const variance = n > 1 ? pnls.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0.25;
  const hitRate = seq.filter((x) => x.win).length / n;
  const tail = seq.slice(-20);
  let streak = 0;
  const last = tail[tail.length - 1]!.win;
  for (let i = tail.length - 1; i >= 0 && tail[i]!.win === last; i--) streak++;
  return {
    signal,
    slot,
    n,
    hitRate,
    noise: 2 * Math.sqrt(0.25 / n),
    avgCost: seq.reduce((a, x) => a + x.cost, 0) / n,
    pnlPerContract: mean,
    pnlStdErr: Math.sqrt(variance / n),
    recent: tail.slice(-10).map((x) => (x.win ? 1 : 0)),
    recentMarkets: tail.slice(-10).map((x) => x.market ?? ''),
    recentAtMs: tail.slice(-10).map((x) => x.atMs ?? 0),
    streak: last ? streak : -streak,
    recentPnl: tail.reduce((a, x) => a + (x.win ? 1 : 0) - x.cost, 0) / tail.length,
  };
}

/**
 * Switchboard candidates from the edge trackers, scored the way they would
 * trade: `binance_jump@jump` = the jump side at q2 (≈ when our mint lands),
 * first trigger per market; `vol_model@<slot>` = the model trader's pick.
 */
export function edgeSwitchScores(
  jumps: Array<EdgeProbeRow<JumpPayload>>,
  vols: Array<EdgeProbeRow<VolRegimePayload>>,
): ShadowSignalScore[] {
  const out: ShadowSignalScore[] = [];
  const seen = new Set<string>();
  const jumpSeq: Array<{ cost: number; win: boolean; market: string; atMs: number }> = [];
  for (const r of jumps) {
    if (seen.has(r.marketId)) continue;
    seen.add(r.marketId);
    const q = r.payload.q2;
    if (!q || q.cost == null) continue;
    const p = r.payload;
    const prob = p.side === 'up' ? q.up : 1 - q.up;
    if (!inTradeBand(prob)) continue;
    const win = p.side === 'up' ? r.settlementPrice > p.reference : r.settlementPrice <= p.reference;
    jumpSeq.push({ cost: q.cost, win, market: r.marketId, atMs: r.expiryMs });
  }
  const j = sequenceScore('binance_jump', 'jump', jumpSeq);
  if (j) out.push(j);
  for (const s of VOL_SLOTS) {
    // vol_model, and vol_clock: the same trader with its sd scaled by the
    // clock wave over the market's remaining time (paper-only).
    for (const signal of ['vol_model', 'vol_clock'] as const) {
      const seq = vols
        .filter((r) => r.slot === s.slot)
        .flatMap((r) => {
          const scale = signal === 'vol_clock' ? clockSdFactor(r.recordedAtMs, r.expiryMs) : 1;
          const best = volModelPick(r.payload, r.ttmMs, VOL_MODEL_MIN_EDGE, scale);
          if (!best || !inTradeBand(best.candidate.prob)) return [];
          const c = best.candidate;
          return [
            { cost: c.cost, win: pays(c.lower, c.upper, r.settlementPrice), market: r.marketId, atMs: r.expiryMs },
          ];
        });
      const v = sequenceScore(signal, s.slot, seq);
      if (v) out.push(v);
    }
  }
  return out;
}

// ── resolution ──────────────────────────────────────────────────────────────

export async function resolveEdgeProbes(deps: {
  predict: PredictReader;
  ledger: LedgerStore;
  nowMs?: number;
}): Promise<number> {
  const now = deps.nowMs ?? Date.now();
  let resolved = 0;
  for (const marketId of deps.ledger.unsettledEdgeProbeMarkets(now - 10_000)) {
    const snap = await deps.predict.snapshotOracle(marketId).catch(() => null);
    if (!snap?.isSettled || snap.settlementPrice == null) continue;
    resolved += deps.ledger.resolveEdgeProbeMarket(marketId, snap.settlementPrice, now);
  }
  if (resolved) log.info('svx.edge.resolved', { rows: resolved });
  deps.ledger.pruneEdgeProbes(now - 7 * 86_400_000, now);
  return resolved;
}
