/**
 * Generate a fresh Hyperliquid operator keypair. Mirrors `generate-poly-wallet`
 * but for the HL leg. Prints the address + private key once — copy the key
 * into `.env` as `HL_PRIVATE_KEY` and never expose it elsewhere.
 *
 * Hyperliquid doesn't have a separate "API key" derivation step like
 * Polymarket — the private key IS the credential. After this script you
 * still need to BRIDGE USDC into HL from Arbitrum (see mainnet-runbook §2.1)
 * before the account is usable.
 *
 * Usage:
 *   pnpm --filter svx-bot generate-hl-wallet
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

function main(): void {
  const pk = generatePrivateKey();
  const acc = privateKeyToAccount(pk);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        msg: 'hl_keygen.ok',
        address: acc.address,
        privateKey: pk,
        next_steps: [
          'Add HL_PRIVATE_KEY=<privateKey> to .env (or Coolify env panel)',
          'Bridge USDC into Hyperliquid from Arbitrum (https://app.hyperliquid.xyz/bridge)',
          'Sign once on https://app.hyperliquid.xyz to register the master account',
          'Run verify-hl-wallet to confirm USDC arrived',
        ],
      },
      null,
      2,
    ),
  );
}

main();
