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
   * Daily-PnL gate (`dailyPolyLossLimitUsdc`) became active once the
   * settlement-poll loop started populating `poly_pnl_usdc`. Pauses the bot
   * via the shared pause flag — same auto-pause UX as the dUSDC limit.
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

    const polyPnl24h = this.ledger.realizedPolyPnlSince(Date.now() - 24 * 3600_000);
    if (polyPnl24h <= -this.cfg.dailyPolyLossLimitUsdc) {
      this.pause(`daily poly loss limit hit: ${polyPnl24h.toFixed(2)} pUSD`);
      return {
        ok: false,
        reason: `24h poly loss ${polyPnl24h.toFixed(2)} ≤ −${this.cfg.dailyPolyLossLimitUsdc}`,
      };
    }

    return { ok: true };
  }

  /**
   * Hyperliquid hedge risk gate. Enforced before every HL order open.
   *
   * The caller passes the proposed hedge's USD notional and the current
   * total HL exposure (read from the ledger). Three gates layered:
   *   1. Per-trade USD cap (`maxHlPerTradeUsdc`)
   *   2. Total open exposure cap (`maxHlOpenUsdc`)
   *   3. 24h realized HL PnL ≤ -`dailyHlLossLimitUsdc` → auto-pause
   *
   * The pause flag is the SAME flag used by the dUSDC / pUSD gates, so a
   * daily-loss breach on any leg pauses everything together — the operator
   * resumes via the same `svx resume` command.
   */
  checkHl(input: {
    notionalUsdc: number;
    openHlExposureUsdc: number;
  }): RiskDecision {
    const paused = this.isPaused();
    if (paused.paused) return { ok: false, reason: paused.reason ?? 'paused' };

    if (input.notionalUsdc > this.cfg.maxHlPerTradeUsdc + 1e-6) {
      return {
        ok: false,
        reason: `hl notional ${input.notionalUsdc.toFixed(2)} > per-trade cap ${this.cfg.maxHlPerTradeUsdc}`,
      };
    }

    const totalExposureAfter = input.openHlExposureUsdc + input.notionalUsdc;
    if (totalExposureAfter > this.cfg.maxHlOpenUsdc + 1e-6) {
      return {
        ok: false,
        reason: `hl total exposure ${totalExposureAfter.toFixed(2)} > cap ${this.cfg.maxHlOpenUsdc}`,
      };
    }

    const hlPnl24h = this.ledger.realizedHlPnlSince(Date.now() - 24 * 3600_000);
    if (hlPnl24h <= -this.cfg.dailyHlLossLimitUsdc) {
      this.pause(`daily HL loss limit hit: ${hlPnl24h.toFixed(2)} USDC`);
      return {
        ok: false,
        reason: `24h HL loss ${hlPnl24h.toFixed(2)} ≤ −${this.cfg.dailyHlLossLimitUsdc}`,
      };
    }

    return { ok: true };
  }
}
