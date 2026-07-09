/**
 * Backtest harness — replay the live bot's captured signal stream at
 * different thresholds and produce a summary + CSV of would-be trades.
 *
 * The signals table already has predictProb, polyProb, spread, direction —
 * computed by the live bot from real SVI surfaces and real Polymarket order
 * books. Backtesting a new threshold is just: re-filter that table.
 *
 * If a signal's oracle has settled (recorded in `settlements`), we know
 * whether the trade would have won or lost. PnL per signal:
 *   cost  = quantity * cost_price        (cost_price = predictProb if dir=up, else 1-predictProb)
 *   payout = quantity if won else 0
 *   pnl   = payout - cost
 *
 * Usage:
 *   pnpm --filter svx-bot exec tsx ../../scripts/backtest.ts --threshold 0.03
 *   pnpm --filter svx-bot exec tsx ../../scripts/backtest.ts --threshold 0.01 --out data/backtest-1pct.csv
 */

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { loadConfig } from '../packages/svx-bot/src/config.js';
import { computeBacktest } from '../packages/svx-bot/src/ops/backtest.js';

interface Args {
  threshold: number;
  outFile: string;
  notional: number; // simulated dUSDC notional per trade
  /** Bet the side Predict FAVORS (opposite of predict_direction) at the
   *  complementary cost. The default (hedge-side) direction backtested at
   *  −49% ROI on May-2026 data — which mathematically implies the favored
   *  side was +EV: at big divergences from Polymarket, Predict's surface is
   *  directionally right but UNDERCONFIDENT (quotes ~76¢ on outcomes that
   *  realize ~84–88%). This flag measures that edge directly. */
  flip: boolean;
  /** One bet per (oracle, strike, direction) — first observation only.
   *  Without this, the 15s signal loop re-logs the same opportunity dozens
   *  of times and the trade count (and confidence) is fiction. */
  dedupe: boolean;
  /** Cost markup fraction to approximate the Predict protocol fee
   *  (UP + DOWN > 1). E.g. 0.02 = pay 2% over the quoted probability. */
  fee: number;
}

function parseArgs(): Args {
  const args: Args = {
    threshold: 0.03,
    outFile: 'data/backtest.csv',
    notional: 0.5,
    flip: false,
    dedupe: false,
    fee: 0,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--threshold') args.threshold = Number(process.argv[++i]);
    else if (a === '--notional') args.notional = Number(process.argv[++i]);
    else if (a === '--out') args.outFile = process.argv[++i] ?? args.outFile;
    else if (a === '--flip') args.flip = true;
    else if (a === '--dedupe') args.dedupe = true;
    else if (a === '--fee') args.fee = Number(process.argv[++i]);
  }
  return args;
}

interface SignalRow {
  id: string;
  ts_ms: number;
  oracle_id: string;
  expiry_ms: number;
  strike: number;
  predict_direction: 'up' | 'down';
  predict_prob: number;
  poly_prob: number;
  spread: number;
  action: string;
  filter_reason: string | null;
}

interface SettlementRow {
  oracle_id: string;
  settlement_price: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();
  const dbPath = path.join(path.resolve(cfg.dataDir), 'svx.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error(`no ledger at ${dbPath} — run the bot first`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });

  const totalSignals = db
    .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM signals')
    .get()?.c ?? 0;

  // Pull the consideration set: every observed signal where the spread is
  // available. (Filtered signals still have spread + direction recorded so we
  // can backtest as if filters were absent.)
  const signals = db
    .prepare<[], SignalRow>(
      `SELECT id, ts_ms, oracle_id, expiry_ms, strike, predict_direction,
              predict_prob, poly_prob, spread, action, filter_reason
       FROM signals
       WHERE spread IS NOT NULL`,
    )
    .all();

  const settlements = new Map<string, number>();
  for (const r of db
    .prepare<[], SettlementRow>('SELECT oracle_id, settlement_price FROM settlements')
    .all()) {
    settlements.set(r.oracle_id, r.settlement_price);
  }

  // Shared engine — identical math to the GET /backtest API endpoint, so the
  // CLI and the deployed bot can never drift apart.
  const { summary, trades } = computeBacktest(
    signals.map((s) => ({
      tsMs: s.ts_ms,
      oracleId: s.oracle_id,
      strike: s.strike,
      predictDirection: s.predict_direction,
      predictProb: s.predict_prob,
      polyProb: s.poly_prob,
      spread: s.spread,
    })),
    settlements,
    {
      threshold: args.threshold,
      flip: args.flip,
      dedupe: args.dedupe,
      fee: args.fee,
      notional: args.notional,
    },
  );

  console.log(
    JSON.stringify(
      { msg: 'backtest.summary', total_signals_observed: totalSignals, ...summary },
      null,
      2,
    ),
  );

  const csvHeader =
    'ts_iso,oracle_id,strike,direction,predict_prob,poly_prob,spread,cost_price,cost,settlement,outcome,payout,pnl';
  const csv = [
    csvHeader,
    ...trades.map(
      (t) =>
        `${new Date(t.ts).toISOString()},${t.oracleId},${t.strike},${t.direction},${t.predictProb.toFixed(6)},${t.polyProb.toFixed(6)},${t.spread.toFixed(6)},${t.costPrice.toFixed(6)},${t.cost.toFixed(6)},${t.settlement ?? ''},${t.outcome},${t.payout.toFixed(6)},${t.pnl?.toFixed(6) ?? ''}`,
    ),
  ].join('\n');
  fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
  fs.writeFileSync(args.outFile, csv);
  console.log(JSON.stringify({ msg: 'backtest.written', file: args.outFile, rows: trades.length }));

  db.close();
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'backtest.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
