/**
 * Force-trade a single Polymarket market order — bug-flush utility, NOT
 * called by the live bot loop.
 *
 * Defaults to a market BUY of 1 pUSD (~1 share at $1, much less at low-prob
 * tokens) on the chosen outcome token. Refuses to spend > 1 pUSD without
 * --i-know-what-im-doing.
 *
 * Usage:
 *   pnpm --filter svx-bot force-poly-trade -- \
 *     --token-id=<clob-token-id> \
 *     [--side=buy|sell] \
 *     [--amount=1] \
 *     [--tick-size=0.01] \
 *     [--i-know-what-im-doing]
 *
 * Reads creds in this order: POLY_API_{KEY,SECRET,PASSPHRASE} env vars,
 * then data/poly-operator.<network>.json. Refuses to run without creds.
 */

import fs from 'node:fs';
import { loadConfig, dataPath } from '../src/config.js';
import { derivePolyEndpoints } from '../src/exec/polymarket-keypair.js';
import { PolymarketExecClient } from '../src/exec/polymarket-client.js';
import type { ApiKeyCreds } from '@polymarket/clob-client-v2';

interface Args {
  tokenId: string;
  side: 'buy' | 'sell';
  amount: number;
  tickSize: '0.001' | '0.01' | '0.1';
  iKnow: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    side: 'buy',
    amount: 1,
    tickSize: '0.01',
    iKnow: false,
    dryRun: false,
  };
  for (const raw of argv) {
    const a = raw.startsWith('--') ? raw.slice(2) : raw;
    if (a === 'i-know-what-im-doing') {
      out.iKnow = true;
      continue;
    }
    if (a === 'dry-run') {
      out.dryRun = true;
      continue;
    }
    const [k, v] = a.split('=', 2);
    if (k === 'token-id') out.tokenId = v;
    else if (k === 'side') {
      if (v !== 'buy' && v !== 'sell') throw new Error(`--side must be buy or sell (got ${v})`);
      out.side = v;
    } else if (k === 'amount') {
      const n = Number(v);
      if (!isFinite(n) || n <= 0) throw new Error(`--amount must be a positive number (got ${v})`);
      out.amount = n;
    } else if (k === 'tick-size') {
      if (v !== '0.001' && v !== '0.01' && v !== '0.1') {
        throw new Error(`--tick-size must be 0.001, 0.01, or 0.1 (got ${v})`);
      }
      out.tickSize = v;
    }
  }
  if (!out.tokenId) {
    throw new Error('--token-id=<clob-token-id> is required');
  }
  return out as Args;
}

function loadCreds(network: 'amoy' | 'polygon', cfg = loadConfig()): ApiKeyCreds {
  const envKey = process.env.POLY_API_KEY;
  const envSecret = process.env.POLY_API_SECRET;
  const envPass = process.env.POLY_API_PASSPHRASE;
  if (envKey && envSecret && envPass) {
    return { key: envKey, secret: envSecret, passphrase: envPass };
  }
  const file = dataPath(`poly-operator.${network}.json`, cfg);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No POLY_API_* env vars set, and no creds file at ${file}. Run \`pnpm --filter svx-bot setup-poly-wallet\` first.`,
    );
  }
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { key: rec.apiKey, secret: rec.apiSecret, passphrase: rec.apiPassphrase };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const endpoints = derivePolyEndpoints(cfg);

  if (args.amount > 1 && !args.iKnow) {
    console.error(
      JSON.stringify({
        msg: 'force_poly.refuse_large',
        amount: args.amount,
        hint: 'Refusing to send more than 1 unit without --i-know-what-im-doing. For BUY this is pUSD; for SELL this is shares.',
      }),
    );
    process.exit(1);
  }

  const creds = loadCreds(endpoints.network, cfg);
  const client = new PolymarketExecClient(cfg, { creds });

  console.log(
    JSON.stringify({
      msg: 'force_poly.start',
      address: client.address,
      network: endpoints.network,
      tokenId: args.tokenId,
      side: args.side,
      amount: args.amount,
      tickSize: args.tickSize,
    }),
  );

  // Sanity: confirm there's a book at all before sending an order.
  const book = await client.getOrderBook(args.tokenId);
  const gas = await client.getGasBalance();
  const pUsd = await client.getCollateralBalance();
  // Sort: best bid = highest price, best ask = lowest price. The CLOB API
  // doesn't guarantee order, so we have to sort defensively.
  const sortedBids = (book.bids ?? [])
    .map((b) => ({ price: Number(b.price), size: Number(b.size) }))
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  const sortedAsks = (book.asks ?? [])
    .map((a) => ({ price: Number(a.price), size: Number(a.size) }))
    .sort((a, b) => a.price - b.price)
    .slice(0, 3);
  console.log(
    JSON.stringify({
      msg: 'force_poly.book_snapshot',
      tokenId: args.tokenId,
      gas_pol: gas.eth,
      pusd_balance: pUsd.pUsd,
      best_bid: sortedBids[0],
      best_ask: sortedAsks[0],
      bids_top3: sortedBids,
      asks_top3: sortedAsks,
      spread: sortedBids[0] && sortedAsks[0] ? +(sortedAsks[0].price - sortedBids[0].price).toFixed(4) : null,
    }),
  );

  if (args.dryRun) {
    console.log(
      JSON.stringify({
        msg: 'force_poly.dry_run_ok',
        hint: 'Wiring verified: signer constructed, balances readable, orderbook fetched. No order submitted.',
      }),
    );
    return;
  }

  const resp =
    args.side === 'buy'
      ? await client.marketBuy({
          tokenId: args.tokenId,
          usdcAmount: args.amount,
          tickSize: args.tickSize,
        })
      : await client.marketSell({
          tokenId: args.tokenId,
          shares: args.amount,
          tickSize: args.tickSize,
        });

  console.log(JSON.stringify({ msg: 'force_poly.ok', resp }));
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      msg: 'force_poly.fatal',
      err: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    }),
  );
  process.exit(1);
});
