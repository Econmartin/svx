/**
 * Strategy switchboard — trade what the shadow tracker shows green, stop
 * what it shows red. No env switches: the rule lives here.
 *
 * Every shadow signal at every checkpoint is a candidate strategy ("buy the
 * side this signal picks, at the market's reference strike, at this
 * checkpoint"), scored exactly as the shadow scoreboard shows it, per $1
 * contract after fees.
 *
 * Audit 2026-09-28: ~150 signal×slot candidates are scored, so a bare
 * "average above +2¢" rule switched on whichever ones were lucky (with no
 * edge at all, some longshot slot turns green 97% of the time). Switching
 * now needs evidence:
 *
 *   ON    ≥ 50 paper decisions AND mean − 2·stderr > 0 (clearly positive),
 *         and the signal is not clearly losing pooled across all its slots
 *   OFF   too few decisions, mean ≤ 0, the signal is clearly losing overall,
 *         or its LIVE fills since switching on win so much less often than
 *         its paper record that luck can't explain it (binomial tail < 2.5%)
 *
 * The live check doubles as the long-shot stop: a 1-in-10 strategy is
 * judged on whether its losing run is implausible for its hit rate, not on
 * dollars lost. After a live-check switch-off a strategy must bank 50 fresh
 * paper decisions before it may switch on again.
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
  /** Paper decisions a strategy needs before it may switch ON. */
  minPaperTrades: 50,
  /** ON needs mean − onStdErrs·stderr above zero (profit per $1 contract). */
  onStdErrs: 2,
  /** Switch OFF at or below this mean (USD per contract). */
  offAtOrBelow: 0,
  /** A signal whose all-slots t-score is at or below this can't switch on. */
  pooledVetoT: -2,
  /** Live wins this improbable given the paper hit rate → OFF. */
  liveCheckAlpha: 0.025,
  /** Fresh paper decisions needed after a live-check switch-off. */
  relearnTrades: 50,
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
  /** Per strategy line (e.g. fade_spike@t50s): stop it for the day at −$15.
   *  Long-shot clips are exempt — they are judged by the live check. */
  lineDailyLossLimitUsd: 15,
  /** Whole-bank backstop over every switchboard line, long shots included.
   *  User-raised 2026-09-27 from $30 (a fade-spike day had tripped it while
   *  harvest and vol_model were up). */
  accountDailyLossLimitUsd: 60,
} as const;

/** Is a clip at this all-in cost per contract a long shot? */
export const isLongshot = (costPerContract: number) =>
  costPerContract <= SWITCHBOARD.longshotMaxCostPerContract;

/**
 * Why a new clip for strategy `key` must stand down, or null to go ahead.
 * The account stop covers everything; the per-line $15 stop skips long
 * shots, whose losing runs are expected and are policed statistically.
 */
export function strategyStop(
  ledger: LedgerStore,
  nowMs: number,
  key: string,
  costPerContract: number,
): 'account_daily_loss_limit' | 'line_daily_loss_limit' | null {
  if (switchboardRealized24h(ledger, nowMs) <= -SWITCHBOARD.accountDailyLossLimitUsd) {
    return 'account_daily_loss_limit';
  }
  if (isLongshot(costPerContract)) return null;
  const since = nowMs - 24 * 3600_000;
  const line =
    key === HARVEST_KEY
      ? ledger.realizedSignalPnlSince('harvest_v2', since, 'live')
      : ledger.realizedSignalPnlSince(key, since);
  return line <= -SWITCHBOARD.lineDailyLossLimitUsd ? 'line_daily_loss_limit' : null;
}

/** P(X ≤ wins) for X ~ Binomial(n, p). */
export function binomialLowerTail(n: number, wins: number, p: number): number {
  if (wins >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return wins >= n ? 1 : 0;
  let pmf = (1 - p) ** n; // P(X = 0)
  let cdf = pmf;
  for (let k = 1; k <= wins; k++) {
    pmf *= ((n - k + 1) / k) * (p / (1 - p));
    cdf += pmf;
  }
  return Math.min(1, cdf);
}

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
  /** Per `recent` result: when it was known (0 = unknown). */
  recentAtMs?: number[];
  /** +n wins / −n losses in a row, most recent. */
  streak: number;
  /** Average profit per contract over the last up-to-20 decisions. */
  recentPnl: number;
  status: SwitchStatus;
  /** When the current status began. */
  sinceMs: number;
  /** Why it is on or off, in words (audit 2026-09-28). */
  reason?: string;
  /** Paper hit rate when it last switched on — what live fills must match. */
  onHitRate?: number;
  /** Live settled clips / wins since it last switched on. */
  liveN?: number;
  liveWins?: number;
  /** Paper decision count when the live check switched it off. */
  blockedAtN?: number;
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

function scoreAll(inp: SwitchInputs): ShadowSignalScore[] {
  const scores: ShadowSignalScore[] = [
    ...scoreShadowSignals(inp.shadow).filter((s) => s.slot !== 'all'),
    // Edge trackers (ops/edge-trackers.ts): the Binance-jump and vol-model
    // strategies, on the same on/off rule.
    ...edgeSwitchScores(inp.jumps, inp.vols),
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
  const switchInputsCache = switchInputs(ledger, network);
  const scores = scoreAll(switchInputsCache);
  // Which (strategy, market) pairs we actually traded live — the rings on
  // the switchboard's result dots.
  const liveStart = ledger.firstLivePredictTradeMs();
  const traded = new Set(
    liveStart == null
      ? []
      : ledger.livePredictTradesSince(liveStart).map((t) => `${t.signalId}|${t.oracleId}`),
  );
  // Pooled (all-slots) scores: a signal clearly losing overall can't switch on.
  const pooled = new Map(
    scoreShadowSignals(switchInputsCache.shadow)
      .filter((s) => s.slot === 'all')
      .map((s) => [s.signal, s]),
  );
  const liveTrades = liveStart == null ? [] : ledger.livePredictTradesSince(liveStart);
  const entries: SwitchEntry[] = scores.map((s) => {
    const key = `${s.signal}@${s.slot}`;
    const before = prev.get(key);
    const tradeKey = s.signal === 'harvest_v2' ? 'harvest_v2' : key;
    const pool = pooled.get(s.signal);
    const vetoed =
      !!pool && pool.pnlStdErr > 0 && pool.pnlPerContract / pool.pnlStdErr <= SWITCHBOARD.pooledVetoT;
    const lowerBound = s.pnlPerContract - SWITCHBOARD.onStdErrs * s.pnlStdErr;
    const relearning =
      before?.blockedAtN != null && s.n < before.blockedAtN + SWITCHBOARD.relearnTrades;

    let status: SwitchStatus;
    let reason: string;
    let blockedAtN = relearning ? before?.blockedAtN : undefined;
    let liveN: number | undefined;
    let liveWins: number | undefined;
    const onHitRate = before?.status === 'on' ? (before.onHitRate ?? s.hitRate) : s.hitRate;

    if (before?.status === 'on') {
      // Live fills since it switched on, judged against its paper hit rate.
      const fills = liveTrades.filter(
        (t) => t.signalId === tradeKey && t.settled && t.timestampMs >= before.sinceMs && t.quantityDusdc > 0,
      );
      liveN = fills.length;
      liveWins = fills.filter((t) => (t.payoutUsdc ?? 0) > 0).length;
      const tail = liveN ? binomialLowerTail(liveN, liveWins, onHitRate) : 1;
      if (s.n < SWITCHBOARD.minPaperTrades) {
        status = 'off';
        reason = `only ${s.n} paper decisions (needs ${SWITCHBOARD.minPaperTrades})`;
      } else if (s.pnlPerContract <= SWITCHBOARD.offAtOrBelow) {
        status = 'off';
        reason = 'average profit turned red';
      } else if (vetoed) {
        status = 'off';
        reason = 'signal clearly losing across all slots';
      } else if (tail < SWITCHBOARD.liveCheckAlpha) {
        status = 'off';
        blockedAtN = s.n;
        reason = `live ${liveWins}/${liveN} wins vs ${(onHitRate * 100).toFixed(0)}% on paper (p=${tail.toFixed(3)})`;
      } else {
        status = 'on';
        reason = 'holding: still profitable, live fills consistent';
      }
    } else if (s.n < SWITCHBOARD.minPaperTrades) {
      status = 'off';
      reason = `only ${s.n} paper decisions (needs ${SWITCHBOARD.minPaperTrades})`;
    } else if (relearning) {
      status = 'off';
      reason = `relearning after live check: ${s.n - before!.blockedAtN!}/${SWITCHBOARD.relearnTrades} fresh decisions`;
    } else if (vetoed) {
      status = 'off';
      reason = 'signal clearly losing across all slots';
    } else if (lowerBound <= 0) {
      status = 'off';
      reason = 'not clearly profitable yet (mean − 2·stderr ≤ 0)';
    } else {
      status = 'on';
      reason = 'clearly profitable on paper';
    }

    if (before && before.status !== status) {
      log.info('svx.switchboard.switch', {
        strategy: key,
        to: status,
        n: s.n,
        pnlPerContract: Number(s.pnlPerContract.toFixed(4)),
        reason,
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
      recentAtMs: s.recentAtMs ?? [],
      streak: s.streak,
      recentPnl: s.recentPnl,
      status,
      sinceMs: before && before.status === status ? before.sinceMs : nowMs,
      reason,
      onHitRate: status === 'on' ? onHitRate : undefined,
      liveN,
      liveWins,
      blockedAtN,
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
