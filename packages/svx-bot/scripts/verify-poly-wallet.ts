/**
 * Sanity-check the Polymarket wallet address from multiple sources before
 * sending real money to it. Compares:
 *
 *   1. Address derived from POLY_PRIVATE_KEY in .env
 *   2. Address persisted in data/poly-operator.<network>.json
 *
 * Prints both in EIP-55 checksum format so character-by-character compare
 * is easy. Also prints explorer links so you can confirm there's nothing
 * weird at the address (e.g. it's a brand-new wallet with 0 balance, not
 * someone else's wallet you might be sending to by mistake).
 *
 * Usage:
 *   pnpm --filter svx-bot verify-poly-wallet
 */

import fs from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, dataPath } from '../src/config.js';
import { derivePolyEndpoints } from '../src/exec/polymarket-keypair.js';

function main(): void {
  const cfg = loadConfig();
  const endpoints = derivePolyEndpoints(cfg);

  const pk = process.env.POLY_PRIVATE_KEY;
  if (!pk) {
    console.error('POLY_PRIVATE_KEY missing from env. Set it in .env first.');
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk.trim())) {
    console.error('POLY_PRIVATE_KEY is malformed (must be 0x + 64 hex chars).');
    process.exit(1);
  }

  const envAddr = privateKeyToAccount(pk.trim() as `0x${string}`).address;

  const file = dataPath(`poly-operator.${endpoints.network}.json`, cfg);
  const fileAddr = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, 'utf8')).operatorAddress as string | undefined)
    : undefined;

  // Same EVM address works on both networks. Show both explorer links so
  // the user can sanity-check whichever chain they're funding right now.
  const lines = [
    '',
    '─'.repeat(72),
    '  POLYMARKET WALLET VERIFICATION',
    '─'.repeat(72),
    '',
    `  From POLY_PRIVATE_KEY:        ${envAddr}`,
    `  From ${file
      .split('/')
      .slice(-2)
      .join('/')}:  ${fileAddr ?? '(file not found — run setup-poly-wallet first)'}`,
    '',
    `  Match (env vs file):          ${
      fileAddr ? (envAddr.toLowerCase() === fileAddr.toLowerCase() ? '✓ YES' : '✗ NO — STOP') : '— (no file yet)'
    }`,
    '',
    '  Same EVM address works on both Polygon mainnet AND Amoy testnet.',
    '  Check the explorer for whichever network you are funding now:',
    '',
    `    Mainnet (REAL MONEY): https://polygonscan.com/address/${envAddr}`,
    `    Amoy (testnet):       https://amoy.polygonscan.com/address/${envAddr}`,
    '',
    '  Before sending real money:',
    '  • Open the mainnet explorer link — confirm the address has',
    '    little/no on-chain history (a fresh wallet you generated).',
    '  • Compare the address above to the one you saved in 1Password',
    '    when you first ran generate-poly-wallet.',
    '  • Triple-check the network on Kraken says POLYGON before submitting.',
    '',
    '─'.repeat(72),
    '',
  ];
  console.log(lines.join('\n'));
}

main();
