/**
 * Strategy switchboard — trade what the shadow tracker shows green, stop
 * what it shows red. No env switches: the rule lives here.
 *
 * Every shadow signal at every checkpoint is a candidate strategy ("buy the
 * side this signal picks, at the market's reference strike, at this
 * checkpoint"), scored exactly as the shadow scoreboard shows it:
 *
 *   ON   when its profit per $1 contract (after fees) is above +2¢
 *   OFF  when it falls to zero or below
 *
 * Between 0 and +2¢ a strategy keeps whatever state it had: it needs a
 * clear margin to switch on, then trades until it is actually losing. This
 * stops strategies hovering around zero from flicking on after one lucky
 * decision (taker_flow, 2026-09-26: on at +0.2¢, two losses, off again).
 *
 * Re-scored every few minutes, so a strategy switches off as soon as its
 * average turns red and back on when it turns green again. Every
 * switched-on strategy shares one risk budget (below).
 */

import type { EdgeProbeRow, LedgerStore, ShadowDecisionRow } from '../ledger/store.js';
import { scoreShadowSignals } from '../ops/shadow-signals.js';
import {
  edgeSwitchScores,
  type JumpPayload,
  type VolRegimePayload,
} from '../ops/edge-trackers.js';
import { sequenceScore } from '../ops/edge-trackers.js';
import type { ShadowSignalScore } from '../ops/shadow-signals.js';
import { log } from '../util/log.js';

export const SWITCHBOARD = {
  reevaluateMs: 5 * 60_000,
  /** Profit per $1 contract needed to switch ON (USD). */
  onAbove: 0.02,
  /** Switch OFF at or below this (USD per contract). */
  offAtOrBelow: 0,
  // Per-trade size cap and a daily loss stop; no cap on how many strategies,
  // positions or trades run — every green strategy trades every signal.
  maxCostUsd: 2.5,
  // Long-shots (all-in ≤ 12¢ per contract) get a bigger cap: Predict's $1
  // minimum premium means a 2¢ contract needs ~56 contracts ≈ $3.40 all-in,
  // so under $2.50 the cheapest far sides — the best bucket on the launch
  // tape — could never be bought. User-approved 2026-09-27.
  maxLongshotCostUsd: 4,
  longshotMaxCostPerContract: 0.12,
  // Harvest v2 buys its usual 5-contract clip (~$4.30 at ~86¢ all-in), the
  // same size as the paper trades its score comes from. User-approved
  // 2026-09-27: up to $5 per harvest trade.
  maxHarvestCostUsd: 5,
  dailyLossLimitUsd: 15,
} as const;

/**
 * Realized PnL over the last 24h that counts against the shared daily stop:
 * every switchboard strategy, plus harvest v2's LIVE trades only (its paper
 * clips run all the time and must not trip the stop).
 */
export function switchboardRealized24h(ledger: LedgerStore, nowMs: number): number {
  const since = nowMs - 24 * 3600_000;
  return (
    ['fade_spike', 'auto_shadow', 'edge_jump', 'edge_vol'].reduce(
      (a, st) => a + ledger.realizedStrategyPnlSince(st, since),
      0,
    ) + ledger.realizedStrategyPnlSince('calibration_harvest', since, 'live')
  );
}

/** Per-trade cap for a clip at this all-in cost per contract. */
export function clipCapUsd(costPerContract: number): number {
  return costPerContract <= SWITCHBOARD.longshotMaxCostPerContract
    ? SWITCHBOARD.maxLongshotCostUsd
    : SWITCHBOARD.maxCostUsd;
}

export type SwitchStatus = 'on' | 'off';

export interface SwitchEntry {
  key: string;
  signal: string;
  slot: string;
  n: number;
  pnlPerContract: number;
  /** Last up-to-10 shadow results, oldest first (1 won, 0 lost). */
  recent: number[];
  /** Per `recent` result: 1 when we traded it live, 0 when we did not. */
  recentCaptured?: number[];
  /** The last 24h in BAND_COUNT bands of BAND_MS, oldest first: wins and
   *  losses we did not trade (w, l) and did trade live (tw, tl). */
  bands?: Array<{ w: number; l: number; tw: number; tl: number }>;
  /** +n wins / −n losses in a row, most recent. */
  streak: number;
  /** Average profit per contract over the last up-to-20 decisions. */
  recentPnl: number;
  status: SwitchStatus;
  /** When the current status began. */
  sinceMs: number;
}

const META_KEY = 'switchboard_v1';
let cache: { atMs: number; entries: SwitchEntry[] } | null = null;

/** Harvest v2 (buy the 60–90¢ favourite 45–150s out) on the switchboard. It
 *  is scored on its own trades since live mainnet trading began — paper
 *  while it's off, live once on — per $1 contract after fees. */
export const HARVEST_KEY = 'harvest_v2@harvest';

/** Ledger strategy tag for a signal (fade variants keep their own page). */
export function strategyTagFor(
  signal: string,
): 'fade_spike' | 'auto_shadow' | 'edge_jump' | 'edge_vol' | 'calibration_harvest' {
  if (signal === 'harvest_v2') return 'calibration_harvest';
  if (signal === 'binance_jump') return 'edge_jump';
  if (signal === 'vol_model') return 'edge_vol';
  return signal.startsWith('fade_spike') ? 'fade_spike' : 'auto_shadow';
}

/** Everything the switchboard scores, as raw settled rows. */
interface SwitchInputs {
  shadow: ShadowDecisionRow[];
  jumps: Array<EdgeProbeRow<JumpPayload>>;
  vols: Array<EdgeProbeRow<VolRegimePayload>>;
  harvest: ReturnType<LedgerStore['settledStrategyTradesSince']>;
}

function switchInputs(ledger: LedgerStore, network: string): SwitchInputs {
  const liveStart = ledger.firstLivePredictTradeMs();
  return {
    shadow: ledger.settledShadowDecisions(network, 0),
    jumps: ledger.settledEdgeProbes<JumpPayload>(network, 'jump', 0),
    vols: ledger.settledEdgeProbes<VolRegimePayload>(network, 'vol_regime', 0),
    harvest:
      liveStart == null ? [] : ledger.settledStrategyTradesSince('calibration_harvest', liveStart),
  };
}

export const BAND_MS = 4 * 3600_000;
export const BAND_COUNT = 6;

function scoreAll(inp: SwitchInputs, timelineSinceMs?: number): ShadowSignalScore[] {
  const scores: ShadowSignalScore[] = [
    ...scoreShadowSignals(inp.shadow, timelineSinceMs).filter((s) => s.slot !== 'all'),
    // Edge trackers (ops/edge-trackers.ts): the Binance-jump and vol-model
    // strategies, on the same on/off rule.
    ...edgeSwitchScores(inp.jumps, inp.vols, timelineSinceMs),
  ];
  const harvest = sequenceScore(
    'harvest_v2',
    'harvest',
    inp.harvest
      .filter((t) => t.quantity > 0)
      .map((t) => ({
        cost: t.costUsdc / t.quantity,
        win: t.payoutUsdc > 0,
        market: t.oracleId,
        atMs: t.settledAtMs ?? t.tsMs,
      })),
    timelineSinceMs,
  );
  if (harvest) scores.push(harvest);
  return scores;
}

/**
 * The switchboard's profit per contract for `key` as it stood at `atMs`,
 * rebuilt from only the rows settled by then. Used to stamp the expected
 * edge on live trades placed before trades carried it (bank gauge).
 */
export function scoreAsOf(inp: SwitchInputs, key: string, atMs: number): number | null {
  const s = scoreAll({
    shadow: inp.shadow.filter((r) => (r.expiryMs ?? Infinity) <= atMs),
    jumps: inp.jumps.filter((r) => r.expiryMs <= atMs),
    vols: inp.vols.filter((r) => r.expiryMs <= atMs),
    harvest: inp.harvest.filter((t) => (t.settledAtMs ?? Infinity) <= atMs),
  }).find((x) => `${x.signal}@${x.slot}` === key);
  return s ? s.pnlPerContract : null;
}

/**
 * One-shot: stamp live switchboard trades that predate `edgeAtExec` with the
 * score their strategy had when they were placed.
 */
export function backfillEntryEdges(ledger: LedgerStore, network: string): number {
  const MARKER = 'bank_gauge_edge_backfill_v1';
  if (ledger.getMeta(MARKER) !== undefined) return 0;
  const inp = switchInputs(ledger, network);
  let n = 0;
  for (const t of ledger.livePredictTradesSince(0)) {
    if (t.edgeAtExec != null) continue;
    const key =
      t.strategy === 'calibration_harvest'
        ? t.signalId === 'harvest_v2'
          ? HARVEST_KEY
          : null
        : t.signalId.includes('@') && strategyTagFor(t.signalId.split('@')[0]!) === t.strategy
          ? t.signalId
          : null;
    if (!key) continue;
    const edge = scoreAsOf(inp, key, t.timestampMs);
    if (edge == null) continue;
    ledger.setTradeEdge(t.id, edge);
    n++;
  }
  ledger.setMeta(MARKER, String(Date.now()));
  log.info('svx.switchboard.edge_backfill', { stamped: n });
  return n;
}

/** Re-score and update switch states (at most every reevaluateMs). */
export function evaluateSwitchboard(
  ledger: LedgerStore,
  network: string,
  nowMs = Date.now(),
  force = false,
): SwitchEntry[] {
  if (!force && cache && nowMs - cache.atMs < SWITCHBOARD.reevaluateMs) return cache.entries;
  const prev = new Map<string, SwitchEntry>();
  try {
    const raw = ledger.getMeta(META_KEY);
    for (const e of raw ? (JSON.parse(raw) as SwitchEntry[]) : []) prev.set(e.key, e);
  } catch {
    /* start fresh */
  }
  const bandsStart = nowMs - BAND_COUNT * BAND_MS;
  const scores = scoreAll(switchInputs(ledger, network), bandsStart);
  // Which (strategy, market) pairs we actually traded live — the rings on
  // the switchboard's result dots.
  const liveStart = ledger.firstLivePredictTradeMs();
  const traded = new Set(
    liveStart == null
      ? []
      : ledger.livePredictTradesSince(liveStart).map((t) => `${t.signalId}|${t.oracleId}`),
  );
  const entries: SwitchEntry[] = scores.map((s) => {
    const key = `${s.signal}@${s.slot}`;
    const before = prev.get(key);
    const status: SwitchStatus =
      before?.status === 'on'
        ? s.pnlPerContract > SWITCHBOARD.offAtOrBelow
          ? 'on'
          : 'off'
        : s.pnlPerContract > SWITCHBOARD.onAbove
          ? 'on'
          : 'off';
    if (before && before.status !== status) {
      log.info('svx.switchboard.switch', {
        strategy: key,
        to: status,
        n: s.n,
        pnlPerContract: Number(s.pnlPerContract.toFixed(4)),
      });
    }
    return {
      key,
      signal: s.signal,
      slot: s.slot,
      n: s.n,
      pnlPerContract: s.pnlPerContract,
      recent: s.recent,
      recentCaptured: (s.recentMarkets ?? []).map((m) =>
        traded.has(`${s.signal === 'harvest_v2' ? 'harvest_v2' : key}|${m}`) ? 1 : 0,
      ),
      bands: (() => {
        const b = Array.from({ length: BAND_COUNT }, () => ({ w: 0, l: 0, tw: 0, tl: 0 }));
        for (const x of s.timeline ?? []) {
          const i = Math.min(BAND_COUNT - 1, Math.floor((x.atMs - bandsStart) / BAND_MS));
          if (i < 0) continue;
          const hit = traded.has(`${s.signal === 'harvest_v2' ? 'harvest_v2' : key}|${x.market}`);
          const band = b[i]!;
          if (x.won && hit) band.tw++;
          else if (x.won) band.w++;
          else if (hit) band.tl++;
          else band.l++;
        }
        return b;
      })(),
      streak: s.streak,
      recentPnl: s.recentPnl,
      status,
      sinceMs: before && before.status === status ? before.sinceMs : nowMs,
    };
  });
  entries.sort((a, b) => b.pnlPerContract - a.pnlPerContract);
  ledger.setMeta(META_KEY, JSON.stringify(entries));
  cache = { atMs: nowMs, entries };
  return entries;
}

/** Switched-on strategies for one checkpoint, most profitable first. */
export function enabledAt(entries: SwitchEntry[], slot: string): SwitchEntry[] {
  return entries.filter((e) => e.status === 'on' && e.slot === slot);
}
