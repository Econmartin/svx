import { describe, expect, it } from 'vitest';
import { decideHarvestV2, type HarvestV2Gates } from '../src/strategy/harvest-v2.js';
import type { OracleSnapshot } from 'svx-shared/types';

const NOW = 1_785_200_000_000;

const gates: HarvestV2Gates = {
  minTtmMs: 45_000,
  maxTtmMs: 150_000,
  minCostPrice: 0.6,
  maxCostPrice: 0.9,
  targetProb: 0.75,
  maxSnapshotAgeMs: 30_000,
  maxOpen: 10,
  dailyLossLimitDusdc: 20,
};

function snap(over: Partial<OracleSnapshot> = {}): OracleSnapshot {
  return {
    oracleId: 'mkt',
    underlyingAsset: 'BTC',
    expiryMs: NOW + 90_000,
    spot: 64_500,
    forward: 64_500,
    svi: { a: 2e-7, b: 1e-5, rho: -0.5, m: 0, sigma: 0.02 },
    timestampMs: NOW - 3_000,
    isSettled: false,
    ...over,
  };
}

const base = {
  nowMs: NOW,
  hasOpenForMarket: false,
  openStrategyCount: 0,
  dailyStrategyPnlUsdc: 0,
};

describe('harvest-v2 surface-only decision', () => {
  it('enters a favored strike inside the 60-90c band near the target', () => {
    const d = decideHarvestV2({ ...base, snap: snap() }, gates);
    expect(d.enter).toBe(true);
    expect(d.costPrice).toBeGreaterThanOrEqual(0.6);
    expect(d.costPrice).toBeLessThanOrEqual(0.9);
    expect(d.strike).toBeGreaterThan(0);
  });

  it('refuses outside the time window and on stale surfaces', () => {
    expect(
      decideHarvestV2({ ...base, snap: snap({ expiryMs: NOW + 600_000 }) }, gates).enter,
    ).toBe(false);
    expect(
      decideHarvestV2({ ...base, snap: snap({ timestampMs: NOW - 90_000 }) }, gates).enter,
    ).toBe(false);
  });

  it('respects dedupe, max-open and daily loss gates', () => {
    expect(decideHarvestV2({ ...base, snap: snap(), hasOpenForMarket: true }, gates).enter).toBe(
      false,
    );
    expect(decideHarvestV2({ ...base, snap: snap(), openStrategyCount: 10 }, gates).enter).toBe(
      false,
    );
    expect(
      decideHarvestV2({ ...base, snap: snap(), dailyStrategyPnlUsdc: -25 }, gates).enter,
    ).toBe(false);
  });
});
