/**
 * Setup script for the Hyperliquid operator account.
 *
 * Unlike Polymarket, Hyperliquid doesn't require API-key bootstrap — the
 * EOA private key itself signs all order placements via EIP-712. So this
 * script's role is just to:
 *
 *   1. Confirm HL_PRIVATE_KEY is set + well-formed.
 *   2. Confirm the wallet has been funded via the Arbitrum bridge.
 *   3. Confirm the bot can read clearinghouse state + meta from the L1.
 *   4. Persist the account context to `data/hl-operator.json` so the
 *      operator can sanity-check the on-disk record.
 *
 * Usage:
 *   pnpm --filter svx-bot setup-hl-account
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, dataPath } from '../src/config.js';
import { HyperliquidExecClient } from '../src/exec/hyperliquid-client.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new HyperliquidExecClient();
  const [balance, btcIdx, mid] = await Promise.all([
    client.getBalance(),
    client.getAssetIndex('BTC'),
    client.getMid('BTC'),
  ]);

  if (balance.accountValueUsdc <= 0) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        msg: 'hl_setup.unfunded',
        address: client.address,
        network: client.endpoints.network,
        hint: 'Account exists but has $0 USDC. Bridge USDC from Arbitrum at https://app.hyperliquid.xyz/bridge.',
      }),
    );
    process.exit(1);
  }

  const outPath = dataPath('hl-operator.json', cfg);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        address: client.address,
        network: client.endpoints.network,
        apiUrl: client.endpoints.apiUrl,
        btcAssetIndex: btcIdx,
        accountValueAtSetup: balance.accountValueUsdc,
        createdAtMs: Date.now(),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        msg: 'hl_setup.ok',
        address: client.address,
        network: client.endpoints.network,
        accountValueUsdc: balance.accountValueUsdc,
        withdrawableUsdc: balance.withdrawableUsdc,
        btcMidUsd: mid,
        btcAssetIndex: btcIdx,
        persistedTo: outPath,
        next_steps: [
          'Run `pnpm --filter svx-bot force-hl-trade -- --size=0.0001 --side=short --dry-run` to verify wiring',
          'Set HL_EXECUTION_ENABLED=true in Coolify (or .env) when ready for live hedges',
        ],
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
      msg: 'hl_setup.fatal',
      err: e instanceof Error ? e.message : String(e),
    }),
  );
  process.exit(1);
});
