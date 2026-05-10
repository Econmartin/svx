/**
 * Generate a fresh EVM keypair for the Polymarket execution leg.
 *
 * Prints address + private key to stdout ONCE. Does not persist the private
 * key — the operator MUST save it (1Password or equivalent) before closing
 * the terminal. There is no recovery if it is lost.
 *
 * Usage (from repo root):
 *   pnpm --filter svx-bot generate-poly-wallet
 *
 * Or from packages/svx-bot:
 *   npm run generate-poly-wallet
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

function main(): void {
  if (process.env.POLY_PRIVATE_KEY) {
    console.error(
      [
        'POLY_PRIVATE_KEY is already set in the environment. Refusing to',
        'generate a new wallet — this would replace the existing one and you',
        'would lose access to any funds at the old address.',
        '',
        'If you really want a fresh wallet, unset POLY_PRIVATE_KEY first.',
      ].join('\n'),
    );
    process.exit(1);
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const lines = [
    '',
    '='.repeat(72),
    '  FRESH POLYMARKET WALLET — SAVE THIS NOW',
    '='.repeat(72),
    '',
    `  Address:      ${account.address}`,
    `  Private key:  ${privateKey}`,
    '',
    '-'.repeat(72),
    '',
    '  WHAT TO DO NOW:',
    '',
    '  1. Save the PRIVATE KEY in 1Password (or equivalent). If you lose it,',
    '     any funds at this address are gone forever — there is no recovery.',
    '',
    '  2. Add it to your local .env:',
    `       POLY_PRIVATE_KEY=${privateKey}`,
    '',
    '  3. Add it as a Coolify secret when ready to deploy.',
    '',
    '  4. Send the ADDRESS to the bot operator so funding can be set up.',
    '',
    '  This output will NOT be persisted. Copy it before closing the terminal.',
    '',
    '='.repeat(72),
    '',
  ];
  console.log(lines.join('\n'));
}

main();
