/**
 * Margin-loop simulation — levered APY math on a synthetic but realistic
 * favored-side trade stream.
 */

import { describe, it, expect } from 'vitest';
import { computeMarginLoopSim } from '../src/ops/margin-loop-sim.js';

const DAY = 24 * 3600 * 1000;
const T0 = 1_700_000_000_000;

// 10 days, 2 trades/day, $5 cost, 1h hold, +$1 win / −$5 loss, 90% win.
const trades = Array.from({ length: 20 }, (_, i) => ({
  tsMs: T0 + Math.floor(i / 2) * DAY + (i % 2) * 3600_000 * 3,
  settledAtMs: T0 + Math.floor(i / 2) * DAY + (i % 2) * 3600_000 * 3 + 3600_000,
  costUsdc: 5,
  pnlUsdc: i % 10 === 9 ? -5 : 1,
}));

describe('computeMarginLoopSim', () => {
  it('derives the strategy leg from the trade stream', () => {
    const sim = computeMarginLoopSim(trades, { collateralUsdc: 100, ltv: 0.5, borrowApr: 0.1 });
    expect(sim.strategy.trades).toBe(20);
    expect(sim.strategy.win_rate).toBeCloseTo(0.9, 6);
    // total pnl = 18×1 − 2×5 = +8 over the window
    expect(sim.strategy.roi_per_trade).toBeCloseTo(8 / 100, 6);
    expect(sim.strategy.avg_hold_hours).toBeCloseTo(1, 6);
    expect(sim.strategy.daily_pnl_usdc).toBeGreaterThan(0);
  });

  it('caps funded PnL by what the signal flow can deploy', () => {
    // Typical exposure is tiny (2×$5 trades × 1h/day ≈ $0.42 average), so a
    // $50 borrow is mostly idle: utilization << 1, and levered APY is the
    // full strategy PnL minus interest on the WHOLE borrow.
    const sim = computeMarginLoopSim(trades, { collateralUsdc: 100, ltv: 0.5, borrowApr: 0.1 });
    expect(sim.loop.borrowed_usdc).toBe(50);
    expect(sim.loop.utilization).not.toBeNull();
    expect(sim.loop.utilization!).toBeLessThan(0.05);
    expect(sim.loop.interest_per_year_usdc).toBeCloseTo(5, 6);
    // funded pnl = full annual pnl (borrow > exposure) − $5 interest, over $100
    const annual = sim.strategy.annualized_pnl_usdc!;
    expect(sim.loop.levered_net_apy).toBeCloseTo((annual - 5) / 100, 3);
  });

  it('scales funded PnL down when the borrow is smaller than the exposure', () => {
    // Make exposure huge: 100 concurrent-ish long holds.
    const big = Array.from({ length: 40 }, (_, i) => ({
      tsMs: T0 + i * 3600_000,
      settledAtMs: T0 + i * 3600_000 + 5 * DAY,
      costUsdc: 50,
      pnlUsdc: 5,
    }));
    const sim = computeMarginLoopSim(big, { collateralUsdc: 100, ltv: 0.5, borrowApr: 0.1 });
    expect(sim.strategy.typical_open_exposure_usdc!).toBeGreaterThan(50);
    expect(sim.loop.utilization).toBe(1); // borrow fully deployed
    // funded < full annual pnl since borrow < exposure
    const fullApyOnCollateral =
      (sim.strategy.annualized_pnl_usdc! - sim.loop.interest_per_year_usdc) / 100;
    expect(sim.loop.levered_net_apy!).toBeLessThan(fullApyOnCollateral);
  });

  it('empty stream returns nulls, not NaNs', () => {
    const sim = computeMarginLoopSim([], { collateralUsdc: 100, ltv: 0.5, borrowApr: 0.1 });
    expect(sim.strategy.trades).toBe(0);
    expect(sim.loop.levered_net_apy).toBeNull();
    expect(sim.loop.utilization).toBeNull();
  });
});
