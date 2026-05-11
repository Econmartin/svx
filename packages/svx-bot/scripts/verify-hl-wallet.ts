/**
 * Verify a Hyperliquid wallet is configured + funded. Reads HL_PRIVATE_KEY
 * from env, derives the address, hits HL's info endpoint for the
 * clearinghouse state, and prints account value + open positions.
 *
 * Usage:
 *   pnpm --filter svx-bot verify-hl-wallet
 */

import { loadConfig } from '../src/config.js';
import { HyperliquidExecClient } from '../src/exec/hyperliquid-client.js';

async function main(): Promise<void> {
  loadConfig(); // populate process.env from .env
  const client = new HyperliquidExecClient();
  const [balance, positions, mid] = await Promise.all([
    client.getBalance(),
    client.getOpenPositions(),
    client.getMid('BTC').catch(() => null),
  ]);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        msg: 'hl_verify.ok',
        address: client.address,
        network: client.endpoints.network,
        apiUrl: client.endpoints.apiUrl,
        accountValueUsdc: balance.accountValueUsdc,
        withdrawableUsdc: balance.withdrawableUsdc,
        btcMidUsd: mid,
        openPositions: positions,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      msg: 'hl_verify.fatal',
      err: e instanceof Error ? e.message : String(e),
    }),
  );
  process.exit(1);
});
