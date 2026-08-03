import { describe, expect, it } from 'vitest';
import {
  admissibleStrike,
  admissionMultiple,
  snapTickToAdmission,
  strikeToTick,
} from '../src/exec/ptb-v2.js';

/**
 * `strike_exposure::assert_admitted_mint_ticks` accepts a mint bound only if
 * it is a sentinel, the reference tick, or a multiple of
 * `admission_tick_size / tick_size`. Live markets use tick 1e7 ($0.01) and
 * admission 1e9 ($1.00) → every mint tick must be a multiple of 100.
 *
 * Our SVI grid produces continuous strikes, so unsnapped ticks aborted every
 * live mint on 2026-08-03 (abort code 1).
 */
const TICK = 1e7;
const ADMISSION = 1e9;

describe('admission tick snapping', () => {
  it('derives the multiple from the two tick sizes', () => {
    expect(admissionMultiple(TICK, ADMISSION)).toBe(100n);
    expect(admissionMultiple(TICK, TICK)).toBe(1n);
  });

  it('snaps an off-grid strike onto an admitted tick', () => {
    const raw = strikeToTick(63126.47, TICK);
    expect(raw % 100n).not.toBe(0n); // the shape that aborted
    const snapped = snapTickToAdmission(raw, TICK, ADMISSION);
    expect(snapped % 100n).toBe(0n);
  });

  it('rounds to the NEAREST admitted strike, staying within a dollar', () => {
    for (const strike of [63126.47, 62999.99, 64000.5, 61234.01]) {
      const admissible = admissibleStrike(strike, TICK, ADMISSION);
      expect(Math.abs(admissible - strike)).toBeLessThanOrEqual(0.5);
      expect(snapTickToAdmission(strikeToTick(admissible, TICK), TICK, ADMISSION) % 100n).toBe(0n);
    }
  });

  it('leaves already-admitted strikes untouched', () => {
    expect(admissibleStrike(64000, TICK, ADMISSION)).toBeCloseTo(64000, 6);
  });
});
