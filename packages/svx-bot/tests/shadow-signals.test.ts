import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore, type ShadowDecisionInput } from '../src/ledger/store.js';
import { scoreShadowSignals } from '../src/ops/shadow-signals.js';

const base: ShadowDecisionInput = {
  network: 'mainnet',
  marketId: '0xm1',
  slot: 't50s',
  expiryMs: 1_000_000,
  recordedAtMs: 950_000,
  ttmMs: 50_000,
  reference: 84_000,
  forward: 84_010,
  boardUp: 0.55,
  costUp: 0.65,
  costDown: 0.55,
  binMid: 84_050,
  binImpliedUp: 0.7,
  mom1m: 0.001,
  mom5m: -0.002,
  mom15m: null,
  bookImb: 0.3,
  takerBuyRatio: 0.6,
  funding: 0.0001,
};

describe('shadow decisions ledger', () => {
  let tmp: string;
  let ledger: LedgerStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-shadow-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records one row per (market, slot) and ignores duplicates', () => {
    expect(ledger.insertShadowDecision(base)).toBe(true);
    expect(ledger.insertShadowDecision(base)).toBe(false);
    expect(ledger.hasShadowDecision('0xm1', 't50s')).toBe(true);
    expect(ledger.hasShadowDecision('0xm1', 't4m')).toBe(false);
  });

  it('resolves UP only when settlement is strictly above the reference', () => {
    ledger.insertShadowDecision(base);
    ledger.insertShadowDecision({ ...base, marketId: '0xm2' });
    expect(ledger.unsettledShadowMarkets(2_000_000)).toEqual(['0xm1', '0xm2']);
    ledger.resolveShadowMarket('0xm1', 84_000.01, 1_000_100);
    ledger.resolveShadowMarket('0xm2', 84_000, 1_000_100); // tie → DOWN wins
    const rows = ledger.settledShadowDecisions('mainnet');
    expect(rows.map((r) => r.outcomeUp).sort()).toEqual([false, true]);
    expect(ledger.settledShadowDecisions('testnet')).toEqual([]);
  });
});

describe('scoreShadowSignals', () => {
  const row = (over: Partial<ReturnType<typeof mk>>) => ({ ...mk(), ...over });
  function mk() {
    return {
      slot: 't50s',
      ttmMs: 50_000,
      boardUp: 0.5,
      costUp: 0.6,
      costDown: 0.6,
      binImpliedUp: null as number | null,
      mom1m: null as number | null,
      mom5m: null as number | null,
      mom15m: null as number | null,
      bookImb: null as number | null,
      takerBuyRatio: null as number | null,
      funding: null as number | null,
      outcomeUp: true,
    };
  }

  it('charges the all-in cost of the side picked', () => {
    const rows = [row({ outcomeUp: true }), row({ outcomeUp: false })];
    const up = scoreShadowSignals(rows).find((s) => s.signal === 'always_up' && s.slot === 'all')!;
    expect(up.n).toBe(2);
    expect(up.hitRate).toBe(0.5);
    expect(up.pnlPerContract).toBeCloseTo(0.5 - 0.6, 10); // coin flip loses the fee
  });

  it('abstains when the signal has no data or is inside its dead zone', () => {
    const rows = [row({ bookImb: 0.1 }), row({ bookImb: null }), row({ bookImb: 0.5 })];
    const s = scoreShadowSignals(rows).find((x) => x.signal === 'book_imbalance' && x.slot === 'all')!;
    expect(s.n).toBe(1);
  });

  it('follow and fade mirror hit rates', () => {
    const rows = [row({ mom1m: 0.01, outcomeUp: true }), row({ mom1m: -0.01, outcomeUp: true })];
    const scores = scoreShadowSignals(rows);
    const f = scores.find((x) => x.signal === 'mom_1m_follow' && x.slot === 'all')!;
    const d = scores.find((x) => x.signal === 'mom_1m_fade' && x.slot === 'all')!;
    expect(f.hitRate + d.hitRate).toBeCloseTo(1, 10);
  });

  it('latency signal needs the Binance-implied value to beat the board by the threshold', () => {
    const rows = [row({ binImpliedUp: 0.52 }), row({ binImpliedUp: 0.6 }), row({ binImpliedUp: 0.3 })];
    const s3 = scoreShadowSignals(rows).find((x) => x.signal === 'binance_lead_3pp' && x.slot === 'all')!;
    const s8 = scoreShadowSignals(rows).find((x) => x.signal === 'binance_lead_8pp' && x.slot === 'all')!;
    expect(s3.n).toBe(2);
    expect(s8.n).toBe(2);
  });
});
