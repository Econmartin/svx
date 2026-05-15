/**
 * Re-derive Polymarket L2 API credentials bound to a POLY_1271 deposit wallet.
 *
 * Background — Polymarket Deposit Wallet (DW) rollout (May 2026):
 *   New polymarket.com accounts get a smart-contract wallet (DW) that
 *   verifies signatures via EIP-1271. The on-chain DW address is what
 *   the CLOB sees as the order's `maker` / `signer`. For orders to fill,
 *   the L2 API key must be bound to that DW address.
 *
 *   The TS SDK's top-level `client.createApiKey()` has a known bug
 *   (https://github.com/Polymarket/clob-client-v2/issues/67) where it
 *   calls `createL1Headers` WITHOUT passing the `address` argument, so
 *   the L1 auth payload signs as the EOA → API key gets bound to EOA →
 *   orders submitted with `signer = DW` get rejected with:
 *     "the order signer address has to be the address of the API KEY"
 *     "maker address not allowed, please use the deposit wallet flow"
 *
 *   The low-level `createL1Headers` DOES accept `address` — we just call
 *   it directly with the DW address and POST to /auth/api-key ourselves.
 *
 * Usage:
 *   POLY_PRIVATE_KEY=0x...               # EOA signer
 *   POLY_FUNDER_ADDRESS=0x...            # the DW / proxy
 *   POLY_NETWORK=polygon                 # or 'amoy'
 *
 *   pnpm --filter svx-bot derive-poly-api-key-1271
 *
 * Output: prints + persists new {apiKey, secret, passphrase} to
 *   data/poly-operator.<network>.json (replacing whatever's there).
 *
 * After this, set POLY_API_KEY/SECRET/PASSPHRASE (or the
 * MAINNET_POLY_API_* equivalents in Coolify) to the new values, set
 * POLY_SIGNATURE_TYPE=POLY_1271, then orders should fill.
 */

import fs from 'node:fs';
import { createWalletClient, http, type WalletClient } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createL1Headers } from '@polymarket/clob-client-v2';
import { loadConfig, dataPath } from '../src/config.js';

interface ApiKeyResponse {
  apiKey?: string;
  key?: string;
  secret?: string;
  passphrase?: string;
  error?: string;
  [k: string]: unknown;
}

async function postWithHeaders(
  url: string,
  headers: Record<string, string>,
  method: 'POST' | 'GET' = 'POST',
): Promise<{ status: number; body: ApiKeyResponse }> {
  const res = await fetch(url, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let body: ApiKeyResponse = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  const pk = process.env.POLY_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk.trim())) {
    throw new Error('POLY_PRIVATE_KEY missing or malformed (0x + 64 hex chars)');
  }
  const proxy = cfg.polyFunderAddress;
  if (!proxy || !/^0x[0-9a-fA-F]{40}$/.test(proxy)) {
    throw new Error(
      'POLY_FUNDER_ADDRESS missing or malformed. Set it to your Deposit Wallet / proxy address (find via polymarket.com profile → Wallet, or in the page HTML as `proxyAddress`).',
    );
  }

  const network = cfg.polyNetwork;
  const chain = network === 'amoy' ? polygonAmoy : polygon;
  const chainId = network === 'amoy' ? 80002 : 137;
  const clobHost = network === 'amoy' ? 'https://clob-staging.polymarket.com' : 'https://clob.polymarket.com';

  const account = privateKeyToAccount(pk.trim() as `0x${string}`);
  const eoaAddress = account.address;
  const walletClient: WalletClient = createWalletClient({ account, chain, transport: http() });

  if (proxy.toLowerCase() === eoaAddress.toLowerCase()) {
    throw new Error(
      'POLY_FUNDER_ADDRESS equals the EOA address. POLY_1271 requires a DEPLOYED smart-contract wallet (the DW / proxy), not the EOA itself.',
    );
  }

  console.log(
    JSON.stringify(
      {
        msg: 'derive_1271.start',
        eoa: eoaAddress,
        proxy,
        chainId,
        clobHost,
      },
      null,
      2,
    ),
  );

  // Build L1 auth headers with `address = proxy`. The EOA signs an EIP-712
  // ClobAuth typed-data payload whose `address` field is the proxy. The
  // CLOB will verify the signature via EIP-1271 against the proxy contract
  // and, if valid, bind the resulting API key to the proxy address.
  const nonce = 0;
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = await createL1Headers(
    walletClient as unknown as Parameters<typeof createL1Headers>[0],
    chainId,
    nonce,
    timestamp,
    proxy,
  );

  console.log(
    JSON.stringify({
      msg: 'derive_1271.headers',
      POLY_ADDRESS: headers.POLY_ADDRESS,
      POLY_TIMESTAMP: headers.POLY_TIMESTAMP,
      POLY_NONCE: headers.POLY_NONCE,
      sig_prefix: headers.POLY_SIGNATURE.slice(0, 10) + '…',
    }),
  );
  if (headers.POLY_ADDRESS.toLowerCase() !== proxy.toLowerCase()) {
    throw new Error(
      `Sanity check failed: POLY_ADDRESS header (${headers.POLY_ADDRESS}) != proxy (${proxy}). SDK behavior changed?`,
    );
  }

  // Try create-api-key first. If the key already exists for this address,
  // Polymarket returns a status that prompts us to derive instead.
  const createUrl = `${clobHost}/auth/api-key`;
  console.log(JSON.stringify({ msg: 'derive_1271.create.try', url: createUrl }));
  let result = await postWithHeaders(createUrl, headers, 'POST');
  console.log(JSON.stringify({ msg: 'derive_1271.create.result', status: result.status, body: result.body }));

  // The SDK falls back to derive when create returns no `key`. Same here.
  const looksLikeNoKey = result.status >= 400 || !(result.body.apiKey || result.body.key);
  if (looksLikeNoKey) {
    const deriveUrl = `${clobHost}/auth/derive-api-key`;
    console.log(JSON.stringify({ msg: 'derive_1271.derive.try', url: deriveUrl }));
    result = await postWithHeaders(deriveUrl, headers, 'GET');
    console.log(JSON.stringify({ msg: 'derive_1271.derive.result', status: result.status, body: result.body }));
  }

  const apiKey = result.body.apiKey ?? result.body.key;
  const secret = result.body.secret;
  const passphrase = result.body.passphrase;
  if (!apiKey || !secret || !passphrase) {
    throw new Error(
      `Could not derive 1271-bound API creds. Last response: ${JSON.stringify(result.body)}`,
    );
  }

  // Persist + print.
  const outPath = dataPath(`poly-operator.${network}.json`, cfg);
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const next = {
    ...existing,
    operatorAddress: eoaAddress,
    funderAddress: proxy,
    signatureType: 'POLY_1271',
    network,
    apiKey,
    apiSecret: secret,
    apiPassphrase: passphrase,
    rotatedAtMs: Date.now(),
  };
  fs.writeFileSync(outPath, JSON.stringify(next, null, 2) + '\n', 'utf8');

  console.log(
    JSON.stringify(
      {
        msg: 'derive_1271.ok',
        apiKey,
        secret,
        passphrase,
        persistedTo: outPath,
        next_steps: [
          'Update local .env: POLY_API_KEY, POLY_API_SECRET, POLY_API_PASSPHRASE',
          'Update local .env: POLY_SIGNATURE_TYPE=POLY_1271',
          'Update Coolify: MAINNET_POLY_API_KEY / MAINNET_POLY_API_SECRET / MAINNET_POLY_API_PASSPHRASE',
          'Update Coolify: MAINNET_POLY_SIGNATURE_TYPE=POLY_1271',
          'Re-run force-poly-trade locally to confirm orders fill',
          'pnpm --filter svx-bot resume on bot-mainnet',
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'derive_1271.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
