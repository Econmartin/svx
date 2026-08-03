import { describe, expect, it, beforeEach } from 'vitest';
import { LedgerStore } from '../src/ledger/store.js';

/**
 * The honest-headline query: Predict-side PnL per (strategy, mode).
 *
 * The all-time `realizedPnlSince(0)` blends July's V1 poly-arb era into
 * whatever trades today — the dashboard sums breakdown rows instead so the
 * homepage cannot present a retired strategy's July as today's edge.
 */

let ledger: LedgerStore;

beforeEach(() => {
  ledger = new LedgerStore(':memory:');
});

function trade(opts: {
  strategy: string;
  mode?: 'paper' | 'live';
  tsMs: number;
  oracleId?: string;
}): string {
  return ledger.insertTrade({
    signalId: 's',
    timestampMs: opts.tsMs,
    mode: opts.mode ?? 'live',
    oracleId: opts.oracleId ?? `oracle-${Math.random()}`,
    underlyingAsset: 'BTC',
    expiryMs: opts.tsMs + 150_000,
    strike: 64_000,
    direction: 'down',
    quantityDusdc: 5,
    costPrice: 0.77,
    costUsdc: 3.85,
    settled: false,
    strategy: opts.strategy as never,
  });
}

describe('strategyPnlBreakdown', () => {
  it('separates strategies, modes, and the 24h window', () => {
    const now = Date.now();
    const old = now - 30 * 24 * 3600_000;
    // Legacy era: settled long ago, mode live.
    const legacy = trade({ strategy: 'poly_arb', tsMs: old, oracleId: 'o-legacy' });
    ledger.settleTradesForOracle('o-legacy', 63_000, old + 200_000);
    // Current era: one win settled within 24h, one still open.
    const win = trade({ strategy: 'calibration_harvest', tsMs: now - 3600_000, oracleId: 'o-win' });
    ledger.settleTradesForOracle('o-win', 63_000, now - 3500_000);
    trade({ strategy: 'calibration_harvest', tsMs: now - 60_000, oracleId: 'o-open' });
    // Paper row must not pollute live aggregates.
    trade({ strategy: 'calibration_harvest', mode: 'paper', tsMs: now - 60_000 });

    const rows = ledger.strategyPnlBreakdown(now - 24 * 3600_000);
    const harvestLive = rows.find(
      (r) => r.strategy === 'calibration_harvest' && r.mode === 'live',
    )!;
    expect(harvestLive.trades).toBe(2);
    expect(harvestLive.open).toBe(1);
    expect(harvestLive.settled).toBe(1);
    expect(harvestLive.wins).toBe(1);
    expect(harvestLive.pnlUsdc).toBeCloseTo(5 - 3.85, 6);
    expect(harvestLive.pnl24hUsdc).toBeCloseTo(5 - 3.85, 6);
    expect(harvestLive.trades24h).toBe(2);

    const legacyRow = rows.find((r) => r.strategy === 'poly_arb' && r.mode === 'live')!;
    expect(legacyRow.settled).toBe(1);
    expect(legacyRow.pnl24hUsdc).toBe(0); // settled a month ago
    expect(legacyRow.trades24h).toBe(0);

    const paperRow = rows.find(
      (r) => r.strategy === 'calibration_harvest' && r.mode === 'paper',
    )!;
    expect(paperRow.trades).toBe(1);

    // Sanity: the sum over all rows equals the blended all-time aggregate.
    const blended = rows.reduce((s, r) => s + r.pnlUsdc, 0);
    expect(blended).toBeCloseTo(ledger.realizedPnlSince(0), 6);
    void legacy;
    void win;
  });
});
