/**
 * Seed the local SQLite ledger with synthetic signals + closed paper trades
 * so the dashboard has visual content to display offline.
 *
 * USE THIS ONLY FOR DASHBOARD SCREENSHOTS / OFFLINE DEMO. Do not commit the
 * resulting svx.sqlite file. The seeded data is clearly tagged in the
 * `notes` column so it can be filtered out.
 *
 * Usage: pnpm tsx scripts/seed-demo-data.ts
 */

import path from 'node:path';
import { LedgerStore } from '../packages/svx-bot/src/ledger/store.js';
import { loadConfig } from '../packages/svx-bot/src/config.js';
import { randomUUID } from 'node:crypto';

const STRIKES = [78_000, 80_000, 82_000, 84_000];
const ORACLE_ID = '0xa3f0af079e68050412859d05964c7a9ca8ac42bc29b7d9ba26b03b7d884b7618';

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ledger = new LedgerStore(path.join(path.resolve(cfg.dataDir), 'svx.sqlite'));

  // 7 days of synthetic signals — one every 30 minutes per strike.
  const now = Date.now();
  const startMs = now - 7 * 24 * 3600 * 1000;
  let count = 0;

  for (let t = startMs; t <= now; t += 30 * 60 * 1000) {
    for (const strike of STRIKES) {
      const predictUp = clamp01(0.5 + (80_000 - strike) / 80_000 + rnd(-0.05, 0.05));
      const polyAsk = clamp01(predictUp + rnd(-0.06, 0.06));
      const polyBid = Math.max(0.001, polyAsk - rnd(0.005, 0.02));
      const spread = predictUp - polyAsk;

      let action: 'paper_executed' | 'sub_threshold' | 'filtered' = 'sub_threshold';
      let filterReason: string | undefined;
      let notional: number | undefined;
      let costUsdc: number | undefined;

      if (Math.abs(spread) > 0.03) {
        action = 'paper_executed';
        notional = 100;
        costUsdc = 100 * (spread > 0 ? polyAsk : 1 - predictUp);
      } else if (Math.random() < 0.15) {
        action = 'filtered';
        filterReason = (['poly_low_volume', 'poly_wide_spread', 'svi_stale'] as const)[
          Math.floor(Math.random() * 3)
        ];
      }

      const signalId = ledger.insertSignal({
        timestampMs: t,
        oracleId: ORACLE_ID,
        underlyingAsset: 'BTC',
        expiryMs: t + 30 * 60 * 1000,
        strike,
        predictDirection: spread > 0 ? 'down' : 'up',
        predictProb: predictUp,
        predictIv: rnd(0.4, 0.7),
        polyProb: polyAsk,
        polyIv: rnd(0.4, 0.7),
        spread: Math.abs(spread),
        ivSpread: rnd(-0.05, 0.05),
        action,
        filterReason: filterReason as never,
        notional,
        costUsdc,
      });

      if (action === 'paper_executed' && notional && costUsdc) {
        const direction = spread > 0 ? 'down' : 'up';
        const won = Math.random() < 0.55; // 55% win rate (synthetic)
        const payout = won ? notional : 0;
        const pnl = payout - costUsdc;
        ledger.insertTrade({
          id: randomUUID(),
          signalId,
          timestampMs: t,
          mode: 'paper',
          oracleId: ORACLE_ID,
          underlyingAsset: 'BTC',
          expiryMs: t + 30 * 60 * 1000,
          strike,
          direction,
          quantityDusdc: notional,
          costPrice: costUsdc / notional,
          costUsdc,
          settled: true,
          payoutUsdc: payout,
          pnlUsdc: pnl,
        });
      }
      count++;
    }
  }

  console.log(JSON.stringify({ msg: 'seed.done', signalsInserted: count }));
  ledger.close();
}

function clamp01(x: number): number {
  return Math.min(0.999, Math.max(0.001, x));
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'seed.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
