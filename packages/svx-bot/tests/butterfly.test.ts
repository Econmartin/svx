/**
 * Butterfly-harvester telemetry — the crossed-strikes scanner. A digital
 * price curve P_up(K) must be non-increasing; rising runs are near-riskless
 * structures whose margin = the total rise.
 */

import { describe, it, expect } from 'vitest';
import { findCrossedStrikes } from '../src/strategy/butterfly.js';

const pts = (ups: number[]) => ups.map((up, i) => ({ strike: 60_000 + i * 100, up }));

describe('findCrossedStrikes', () => {
  it('finds nothing on a monotone-decreasing curve', () => {
    expect(findCrossedStrikes(pts([0.9, 0.8, 0.7, 0.6]), 0.01)).toEqual([]);
  });

  it('flags a single rising pair with its margin', () => {
    const out = findCrossedStrikes(pts([0.9, 0.7, 0.75, 0.6]), 0.01);
    expect(out).toHaveLength(1);
    expect(out[0]!.lowerStrike).toBe(60_100);
    expect(out[0]!.higherStrike).toBe(60_200);
    expect(out[0]!.marginFrac).toBeCloseTo(0.05, 10);
  });

  it('merges a consecutive rising run into one pair, start → peak', () => {
    // 0.60 → 0.65 → 0.72 is one opportunity of margin 0.12, not two of 0.05/0.07.
    const out = findCrossedStrikes(pts([0.9, 0.6, 0.65, 0.72, 0.5]), 0.01);
    expect(out).toHaveLength(1);
    expect(out[0]!.lowerStrike).toBe(60_100);
    expect(out[0]!.higherStrike).toBe(60_300);
    expect(out[0]!.marginFrac).toBeCloseTo(0.12, 10);
  });

  it('applies the record floor', () => {
    expect(findCrossedStrikes(pts([0.9, 0.7, 0.705]), 0.01)).toEqual([]);
  });

  it('finds multiple separated runs', () => {
    const out = findCrossedStrikes(pts([0.9, 0.7, 0.75, 0.6, 0.4, 0.46]), 0.01);
    expect(out).toHaveLength(2);
    expect(out[0]!.marginFrac).toBeCloseTo(0.05, 10);
    expect(out[1]!.marginFrac).toBeCloseTo(0.06, 10);
  });
});
