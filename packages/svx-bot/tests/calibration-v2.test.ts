import { describe, expect, it, vi } from 'vitest';
import { LedgerStore } from '../src/ledger/store.js';
import {
  computeV2Calibration,
  recordV2CalibrationProbes,
  resolveV2CalibrationProbes,
} from '../src/ops/calibration-v2.js';
import type { PredictReader } from '../src/pricing/predict-v2.js';
import type { OracleSnapshot } from 'svx-shared/types';

const NOW = 1_785_170_000_000;

function mem(): LedgerStore {
  return new LedgerStore(':memory:');
}

function snapshot(overrides: Partial<OracleSnapshot> = {}): OracleSnapshot {
  return {
    oracleId: 'mkt-1',
    underlyingAsset: 'BTC',
    expiryMs: NOW + 60_000,
    spot: 64_500,
    forward: 64_500,
    svi: { a: 2e-7, b: 1e-5, rho: -0.5, m: 0, sigma: 0.02 },
    timestampMs: NOW - 2_000,
    isSettled: false,
    ...overrides,
  };
}

function reader(snap: OracleSnapshot | null): PredictReader {
  return {
    listOracles: async () => [],
    listActiveOracles: async () => [
      {
        oracleId: 'mkt-1',
        underlyingAsset: 'BTC',
        expiryMs: NOW + 60_000,
        minStrike: 0,
        tickSize: 0.01,
        status: 'active' as const,
      },
    ],
    snapshotOracle: async () => snap,
    lpSupplies: async () => [],
    lpWithdrawals: async () => [],
  };
}

describe('V2 calibration recorder', () => {
  it('records a probe grid inside the pre-expiry window, once per market', async () => {
    const ledger = mem();
    const n1 = await recordV2CalibrationProbes({ predict: reader(snapshot()), ledger, nowMs: NOW });
    expect(n1).toBeGreaterThan(0);
    const n2 = await recordV2CalibrationProbes({ predict: reader(snapshot()), ledger, nowMs: NOW });
    expect(n2).toBe(0); // deduped by market
  });

  it('skips stale surfaces and markets outside the window', async () => {
    const ledger = mem();
    const stale = snapshot({ timestampMs: NOW - 120_000 });
    expect(await recordV2CalibrationProbes({ predict: reader(stale), ledger, nowMs: NOW })).toBe(0);
    // Window: expiry 60s out, probing at T-10m is out of range.
    expect(
      await recordV2CalibrationProbes({
        predict: reader(snapshot()),
        ledger,
        nowMs: NOW - 600_000,
      }),
    ).toBe(0);
  });

  it('resolves probes against settlement and buckets favored-side outcomes', async () => {
    const ledger = mem();
    await recordV2CalibrationProbes({ predict: reader(snapshot()), ledger, nowMs: NOW });
    // Settle above spot: every below-spot strike resolves UP (favored wins
    // for high prob_up strikes), above-spot strikes resolve UP too.
    const settled = snapshot({
      isSettled: true,
      settlementPrice: 65_000,
      timestampMs: NOW + 65_000,
    });
    const resolved = await resolveV2CalibrationProbes({
      predict: reader(settled),
      ledger,
      nowMs: NOW + 90_000,
    });
    expect(resolved).toBeGreaterThan(0);
    const calib = computeV2Calibration(ledger);
    expect(calib.n).toBe(resolved);
    expect(calib.buckets.length).toBeGreaterThan(0);
    // every probe has a definite outcome
    expect(calib.wins).toBeLessThanOrEqual(calib.n);
    // quoted probabilities are folded to the favored side (>= 0.5)
    expect(calib.avg_quoted).toBeGreaterThanOrEqual(0.5);
  });
});

describe('board tenor probes emit v2_board signals', () => {
  it('writes a signal row per board-quoted probe with the model-vs-board spread', async () => {
    vi.resetModules();
    vi.doMock('../src/pricing/predict-sdk.js', () => ({
      listSdkMarkets: async () => [
        { id: 'mkt-1', expiryMs: NOW + 60 * 60_000, tickSize: 0.01, mintPaused: false, referencePrice: null },
      ],
      boardPrice: async () => ({ up: 0.7, down: 0.3 }),
      sdkConfig: () => ({ packages: { predict: '0xpkg' }, underlyings: {} }),
      decodeMintFill: () => null,
    }));
    const { recordBoardTenorProbes } = await import('../src/ops/calibration-v2.js');
    const ledger = mem();
    const n = await recordBoardTenorProbes({
      predict: reader(snapshot({ expiryMs: NOW + 60 * 60_000 })),
      ledger,
      nowMs: NOW,
      readOrderSeq: async () => 42,
    });
    expect(n).toBeGreaterThan(0);
    const db = (ledger as unknown as { db: import('better-sqlite3').Database }).db;
    const probe = db
      .prepare('SELECT mom_10m, order_seq FROM v2_calibration_probes LIMIT 1')
      .get() as { mom_10m: number | null; order_seq: number | null };
    expect(probe.order_seq).toBe(42); // injected reader value persisted
    const sigs = ledger.recentSignals(50).filter((s) => s.filterReason === 'v2_board');
    expect(sigs.length).toBe(n); // one signal per board-quoted probe
    for (const s of sigs) {
      expect(s.polyProb).toBe(0.7); // counterparty column carries the board quote
      expect(s.spread).toBeCloseTo(Math.abs(s.predictProb - 0.7), 10);
      expect(s.action).toBe('filtered');
    }
    vi.doUnmock('../src/pricing/predict-sdk.js');
  });
});
