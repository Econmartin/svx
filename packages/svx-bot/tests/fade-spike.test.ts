import { describe, expect, it } from 'vitest';
import {
  fadeSpikeQuantity,
  fadeSpikeSettings,
  fadeSpikeSide,
  fadeSpikeWhyNot,
} from '../src/strategy/fade-spike.js';

describe('fadeSpikeSide', () => {
  const base = { ttmMs: 30_000, binVsRef: 30, mom30s: 0.0004, boardUp: 0.85 };

  it('buys the cheap far side after a spike away from the strike', () => {
    expect(fadeSpikeSide(base, 20, 0.3)).toBe('down');
    expect(fadeSpikeSide({ ...base, binVsRef: -30, mom30s: -0.0004, boardUp: 0.15 }, 20, 0.3)).toBe('up');
  });

  it('abstains outside the pattern', () => {
    expect(fadeSpikeSide({ ...base, ttmMs: 90_000 }, 20, 0.3)).toBeNull(); // not last minute
    expect(fadeSpikeSide({ ...base, binVsRef: 10 }, 20, 0.3)).toBeNull(); // too close
    expect(fadeSpikeSide({ ...base, mom30s: -0.0004 }, 20, 0.3)).toBeNull(); // moving back already
    expect(fadeSpikeSide({ ...base, boardUp: 0.6 }, 20, 0.3)).toBeNull(); // far side not cheap
    expect(fadeSpikeSide({ ...base, mom30s: null as never }, 20, 0.3)).toBeNull();
    expect(fadeSpikeSide({ ...base, boardUp: 0.995 }, 20, 0.3)).toBeNull(); // below the 1% entry floor
  });
});

describe('fadeSpikeQuantity', () => {
  it('sizes the smallest clip that clears the $1 minimum premium with headroom', () => {
    const q = fadeSpikeQuantity(0.1, 0.16, 2.5)!;
    expect(q * 0.1).toBeGreaterThanOrEqual(1.12 - 1e-9);
    expect(q * 0.16).toBeLessThanOrEqual(2.5);
    expect(Math.round(q * 100)).toBe(q * 100); // $0.01 payout lots
  });

  it('refuses when the clip would exceed the cost cap', () => {
    // 2c contracts need ~$56 payout for $1 premium; at 7c all-in that is ~$3.92.
    expect(fadeSpikeQuantity(0.02, 0.07, 2.5)).toBeNull();
  });
});

describe('fadeSpikeSettings', () => {
  it('is paper-on, live-off by default', () => {
    const s = fadeSpikeSettings({});
    expect(s.enabled).toBe(true);
    expect(s.live).toBe(false);
    expect(s.maxCostUsd).toBe(2.5);
    expect(s.dailyLossLimitUsd).toBe(15);
  });

  it('reads overrides and treats empty strings as unset', () => {
    const s = fadeSpikeSettings({
      SVX_FADE_SPIKE_LIVE: 'true',
      SVX_FADE_SPIKE_MAX_COST_USD: '1.5',
      SVX_FADE_SPIKE_DAILY_LOSS_USD: '',
    });
    expect(s.live).toBe(true);
    expect(s.maxCostUsd).toBe(1.5);
    expect(s.dailyLossLimitUsd).toBe(15);
  });
});

describe('fadeSpikeWhyNot', () => {
  it('explains a miss exactly when the rule does not fire', () => {
    const grid = [];
    for (const ttmMs of [30_000, 90_000])
      for (const binVsRef of [-45, -25, -5, 5, 25, 45])
        for (const mom30s of [-0.0004, 0.0004])
          for (const boardUp of [0.005, 0.1, 0.5, 0.9, 0.995])
            grid.push({ ttmMs, binVsRef, mom30s, boardUp });
    for (const r of grid) {
      const fires = fadeSpikeSide(r, 20, 0.3) != null;
      expect(fadeSpikeWhyNot(r, 20, 0.3) == null).toBe(fires);
    }
  });

  it('names the failing condition in plain words', () => {
    const base = { ttmMs: 30_000, binVsRef: 30, mom30s: 0.0004, boardUp: 0.985 };
    expect(fadeSpikeWhyNot(base, 20, 0.3)).toMatch(/too cheap \(1\.5¢/);
    expect(fadeSpikeWhyNot({ ...base, binVsRef: 8 }, 20, 0.3)).toMatch(/only \$8 from the strike/);
    expect(fadeSpikeWhyNot({ ...base, mom30s: -0.0004 }, 20, 0.3)).toMatch(/moving back/);
  });
});

