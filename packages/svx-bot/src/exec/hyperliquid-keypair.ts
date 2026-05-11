/**
 * Hyperliquid EVM keypair loader.
 *
 * Hyperliquid uses an ordinary secp256k1 EVM keypair as the master account
 * identity. After bridging USDC into the L1 from Arbitrum, the wallet signs
 * EIP-712 typed payloads for order placement / cancellation via the
 * Exchange endpoint. There's no separate "API key" generation flow like
 * Polymarket's L2 creds — the private key IS the credential.
 *
 * Loads `HL_PRIVATE_KEY` from env (hex, 0x-prefixed, 64 hex chars). We
 * never log the private key — only the derived address.
 *
 * Network selection: `HL_NETWORK` env (`mainnet` | `testnet`). Defaults to
 * mainnet. Testnet endpoint is `api.hyperliquid-testnet.xyz`; mainnet is
 * `api.hyperliquid.xyz`. Both use the same key format.
 */

import type { PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { log } from '../util/log.js';

export type HlNetwork = 'mainnet' | 'testnet';

export interface HlEndpoints {
  network: HlNetwork;
  apiUrl: string;
}

const DEFAULTS: Record<HlNetwork, HlEndpoints> = {
  mainnet: { network: 'mainnet', apiUrl: 'https://api.hyperliquid.xyz' },
  testnet: { network: 'testnet', apiUrl: 'https://api.hyperliquid-testnet.xyz' },
};

export function deriveHlEndpoints(net?: HlNetwork): HlEndpoints {
  const n = net ?? ((process.env.HL_NETWORK ?? 'mainnet') as HlNetwork);
  return DEFAULTS[n === 'testnet' ? 'testnet' : 'mainnet'];
}

export interface LoadedHlKey {
  /** A viem local account — satisfies the SDK's `AbstractViemLocalAccount`
   *  (it has the required `signTypedData` method). */
  account: PrivateKeyAccount;
  address: `0x${string}`;
  endpoints: HlEndpoints;
}

let cached: LoadedHlKey | null = null;

export function loadHlOperatorKey(net?: HlNetwork): LoadedHlKey {
  if (cached) return cached;

  const raw = process.env.HL_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      'HL_PRIVATE_KEY is not set. Generate one with `pnpm --filter svx-bot generate-hl-wallet` and add it to .env.',
    );
  }
  const pk = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      'HL_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string (66 chars total).',
    );
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const endpoints = deriveHlEndpoints(net);

  cached = { account, address: account.address, endpoints };
  log.info('svx.hl_keypair.loaded', {
    address: account.address,
    network: endpoints.network,
    apiUrl: endpoints.apiUrl,
  });
  return cached;
}

/** For tests — clear cached keypair so a different env can be loaded. */
export function _resetHlKeyCache(): void {
  cached = null;
}
