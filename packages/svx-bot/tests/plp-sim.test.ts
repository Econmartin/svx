/**
 * PLP + tail-hedge simulation — share-price APY from LP events, insurance
 * drag from surface-priced crash binaries settled against real outcomes.
 */

import { describe, it, expect } from 'vitest';
import { computePlpSim } from '../src/ops/plp-sim.js';

const YEAR = 365.25 * 24 * 3600 * 1000;
const T0 = 1_700_000_000_000;
// Flat surface: w(k) = 0.0004 → σ_atm√T price move = 2% of F.
const FLAT = { a: 0.0004, b: 0, rho: 0, m: 0, sigma: 0.1 };

const oracle = (settle: number, id = 'o1') => ({
  oracleId: id,
  tsMs: T0,
  expiryMs: T0 + 3600_000, // 1h cycle
  forward: 60_000,
  svi: FLAT,
  settlementPrice: settle,
});

describe('computePlpSim', () => {
  it('derives realized APY from the share-price series', () => {
    // Share price 1.00 → 1.01 over half a year → APY ≈ 2%.
    const sim = computePlpSim(
      [
        { tsMs: T0, amount: 100, shares: 100 },
        { tsMs: T0 + YEAR / 2, amount: 101, shares: 100 },
      ],
      [],
      [],
      { hedgeZ: 2, coverageFrac: 0.5, fee: 0 },
    );
    expect(sim.plp.realized_apy).toBeCloseTo(0.02, 3);
    expect(sim.plp.share_price_first).toBeCloseTo(1.0, 6);
    expect(sim.plp.share_price_last).toBeCloseTo(1.01, 6);
  });

  it('prices the crash binary off the surface and nets realized payouts', () => {
    // 2σ crash strike = F·(1 − 0.04) = 57,600. One quiet cycle (no crash),
    // one crash cycle (settles below the strike → insurance pays).
    const sim = computePlpSim(
      [
        { tsMs: T0, amount: 100, shares: 100 },
        { tsMs: T0 + YEAR, amount: 100, shares: 100 },
      ],
      [],
      [oracle(60_100, 'quiet'), oracle(57_000, 'crash')],
      { hedgeZ: 2, coverageFrac: 1, fee: 0 },
    );
    expect(sim.hedge.oracles_priced).toBe(2);
    expect(sim.hedge.crash_hits).toBe(1);
    expect(sim.hedge.crash_hit_rate).toBeCloseTo(0.5, 6);
    // 2σ down-binary premium ≈ Φ(−2) ≈ 2.2% per cycle; hit rate 50% swamps
    // it → net drag is NEGATIVE (insurance was underpriced in this toy set).
    expect(sim.hedge.avg_premium_frac!).toBeGreaterThan(0.01);
    expect(sim.hedge.avg_premium_frac!).toBeLessThan(0.04);
    expect(sim.hedge.annualized_drag_frac!).toBeLessThan(0);
    expect(sim.net_apy).toBeCloseTo(0 - sim.hedge.annualized_drag_frac!, 3);
  });

  it('handles empty inputs without dividing by zero', () => {
    const sim = computePlpSim([], [], [], { hedgeZ: 2, coverageFrac: 0.5, fee: 0.02 });
    expect(sim.plp.realized_apy).toBeNull();
    expect(sim.hedge.annualized_drag_frac).toBeNull();
    expect(sim.net_apy).toBeNull();
  });
});
