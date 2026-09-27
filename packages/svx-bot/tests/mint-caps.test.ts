import { describe, expect, it } from 'vitest';
import { mintProbabilityCap } from '../src/pricing/predict-sdk.js';

const decimals = (x: number) => (String(x).split('.')[1] ?? '').length;

describe('mint probability cap', () => {
  it('never carries more than 9 decimals (live refusal 2026-09-27)', () => {
    expect(mintProbabilityCap(0.42295509600000003)).toBe(0.422955096); // the cap that failed
    expect(mintProbabilityCap(0.1 + 0.2)).toBe(0.3);
    for (let i = 0; i < 2000; i++) {
      const p = Math.random() * 0.9 + 0.05;
      const cap = mintProbabilityCap(p + 0.05);
      expect(decimals(cap)).toBeLessThanOrEqual(9);
      expect(cap).toBeLessThanOrEqual(Math.min(0.99, p + 0.05));
      expect(cap).toBeGreaterThan(Math.min(0.99, p + 0.05) - 2e-9);
    }
    expect(mintProbabilityCap(1.2)).toBe(0.99);
  });
});
