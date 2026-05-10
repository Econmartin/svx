/**
 * Risk controls. Every gate is mandatory for live trading.
 *
 * Each rule returns `{ ok: true }` or `{ ok: false, reason }`. The first
 * failing rule short-circuits — order matters: cheapest checks first.
 */

import fs from 'node:fs';
import type { LedgerStore } from '../ledger/store.js';
import type { SvxConfig } from '../config.js';
import type { RiskDecision } from 'svx-shared/types';

export interface RiskInput {
  /** Proposed trade cost in dUSDC. */
  costUsdc: number;
  /** Strategy edge in prob points (used for sanity, not a gate). */
  edge: number;
  /** Currently open trade count. */
  openPositionCount: number;
  /** Realized + unrealized PnL over the last 24h. */
  rolling24hPnlUsdc: number;
  /** Bot NAV. */
  navUsdc: number;
}

export class RiskGate {
  private liveDailyLossLimitTriggered = false;
  private circuitBreakerTriggered = false;

  constructor(
    private readonly ledger: LedgerStore,
    private readonly cfg: SvxConfig,
    private readonly killFlagPath = '/tmp/svx-paused',
  ) {}

  pause(reason: string): void {
    this.ledger.setPause(true, reason);
  }

  resume(): void {
    this.liveDailyLossLimitTriggered = false;
    this.circuitBreakerTriggered = false;
    try {
      if (fs.existsSync(this.killFlagPath)) fs.rmSync(this.killFlagPath);
    } catch {
      /* ignore */
    }
    this.ledger.setPause(false);
  }

  isPaused(): { paused: boolean; reason?: string } {
    if (fs.existsSync(this.killFlagPath)) {
      return { paused: true, reason: 'manual kill flag' };
    }
    const state = this.ledger.getPause();
    return { paused: state.paused, reason: state.reason };
  }

  check(input: RiskInput): RiskDecision {
    const paused = this.isPaused();
    if (paused.paused) return { ok: false, reason: paused.reason ?? 'paused' };

    if (input.costUsdc > this.cfg.maxPositionDusdc * 2) {
      return { ok: false, reason: `cost ${input.costUsdc} exceeds 2× hard cap` };
    }

    if (input.costUsdc > input.navUsdc * this.cfg.maxPositionPct + 1e-6) {
      return { ok: false, reason: `cost ${input.costUsdc.toFixed(2)} > ${(this.cfg.maxPositionPct * 100).toFixed(1)}% of NAV` };
    }

    if (input.openPositionCount >= this.cfg.maxOpenPositions) {
      return { ok: false, reason: `${input.openPositionCount} open positions ≥ cap ${this.cfg.maxOpenPositions}` };
    }

    if (input.rolling24hPnlUsdc <= -this.cfg.dailyLossLimitDusdc) {
      this.liveDailyLossLimitTriggered = true;
      this.pause(`daily loss limit hit: ${input.rolling24hPnlUsdc.toFixed(2)} dUSDC`);
      return {
        ok: false,
        reason: `24h loss ${input.rolling24hPnlUsdc.toFixed(2)} ≤ −${this.cfg.dailyLossLimitDusdc}`,
      };
    }

    const losses = this.ledger.consecutiveLosses();
    if (losses >= this.cfg.circuitBreakerLosses) {
      this.circuitBreakerTriggered = true;
      this.pause(`circuit breaker: ${losses} consecutive losses`);
      return { ok: false, reason: `${losses} consecutive losses ≥ ${this.cfg.circuitBreakerLosses}` };
    }

    return { ok: true };
  }

  /**
   * Polymarket-leg risk gates. Separate from check() because the cost is in
   * pUSD (not dUSDC) and the open-position count is per-leg.
   *
   * Daily-PnL gate is intentionally omitted for now — Polymarket positions
   * settle via UMA hours after expiry, so we can't reliably compute realized
   * PnL until poly settlement is wired. Per-trade + concurrent caps bound the
   * worst-case exposure: maxPolyPositionUsdc * maxOpenPolyPositions.
   */
  checkPoly(input: { costUsdc: number; openPolyPositionCount: number }): RiskDecision {
    const paused = this.isPaused();
    if (paused.paused) return { ok: false, reason: paused.reason ?? 'paused' };

    if (input.costUsdc > this.cfg.maxPolyPositionUsdc + 1e-6) {
      return {
        ok: false,
        reason: `poly cost ${input.costUsdc.toFixed(2)} > cap ${this.cfg.maxPolyPositionUsdc}`,
      };
    }

    if (input.openPolyPositionCount >= this.cfg.maxOpenPolyPositions) {
      return {
        ok: false,
        reason: `${input.openPolyPositionCount} open poly positions ≥ cap ${this.cfg.maxOpenPolyPositions}`,
      };
    }

    return { ok: true };
  }
}
