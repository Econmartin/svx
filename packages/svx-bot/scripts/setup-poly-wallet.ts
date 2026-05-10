/**
 * One-time setup: bootstrap (or recover) Polymarket L2 API credentials for
 * the EVM operator and persist them to `data/poly-operator.json`.
 *
 * Usage (from repo root): pnpm --filter svx-bot setup-poly-wallet
 *
 * Prereqs:
 *   - POLY_PRIVATE_KEY set in .env (use `pnpm --filter svx-bot generate-poly-wallet` first).
 *   - POLY_NETWORK in {amoy, polygon} — defaults to amoy. Use amoy first.
 *   - The wallet must be funded with native gas (MATIC/POL) on the chosen
 *     network. We need ~$0.01 of gas to sign the API key derivation.
 *     Amoy MATIC faucet: https://faucet.polygon.technology/
 *
 * Idempotent: if data/poly-operator.json already exists for this network we
 * refuse to overwrite. Delete the file by hand to re-bootstrap.
 */

import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, dataPath } from '../src/config.js';
import { loadPolyOperatorKey, derivePolyEndpoints } from '../src/exec/polymarket-keypair.js';
import { PolymarketExecClient } from '../src/exec/polymarket-client.js';

interface PolyOperatorRecord {
  operatorAddress: `0x${string}`;
  network: 'amoy' | 'polygon';
  chainId: 80002 | 137;
  clobHost: string;
  rpcUrl: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  createdAtMs: number;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const endpoints = derivePolyEndpoints(cfg);
  const file = dataPath(`poly-operator.${endpoints.network}.json`, cfg);

  // Cause a clean failure now if POLY_PRIVATE_KEY is missing/malformed —
  // before any network calls happen.
  const { address } = loadPolyOperatorKey(cfg);

  console.log(
    JSON.stringify({
      msg: 'setup_poly.start',
      address,
      network: endpoints.network,
      chainId: endpoints.chainId,
      clobHost: endpoints.clobHost,
      file,
    }),
  );

  if (fs.existsSync(file)) {
    const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as PolyOperatorRecord;
    console.log(
      JSON.stringify({
        msg: 'setup_poly.already_exists',
        address: existing.operatorAddress,
        apiKeyPrefix: existing.apiKey.slice(0, 6) + '…',
        file,
        hint: `Delete ${file} to re-bootstrap (existing API key will be retained on Polymarket — derive will recover it).`,
      }),
    );
    return;
  }

  const client = new PolymarketExecClient(cfg);

  // Cheap balance check — gives the operator a clear error if the wallet
  // isn't funded for gas before they wait for the API call to fail.
  const gas = await client.getGasBalance();
  console.log(
    JSON.stringify({ msg: 'setup_poly.gas_balance', native: gas.eth, network: endpoints.network }),
  );
  if (gas.wei === 0n) {
    console.error(
      JSON.stringify({
        msg: 'setup_poly.no_gas',
        hint:
          endpoints.network === 'amoy'
            ? `Fund ${address} with Amoy MATIC at https://faucet.polygon.technology/ then re-run.`
            : `Fund ${address} with Polygon MATIC (~0.5 is plenty) then re-run.`,
      }),
    );
    process.exit(1);
  }

  const creds = await client.bootstrapApiKey();

  const record: PolyOperatorRecord = {
    operatorAddress: address,
    network: endpoints.network,
    chainId: endpoints.chainId,
    clobHost: endpoints.clobHost,
    rpcUrl: endpoints.rpcUrl,
    apiKey: creds.key,
    apiSecret: creds.secret,
    apiPassphrase: creds.passphrase,
    createdAtMs: Date.now(),
  };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });

  console.log(
    JSON.stringify({
      msg: 'setup_poly.persisted',
      file,
      apiKeyPrefix: creds.key.slice(0, 6) + '…',
      hint:
        'For Coolify/headless: also copy POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE into the deploy environment so the bot does not need to read this file.',
    }),
  );
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      msg: 'setup_poly.fatal',
      err: e instanceof Error ? e.message : String(e),
    }),
  );
  process.exit(1);
});
