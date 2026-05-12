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
import { createPublicClient, http, parseAbi, formatUnits, type Address } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, dataPath } from '../src/config.js';
import { derivePolyEndpoints } from '../src/exec/polymarket-keypair.js';

const PUSD: Address = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
]);

async function main(): Promise<void> {
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

  // Read on-chain pUSD balance at both the signer (EOA) and the configured
  // funder (Safe in POLY_GNOSIS_SAFE mode). This is the diagnostic operators
  // use to confirm "is the money in the right place?" before flipping the
  // execution flag on.
  const chain = endpoints.network === 'amoy' ? polygonAmoy : polygon;
  const pub = createPublicClient({ chain, transport: http(endpoints.rpcUrl) });
  const eoaPusdRaw = await pub.readContract({
    address: PUSD,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [envAddr],
  });
  const eoaPusd = Number(formatUnits(eoaPusdRaw, 6));
  const funderAddr =
    cfg.polyFunderAddress && /^0x[0-9a-fA-F]{40}$/.test(cfg.polyFunderAddress)
      ? (cfg.polyFunderAddress as Address)
      : envAddr;
  const funderPusdRaw =
    funderAddr.toLowerCase() === envAddr.toLowerCase()
      ? eoaPusdRaw
      : await pub.readContract({
          address: PUSD,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [funderAddr],
        });
  const funderPusd = Number(formatUnits(funderPusdRaw, 6));

  const usingSafe =
    cfg.polySignatureType !== 'EOA' &&
    funderAddr.toLowerCase() !== envAddr.toLowerCase();

  const lines = [
    '',
    '─'.repeat(72),
    '  POLYMARKET WALLET VERIFICATION',
    '─'.repeat(72),
    '',
    `  Signature mode:               ${cfg.polySignatureType}`,
    '',
    `  Signer (EOA from PRIVATE_KEY):  ${envAddr}`,
    `    pUSD balance:                 ${eoaPusd.toFixed(6)}`,
    `    Explorer (mainnet):           https://polygonscan.com/address/${envAddr}`,
    '',
    usingSafe
      ? `  Funder (Safe / POLY_FUNDER):    ${funderAddr}`
      : `  Funder = Signer (EOA mode)`,
    usingSafe ? `    pUSD balance:                 ${funderPusd.toFixed(6)}` : '',
    usingSafe ? `    Explorer (mainnet):           https://polygonscan.com/address/${funderAddr}` : '',
    usingSafe ? '' : '',
    `  From persisted file:          ${fileAddr ?? '(file not found — run setup-poly-wallet first)'}`,
    `  Match (env vs file):          ${
      fileAddr ? (envAddr.toLowerCase() === fileAddr.toLowerCase() ? '✓ YES' : '✗ NO — STOP') : '— (no file yet)'
    }`,
    '',
    usingSafe
      ? '  Trading: orders are signed by the EOA + executed on behalf of the Safe.'
      : '  Trading: orders signed and funded by the same EOA.',
    usingSafe
      ? '  CLOB reads pUSD balance from the SAFE — must be > 0 for orders to fill.'
      : '  CLOB reads pUSD balance from the EOA — must be > 0 for orders to fill.',
    '',
    '─'.repeat(72),
    '',
  ];
  console.log(lines.filter((l) => l !== '').concat(['']).join('\n'));
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'verify_poly_wallet.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
