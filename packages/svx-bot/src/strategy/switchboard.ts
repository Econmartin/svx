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

import type { LedgerStore } from '../ledger/store.js';
import { scoreShadowSignals } from '../ops/shadow-signals.js';
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
  dailyLossLimitUsd: 15,
} as const;

export type SwitchStatus = 'on' | 'off';

export interface SwitchEntry {
  key: string;
  signal: string;
  slot: string;
  n: number;
  pnlPerContract: number;
  /** Last up-to-10 shadow results, oldest first (1 won, 0 lost). */
  recent: number[];
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

/** Ledger strategy tag for a signal (fade variants keep their own page). */
export function strategyTagFor(signal: string): 'fade_spike' | 'auto_shadow' {
  return signal.startsWith('fade_spike') ? 'fade_spike' : 'auto_shadow';
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
  const scores = scoreShadowSignals(ledger.settledShadowDecisions(network, 0)).filter(
    (s) => s.slot !== 'all',
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
