import { beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore } from '../src/ledger/store.js';
import { PREDICT_BASELINE_KEY, bankGauge } from '../src/ops/bank-gauge.js';
import type { SwitchEntry } from '../src/strategy/switchboard.js';

let ledger: LedgerStore;
beforeEach(() => {
  ledger = new LedgerStore(':memory:');
});

const T0 = 1_000_000;
let n = 0;
/** A 5-contract "down" clip at 64k: settles a win at 63k, a loss at 65k. */
function clip(opts: {
  signalId: string;
  strategy: string;
  edge?: number;
  mode?: 'live' | 'paper';
  cost?: number;
}): string {
  const oracleId = `o${n++}`;
  ledger.insertTrade({
    signalId: opts.signalId,
    timestampMs: T0 + n,
    mode: opts.mode ?? 'live',
    oracleId,
    underlyingAsset: 'BTC',
    expiryMs: T0 + n + 60_000,
    strike: 64_000,
    direction: 'down',
    quantityDusdc: 5,
    costPrice: (opts.cost ?? 3.5) / 5,
    costUsdc: opts.cost ?? 3.5,
    settled: false,
    ...(opts.edge != null && { edgeAtExec: opts.edge }),
    strategy: opts.strategy as never,
  });
  return oracleId;
}
const settle = (oracleId: string, win: boolean) =>
  ledger.settleTradesForOracle(oracleId, win ? 63_000 : 65_000, T0 + 100_000);

const board: SwitchEntry[] = [
  { key: 'fade_spike@t50s', signal: 'fade_spike', slot: 't50s', n: 50, pnlPerContract: 0.1, recent: [], streak: 0, recentPnl: 0.1, status: 'on', sinceMs: 0 },
];

describe('bank gauge', () => {
  it('scores ledger PnL against the expected edge with a normal-swing band', () => {
    // Stamped edge wins over the board's current score.
    settle(clip({ signalId: 'fade_spike@t50s', strategy: 'fade_spike', edge: 0.08 }), true);
    // No stamp: falls back to the board's +10¢.
    settle(clip({ signalId: 'fade_spike@t50s', strategy: 'fade_spike' }), false);
    // Harvest live counts under its switchboard key.
    settle(clip({ signalId: 'harvest_v2', strategy: 'calibration_harvest', edge: 0.05, cost: 4 }), true);
    // Paper and open trades are not in the ledger total.
    settle(clip({ signalId: 'fade_spike@t50s', strategy: 'fade_spike', mode: 'paper' }), true);
    clip({ signalId: 'fade_spike@t50s', strategy: 'fade_spike', edge: 0.1 });
    // A live trade no switchboard strategy placed: unscored.
    settle(clip({ signalId: 's', strategy: 'vol_arb' }), false);

    const g = bankGauge(ledger, board, null, T0 + 200_000);
    // +1.5, −3.5, +1, −3.5
    expect(g.ledger.pnlUsdc).toBeCloseTo(-4.5);
    expect(g.ledger.settled).toBe(4);
    expect(g.ledger.open).toBe(1);
    expect(g.expected.trades).toBe(3);
    expect(g.expected.actualUsdc).toBeCloseTo(-1);
    // 5×0.08 + 5×0.10 + 5×0.05
    expect(g.expected.pnlUsdc).toBeCloseTo(1.15);
    expect(g.expected.luckUsdc).toBeCloseTo(-2.15);
    // σ² = 25·(.78·.22 + .8·.2 + .85·.15)
    expect(g.expected.sigmaUsdc).toBeCloseTo(Math.sqrt(25 * (0.78 * 0.22 + 0.8 * 0.2 + 0.85 * 0.15)), 1);
    expect(g.unscored).toEqual({ trades: 1, pnlUsdc: -3.5 });
    expect(g.series).toHaveLength(3);
    expect(g.byStrategy.find((r) => r.key === 'harvest_v2@harvest')?.trades).toBe(1);
  });

  it('flags account moves the ledger does not explain', () => {
    const g0 = bankGauge(ledger, board, 100, T0);
    expect(g0.bank.driftUsdc).toBe(0);
    expect(ledger.getMeta(PREDICT_BASELINE_KEY)).toBeDefined();

    // Buy a clip ($3.50 leaves the account), it wins, payout claimed.
    const o = clip({ signalId: 'fade_spike@t50s', strategy: 'fade_spike', edge: 0.1 });
    expect(bankGauge(ledger, board, 96.5, T0).bank.driftUsdc).toBe(0);
    settle(o, true);
    // Won but not claimed yet: account still at 96.5, no drift.
    expect(bankGauge(ledger, board, 96.5, T0).bank.driftUsdc).toBe(0);
    const id = ledger.livePredictTradesSince(0)[0]!.id;
    ledger.markRedeemed(id, '0xclaim');
    expect(bankGauge(ledger, board, 101.5, T0).bank.driftUsdc).toBe(0);
    // $2 vanished that the ledger can't account for.
    const g = bankGauge(ledger, board, 99.5, T0);
    expect(g.bank.driftUsdc).toBe(-2);
    expect(g.bank.sinceBaselineUsdc).toBe(-0.5);
  });
});
