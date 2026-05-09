/**
 * Backtest harness — replay historical SVI + Polymarket snapshots from the
 * SQLite ledger and re-run the spread/sizer logic with configurable
 * parameters. Produces a CSV of would-be trades + summary stats.
 *
 * Usage:
 *   pnpm tsx scripts/backtest.ts --threshold 0.03 --max-position 100
 *
 * IMPORTANT (in-sample warning): if you tune the threshold using the same
 * snapshot window you backtest against, the results will be optimistic. Hold
 * out the last 25% of the window as out-of-sample.
 */

import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { loadConfig } from '../packages/svx-bot/src/config.js';
import { computeSpread } from '../packages/svx-bot/src/signal/spread.js';

interface Args {
  threshold: number;
  outFile: string;
}

function parseArgs(): Args {
  const args: Args = {
    threshold: 0.03,
    outFile: 'data/backtest.csv',
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === '--threshold') args.threshold = Number(process.argv[++i]);
    else if (a === '--out') args.outFile = process.argv[++i] ?? args.outFile;
  }
  return args;
}

interface SviRow {
  oracle_id: string;
  ts_ms: number;
  spot: number;
  forward: number;
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

interface PolyRow {
  condition_id: string;
  ts_ms: number;
  strike: number;
  expiry_ms: number;
  yes_bid: number;
  yes_ask: number;
  yes_bid_size: number;
  yes_ask_size: number;
  no_bid: number;
  no_ask: number;
  volume_24h_usd: number;
}

interface SettlementRow {
  oracle_id: string;
  expiry_ms: number;
  settlement_price: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();
  const dbPath = path.join(path.resolve(cfg.dataDir), 'svx.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error(`no ledger at ${dbPath} — run the bot first to capture snapshots`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });

  const svis = db
    .prepare<[], SviRow>('SELECT * FROM svi_snapshots ORDER BY ts_ms ASC')
    .all();
  const polys = db
    .prepare<[], PolyRow>('SELECT * FROM poly_snapshots ORDER BY ts_ms ASC')
    .all();
  const settlements = new Map<string, SettlementRow>();
  for (const r of db
    .prepare<[], SettlementRow>('SELECT oracle_id, expiry_ms, settlement_price FROM settlements')
    .all()) {
    settlements.set(r.oracle_id, r);
  }

  console.log(
    JSON.stringify({
      msg: 'backtest.loaded',
      svi_snapshots: svis.length,
      poly_snapshots: polys.length,
      settlements: settlements.size,
      threshold: args.threshold,
    }),
  );

  // For each SVI snapshot, find Polymarket snapshots within ±60s and same
  // strike grid. Use the spread engine; record what would have happened.
  const trades: Array<{
    ts: number;
    oracle_id: string;
    strike: number;
    direction: 'up' | 'down';
    edge: number;
    cost_price: number;
    settlement?: number;
    settled?: 'win' | 'loss';
  }> = [];

  for (const svi of svis) {
    const tWindow = polys.filter((p) => Math.abs(p.ts_ms - svi.ts_ms) < 60_000);
    for (const p of tWindow) {
      const oracleSnap = {
        oracleId: svi.oracle_id,
        underlyingAsset: 'BTC',
        expiryMs: p.expiry_ms,
        spot: svi.spot,
        forward: svi.forward,
        svi: { a: svi.a, b: svi.b, rho: svi.rho, m: svi.m, sigma: svi.sigma },
        timestampMs: svi.ts_ms,
        isSettled: false,
      };
      const polySnap = {
        conditionId: p.condition_id,
        strike: p.strike,
        expiryMs: p.expiry_ms,
        yesBid: p.yes_bid,
        yesAsk: p.yes_ask,
        yesBidSize: p.yes_bid_size,
        yesAskSize: p.yes_ask_size,
        noBid: p.no_bid,
        noAsk: p.no_ask,
        volume24hUsd: p.volume_24h_usd,
        fetchedAtMs: p.ts_ms,
      };
      const sp = computeSpread({
        oracleSnapshot: oracleSnap,
        polymarketSnapshot: polySnap,
        threshold: args.threshold,
        nowMs: svi.ts_ms,
      });
      if (sp.decision) {
        const settlement = settlements.get(svi.oracle_id)?.settlement_price;
        const costPrice = sp.decision.predictDirection === 'up' ? sp.predictUp : 1 - sp.predictUp;
        let settled: 'win' | 'loss' | undefined;
        if (settlement !== undefined) {
          const upWon = settlement > p.strike;
          const won = sp.decision.predictDirection === 'up' ? upWon : !upWon;
          settled = won ? 'win' : 'loss';
        }
        trades.push({
          ts: svi.ts_ms,
          oracle_id: svi.oracle_id,
          strike: p.strike,
          direction: sp.decision.predictDirection,
          edge: sp.decision.edge,
          cost_price: costPrice,
          settlement,
          settled,
        });
      }
    }
  }

  // Summary stats.
  const closed = trades.filter((t) => t.settled);
  const wins = closed.filter((t) => t.settled === 'win').length;
  const totalPnl = closed.reduce((acc, t) => {
    const cost = t.cost_price; // per dUSDC unit
    const payout = t.settled === 'win' ? 1 : 0;
    return acc + (payout - cost);
  }, 0);

  console.log(
    JSON.stringify({
      msg: 'backtest.summary',
      total_signals: trades.length,
      settled: closed.length,
      wins,
      losses: closed.length - wins,
      win_rate: closed.length ? wins / closed.length : 0,
      // Per-unit PnL: a signal with cost 0.4 that wins yields 0.6; that loses, -0.4.
      per_unit_pnl: totalPnl,
    }),
  );

  // Write CSV.
  const csv = [
    'ts_iso,oracle_id,strike,direction,edge,cost_price,settlement,settled',
    ...trades.map(
      (t) =>
        `${new Date(t.ts).toISOString()},${t.oracle_id},${t.strike},${t.direction},${t.edge.toFixed(6)},${t.cost_price.toFixed(6)},${t.settlement ?? ''},${t.settled ?? ''}`,
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
