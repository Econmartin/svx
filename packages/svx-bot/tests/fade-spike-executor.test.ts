import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore, type ShadowDecisionInput } from '../src/ledger/store.js';
import { runFadeSpikeDecision } from '../src/index.js';
import type { SwitchEntry } from '../src/strategy/switchboard.js';

const decision = (over: Partial<ShadowDecisionInput> = {}): ShadowDecisionInput => ({
  network: 'mainnet',
  marketId: '0xmarket',
  slot: 't50s',
  expiryMs: Date.now() + 50_000,
  recordedAtMs: Date.now(),
  ttmMs: 50_000,
  reference: 84_000,
  forward: 84_030,
  boardUp: 0.88, // DOWN (the far side) costs 12c
  costUp: 0.93,
  costDown: 0.2,
  binMid: 84_030,
  binImpliedUp: 0.9,
  mom1m: 0.001,
  mom5m: null,
  mom15m: null,
  bookImb: null,
  takerBuyRatio: null,
  funding: null,
  mom30s: 0.0004, // rose over 30s…
  binVsRef: 30, // …to $30 above the strike: a spike
  ...over,
});

const entry = (signal: string, slot: string, status: 'on' | 'off', pnl = 0.05): SwitchEntry => ({
  key: `${signal}@${slot}`,
  signal,
  slot,
  n: 10,
  pnlPerContract: status === 'on' ? pnl : -pnl,
  status,
  sinceMs: 0,
});

describe('switchboard executor (paper)', () => {
  let tmp: string;
  let ledger: LedgerStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-auto-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (d: ShadowDecisionInput, switchboard: SwitchEntry[]) =>
    runFadeSpikeDecision({ decision: d, underlying: 'BTC' }, {
      ledger,
      cfg: { paperTrading: true } as never,
      live: undefined,
      switchboard,
    });
  const openAuto = () =>
    ledger.openTrades().filter((t) => t.strategy === 'fade_spike' || t.strategy === 'auto_shadow');

  it('trades a green strategy: fade spike buys the far side at the reference strike', async () => {
    await run(decision(), [entry('fade_spike', 't50s', 'on')]);
    const [t] = openAuto();
    expect(t!.strategy).toBe('fade_spike');
    expect(t!.signalId).toBe('fade_spike@t50s');
    expect(t!.direction).toBe('down');
    expect(t!.strike).toBe(84_000);
    expect(t!.quantityDusdc).toBeCloseTo(9.34, 6); // ceil(1.12 / 0.12, $0.01 lots)
    expect(t!.costUsdc).toBeCloseTo(9.34 * 0.2, 6);
  });

  it('does not trade a red strategy', async () => {
    await run(decision(), [entry('fade_spike', 't50s', 'off')]);
    expect(openAuto()).toHaveLength(0);
  });

  it('only trades strategies switched on for this checkpoint', async () => {
    await run(decision({ slot: 't30s', ttmMs: 30_000 }), [entry('fade_spike', 't50s', 'on')]);
    expect(openAuto()).toHaveLength(0);
  });

  it('trades any green signal, tagged auto_shadow, and takes one position per market', async () => {
    const board = [entry('mom_1m_follow', 't50s', 'on', 0.02), entry('always_down', 't50s', 'on', 0.01)];
    await run(decision({ binVsRef: 5 }), board); // not a fade spike; mom_1m_follow picks up
    await run(decision({ binVsRef: 5 }), board);
    const trades = openAuto();
    expect(trades).toHaveLength(1);
    expect(trades[0]!.strategy).toBe('auto_shadow');
    expect(trades[0]!.signalId).toBe('mom_1m_follow@t50s');
    expect(trades[0]!.direction).toBe('up');
  });

  it('settles a reversal as a win (DOWN wins at or below the strike)', async () => {
    await run(decision(), [entry('fade_spike', 't50s', 'on')]);
    ledger.settleTradesForOracle('0xmarket', 83_990, Date.now());
    expect(ledger.realizedStrategyPnlSince('fade_spike', 0)).toBeCloseTo(9.34 - 9.34 * 0.2, 6);
  });

  it('stands down for the day after the shared loss limit', async () => {
    const board = [entry('always_up', 't50s', 'on')];
    // Seven $2.19 losses on cheap UP contracts (12c at 93c all-in would bust
    // the cap, so use a 50c market): lose until the $15 stop.
    for (let i = 0; i < 12; i++) {
      await run(decision({ marketId: `0xm${i}`, boardUp: 0.5, costUp: 0.6, binVsRef: 0 }), board);
      ledger.settleTradesForOracle(`0xm${i}`, 83_000, Date.now()); // UP loses
    }
    const lost = -ledger.realizedStrategyPnlSince('auto_shadow', 0);
    expect(lost).toBeGreaterThanOrEqual(15);
    expect(lost).toBeLessThan(15 + 1.5); // stopped right after crossing
  });
});
