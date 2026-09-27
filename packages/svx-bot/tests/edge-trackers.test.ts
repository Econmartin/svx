import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore, type EdgeProbeRow } from '../src/ledger/store.js';
import {
  JumpDetector,
  pays,
  regimeRatio,
  rmsPerSqrtSecond,
  scoreJumps,
  scoreVolRegime,
  type JumpPayload,
  type VolRegimePayload,
} from '../src/ops/edge-trackers.js';

describe('JumpDetector', () => {
  it('fires on a $10 move inside 2s, then respects the cooldown', () => {
    const d = new JumpDetector(10, 2_000, 3_000);
    expect(d.push(0, 100_000)).toBeNull();
    expect(d.push(1_000, 100_004)).toBeNull(); // not enough history yet
    expect(d.push(2_000, 100_012)).toBeCloseTo(12);
    expect(d.push(2_500, 100_030)).toBeNull(); // cooldown
    expect(d.push(3_200, 100_030)).toBeNull(); // still cooling down
    expect(d.push(5_100, 100_050)).toBeCloseTo(20);
  });

  it('ignores slow drifts and small moves', () => {
    const d = new JumpDetector(10, 2_000, 3_000);
    for (let t = 0; t <= 20_000; t += 250) expect(d.push(t, 100_000 + t / 1000)).toBeNull();
  });

  it('fires on down moves with a negative sign', () => {
    const d = new JumpDetector(10, 2_000, 3_000);
    d.push(0, 100_000);
    expect(d.push(2_000, 99_985)).toBeCloseTo(-15);
  });
});

describe('pays', () => {
  it('uses the chain convention (lower, upper]', () => {
    expect(pays(100, 200, 200)).toBe(true);
    expect(pays(100, 200, 100)).toBe(false);
    expect(pays(null, 100, 100)).toBe(true); // DOWN at the strike wins
    expect(pays(100, null, 100)).toBe(false); // UP needs strictly above
  });
});

describe('rmsPerSqrtSecond', () => {
  it('is the RMS of 1s changes', () => {
    const closes = Array.from({ length: 61 }, (_, i) => 100 + (i % 2 ? 3 : 0));
    expect(rmsPerSqrtSecond(closes)).toBeCloseTo(3);
    expect(rmsPerSqrtSecond([1, 2])).toBeNull();
  });
});

const jumpRow = (over: Partial<JumpPayload>, settlement: number, marketId = '0xm'): EdgeProbeRow<JumpPayload> => ({
  marketId,
  slot: 'jump',
  expiryMs: 100_000,
  recordedAtMs: 0,
  ttmMs: 90_000,
  settlementPrice: settlement,
  payload: {
    side: 'up',
    move2sUsd: 18,
    binMid: 100_020,
    reference: 100_000,
    triggerMs: 0,
    q1: { atMs: 300, up: 0.6, cost: 0.7 },
    q2: { atMs: 1_400, up: 0.65, cost: 0.75 },
    q3: { atMs: 2_000, up: 0.9, cost: 0.97 },
    ...over,
  },
});

describe('scoreJumps', () => {
  it('scores the jump side at both quotes and dedupes to the first trigger per market', () => {
    const rows = [
      jumpRow({}, 100_010),
      jumpRow(
        { triggerMs: 4_000, q1: { atMs: 4_300, up: 0.6, cost: 0.7 }, q2: { atMs: 5_400, up: 0.65, cost: 0.75 } },
        100_010,
      ), // same market, later trigger
      jumpRow({ side: 'down', q1: { atMs: 200, up: 0.4, cost: 0.7 }, q2: null }, 100_010, '0xn'),
    ];
    const r = scoreJumps(rows);
    const b = r.byMove.find((x) => x.move === '$15-25')!;
    expect(b.q1!.n).toBe(3);
    expect(b.q1!.won).toBeCloseTo(2 / 3);
    expect(b.q2!.n).toBe(2);
    expect(b.q2!.pnlPerContract).toBeCloseTo(0.25);
    expect(r.firstPerMarketQ2!.n).toBe(1); // 0xn has no q2
    expect(r.latencyMs.q1).toBe(300);
    expect(r.latencyMs.q2).toBe(1_400);
    expect(b.q3!.allIn).toBeCloseTo(0.97); // 0xn (down) carries the default q3 too
  });
});

const volRow = (payload: Partial<VolRegimePayload>, settlement: number, ttmMs = 120_000): EdgeProbeRow<VolRegimePayload> => ({
  marketId: '0xm',
  slot: 't2m',
  expiryMs: 0,
  recordedAtMs: 0,
  ttmMs,
  settlementPrice: settlement,
  payload: {
    forward: 100_000,
    reference: 100_000,
    rv15: 0.5,
    rv5: 0.5,
    chainSdUsd: 50,
    candidates: [
      { name: 'up', lower: 100_000, upper: null, prob: 0.5, cost: 0.6 },
      { name: 'down', lower: null, upper: 100_000, prob: 0.5, cost: 0.6 },
      { name: 'W25', lower: 99_987, upper: 100_012, prob: 0.2, cost: 0.4 },
    ],
    ...payload,
  },
});

describe('scoreVolRegime', () => {
  it('buckets by realized/chain vol and prices the model trader off realized vol', () => {
    // ratio = 1.35·0.5·√120 / 50 ≈ 0.15 → the quiet bucket; a tight realized sd
    // makes the central window worth far more than its 40¢ cost.
    const rows = [volRow({}, 100_005), volRow({}, 100_050)];
    expect(regimeRatio(rows[0]!.payload, 120_000)).toBeCloseTo(0.1479, 3);
    const r = scoreVolRegime(rows);
    const quiet = r.byRegime[0]!;
    expect(quiet.candidates.W25!.n).toBe(2);
    expect(quiet.candidates.W25!.won).toBeCloseTo(0.5);
    const mt = r.modelTrader.find((x) => x.minEdge === 0.03 && x.slot === 'all')!;
    expect(mt.picks).toEqual({ W25: 2 });
    expect(mt.stat!.pnlPerContract).toBeCloseTo(0.1);
  });
});

describe('ledger edge probes', () => {
  let dir: string;
  let ledger: LedgerStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-edge-'));
    ledger = new LedgerStore(path.join(dir, 'l.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts once, resolves by market, and returns payloads', () => {
    const base = {
      network: 'mainnet',
      kind: 'vol_regime' as const,
      marketId: '0xm',
      slot: 't2m',
      expiryMs: 1_000,
      recordedAtMs: 500,
      ttmMs: 500,
      payload: { x: 1 },
    };
    expect(ledger.insertEdgeProbe({ ...base, id: 'a' })).toBe(true);
    expect(ledger.insertEdgeProbe({ ...base, id: 'a' })).toBe(false);
    expect(ledger.hasEdgeProbe('0xm', 'vol_regime', 't2m')).toBe(true);
    expect(ledger.unsettledEdgeProbeMarkets(2_000)).toEqual(['0xm']);
    expect(ledger.resolveEdgeProbeMarket('0xm', 123.5, 2_000)).toBe(1);
    const rows = ledger.settledEdgeProbes<{ x: number }>('mainnet', 'vol_regime');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.x).toBe(1);
    expect(rows[0]!.settlementPrice).toBe(123.5);
    expect(ledger.settledEdgeProbes('mainnet', 'jump')).toHaveLength(0);
  });
});

import { edgeSwitchScores, volModelPick } from '../src/ops/edge-trackers.js';
import { runJumpTrades, runVolModelTrade } from '../src/index.js';
import { strategyTagFor, type SwitchEntry } from '../src/strategy/switchboard.js';

describe('edge strategies on the switchboard', () => {
  it('scores binance_jump at q2, first trigger per market, inside the trade band', () => {
    const rows = [
      jumpRow({}, 100_010), // up, q2 cost 0.75, wins
      jumpRow({ triggerMs: 9_000 }, 90_000), // same market again: ignored
      jumpRow({ q2: { atMs: 1_400, up: 0.99, cost: 0.99 } }, 100_010, '0xband'), // 99c: outside band
      jumpRow({}, 99_000, '0xloss'), // loses
    ];
    const [s] = edgeSwitchScores(rows, []);
    expect(s!.signal).toBe('binance_jump');
    expect(s!.slot).toBe('jump');
    expect(s!.n).toBe(2);
    expect(s!.pnlPerContract).toBeCloseTo((0.25 - 0.75) / 2);
    expect(s!.recent).toEqual([1, 0]);
    expect(s!.streak).toBe(-1);
  });

  it('scores vol_model per slot from the model pick', () => {
    const scores = edgeSwitchScores([], [volRow({}, 100_005), volRow({}, 100_050)]);
    const s = scores.find((x) => x.slot === 't2m')!;
    expect(s.signal).toBe('vol_model');
    expect(s.n).toBe(2);
    expect(s.pnlPerContract).toBeCloseTo(0.1);
    expect(volModelPick(volRow({}, 0).payload, 120_000, 0.03)!.candidate.name).toBe('W25');
  });

  it('tags ledger strategies', () => {
    expect(strategyTagFor('binance_jump')).toBe('edge_jump');
    expect(strategyTagFor('vol_model')).toBe('edge_vol');
    expect(strategyTagFor('fade_spike_any_time')).toBe('fade_spike');
  });
});

describe('edge executors (paper)', () => {
  let dir: string;
  let ledger: LedgerStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-edge-exec-'));
    ledger = new LedgerStore(path.join(dir, 'l.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sw = (key: string, status: 'on' | 'off'): SwitchEntry[] => [
    {
      key,
      signal: key.split('@')[0]!,
      slot: key.split('@')[1]!,
      n: 5,
      pnlPerContract: status === 'on' ? 0.05 : -0.05,
      recent: [],
      streak: 0,
      recentPnl: 0,
      status,
      sinceMs: 0,
    },
  ];
  const deps = (switchboard: SwitchEntry[]) => ({
    ledger,
    cfg: { paperTrading: true } as never,
    live: undefined,
    switchboard,
  });
  const market = (id: string) => ({
    id,
    expiryMs: Date.now() + 90_000,
    tickSize: 0.01,
    admissionTickSize: 1,
    mintPaused: false,
    referencePrice: 100_000,
  });
  const jump = {
    triggerMs: Date.now(),
    side: 'down' as const,
    move2sUsd: -20,
    markets: [{ market: market('0xa'), q1: { atMs: Date.now(), up: 0.6, cost: 0.5 } }],
  };

  it('buys the jump side at the reference strike when green', async () => {
    await runJumpTrades(jump, deps(sw('binance_jump@jump', 'on')));
    const [t] = ledger.openTrades();
    expect(t!.strategy).toBe('edge_jump');
    expect(t!.direction).toBe('down');
    expect(t!.strike).toBe(100_000);
    expect(t!.predictProbAtExec).toBeCloseTo(0.4);
    // once per market
    await runJumpTrades(jump, deps(sw('binance_jump@jump', 'on')));
    expect(ledger.openTrades()).toHaveLength(1);
  });

  it('does nothing when red', async () => {
    await runJumpTrades(jump, deps(sw('binance_jump@jump', 'off')));
    expect(ledger.openTrades()).toHaveLength(0);
  });

  it('buys a range for a window pick and settles it on (lower, upper]', async () => {
    const r = volRow({}, 0);
    await runVolModelTrade(
      { market: market('0xv'), slot: 't2m', ttmMs: 120_000, payload: r.payload },
      deps(sw('vol_model@t2m', 'on')),
    );
    const [t] = ledger.openTrades();
    expect(t!.strategy).toBe('edge_vol');
    expect(t!.direction).toBe('range');
    expect(t!.strike).toBe(99_987);
    expect(t!.rangeUpper).toBe(100_012);
    ledger.settleTradesForOracle('0xv', 100_012, Date.now());
    const [c] = ledger.closedTrades();
    expect(c!.payoutUsdc).toBeCloseTo(c!.quantityDusdc); // 100_012 is inside (lower, upper]
    expect(c!.rangeUpper).toBe(100_012);
  });

  it('a range settling on its lower bound loses', () => {
    ledger.insertTrade({
      signalId: 'x',
      timestampMs: 0,
      mode: 'paper',
      oracleId: '0xr',
      underlyingAsset: 'BTC',
      expiryMs: 1,
      strike: 100,
      direction: 'range',
      rangeUpper: 200,
      quantityDusdc: 10,
      costPrice: 0.3,
      costUsdc: 3,
      settled: false,
    });
    ledger.settleTradesForOracle('0xr', 100, 2);
    expect(ledger.closedTrades()[0]!.payoutUsdc).toBe(0);
  });
});
