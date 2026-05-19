import { describe, it, expect } from 'vitest';
import { sizePolyOrder } from '../src/exec/poly-order-sizer.js';

const defaults = {
  maxOrderUsdc: 2,
  minOrderUsdc: 0.5,
};

describe('sizePolyOrder', () => {
  it('returns the full max when book has plenty of depth', () => {
    // depth 1000 × ask 0.50 × 0.95 = $475 fillable, max is $2 → submit $2.
    const r = sizePolyOrder({ ...defaults, bookDepthShares: 1000, ask: 0.5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.submitUsdc).toBe(2);
      expect(r.clampedToDepth).toBe(false);
    }
  });

  it('clamps to depth × ask × 0.95 when book is thin', () => {
    // The motivating prod incident: $2 @ $0.058 ask needs 34.5 shares but
    // book had ~20. depth=22 × 0.058 × 0.95 = $1.21 → submit $1.21.
    const r = sizePolyOrder({ ...defaults, bookDepthShares: 22, ask: 0.058 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.submitUsdc).toBeCloseTo(1.21, 2);
      expect(r.clampedToDepth).toBe(true);
    }
  });

  it('rounds down to whole cents (Polymarket tick)', () => {
    // depth 30 × 0.07 × 0.95 = $1.995 → floor to $1.99.
    const r = sizePolyOrder({ ...defaults, bookDepthShares: 30, ask: 0.07 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.submitUsdc).toBe(1.99);
  });

  it('skips when depth × ask is below minOrderUsdc', () => {
    // depth 5 × 0.05 × 0.95 = $0.24 < $0.5 floor.
    const r = sizePolyOrder({ ...defaults, bookDepthShares: 5, ask: 0.05 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('thin_book');
  });

  it('skips when depth is zero', () => {
    const r = sizePolyOrder({ ...defaults, bookDepthShares: 0, ask: 0.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('thin_book');
  });

  it('rejects invalid ask (<=0 or >=1 — binaries are strictly in (0,1))', () => {
    expect(sizePolyOrder({ ...defaults, bookDepthShares: 100, ask: 0 }).ok).toBe(false);
    expect(sizePolyOrder({ ...defaults, bookDepthShares: 100, ask: 1 }).ok).toBe(false);
    expect(sizePolyOrder({ ...defaults, bookDepthShares: 100, ask: 1.2 }).ok).toBe(false);
    expect(sizePolyOrder({ ...defaults, bookDepthShares: 100, ask: NaN }).ok).toBe(false);
  });

  it('rejects NaN/negative depth as invalid', () => {
    expect(sizePolyOrder({ ...defaults, bookDepthShares: NaN, ask: 0.5 }).ok).toBe(false);
    expect(sizePolyOrder({ ...defaults, bookDepthShares: -10, ask: 0.5 }).ok).toBe(false);
  });

  it('respects a larger minOrderUsdc — skips when clamped below custom floor', () => {
    // depth 22 × 0.058 × 0.95 = $1.21. With minOrderUsdc=1.5, skip.
    const r = sizePolyOrder({
      maxOrderUsdc: 2,
      minOrderUsdc: 1.5,
      bookDepthShares: 22,
      ask: 0.058,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('thin_book');
  });

  it('reports attemptedUsdc on skip for diagnostic logging', () => {
    const r = sizePolyOrder({ ...defaults, bookDepthShares: 0, ask: 0.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.attemptedUsdc).toBe(2);
  });
});
