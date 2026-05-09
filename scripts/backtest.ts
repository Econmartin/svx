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

interface Args {
  threshold: number;
  outFile: string;
  notional: number; // simulated dUSDC notional per trade
}

function parseArgs(): Args {
  const args: Args = {
    threshold: 0.03,
    outFile: 'data/backtest.csv',
    notional: 0.5,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--threshold') args.threshold = Number(process.argv[++i]);
    else if (a === '--notional') args.notional = Number(process.argv[++i]);
    else if (a === '--out') args.outFile = process.argv[++i] ?? args.outFile;
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

  // Filter to signals whose absolute spread crosses the configured threshold.
  // The recorded `spread` is the *edge* — already absolute-valued by the
  // computeSpread engine.
  const wouldFire = signals.filter((s) => s.spread >= args.threshold);

  const trades = wouldFire.map((s) => {
    const costPrice = s.predict_direction === 'up' ? s.predict_prob : 1 - s.predict_prob;
    const cost = args.notional * costPrice;
    const settlement = settlements.get(s.oracle_id);
    let outcome: 'win' | 'loss' | 'open' = 'open';
    let payout = 0;
    if (settlement !== undefined) {
      const upWon = settlement > s.strike;
      const won = s.predict_direction === 'up' ? upWon : !upWon;
      outcome = won ? 'win' : 'loss';
      payout = won ? args.notional : 0;
    }
    return {
      ts: s.ts_ms,
      oracleId: s.oracle_id,
      strike: s.strike,
      direction: s.predict_direction,
      predictProb: s.predict_prob,
      polyProb: s.poly_prob,
      spread: s.spread,
      costPrice,
      cost,
      settlement,
      outcome,
      payout,
      pnl: outcome === 'open' ? null : payout - cost,
    };
  });

  const closed = trades.filter((t) => t.outcome !== 'open');
  const wins = closed.filter((t) => t.outcome === 'win').length;
  const losses = closed.filter((t) => t.outcome === 'loss').length;
  const totalPnl = closed.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
  const totalCost = closed.reduce((acc, t) => acc + t.cost, 0);
  const stillOpen = trades.length - closed.length;

  const summary = {
    msg: 'backtest.summary',
    threshold: args.threshold,
    notional_per_trade: args.notional,
    total_signals_observed: totalSignals,
    signals_with_spread: signals.length,
    would_fire: wouldFire.length,
    fire_rate: signals.length > 0 ? wouldFire.length / signals.length : 0,
    settled_trades: closed.length,
    still_open: stillOpen,
    wins,
    losses,
    win_rate: closed.length ? wins / closed.length : null,
    total_cost_usdc: round(totalCost, 4),
    total_pnl_usdc: round(totalPnl, 4),
    roi: totalCost > 0 ? round(totalPnl / totalCost, 4) : null,
  };
  console.log(JSON.stringify(summary, null, 2));

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

function round(x: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(x * m) / m;
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'backtest.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
