/**
 * Polymarket EVM keypair loader + viem wallet client.
 *
 * Loads POLY_PRIVATE_KEY from env (hex, 0x-prefixed, 64 hex chars). Builds a
 * viem walletClient bound to either Amoy testnet or Polygon mainnet. The
 * walletClient is what the @polymarket/clob-client-v2 SDK accepts as a signer.
 *
 * We never log the private key — only the derived address.
 */

import type { Account, WalletClient } from 'viem';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import type { SvxConfig } from '../config.js';
import { log } from '../util/log.js';

export type PolyNetwork = 'amoy' | 'polygon';

export interface PolyEndpoints {
  network: PolyNetwork;
  chainId: 80002 | 137;
  clobHost: string;
  rpcUrl: string;
}

const DEFAULTS: Record<PolyNetwork, { clobHost: string; rpcUrl: string; chainId: 80002 | 137 }> = {
  amoy: {
    clobHost: 'https://clob-staging.polymarket.com',
    rpcUrl: 'https://rpc-amoy.polygon.technology',
    chainId: 80002,
  },
  polygon: {
    clobHost: 'https://clob.polymarket.com',
    // polygon-rpc.com now requires an API key; publicnode is open + reliable.
    rpcUrl: 'https://polygon-bor.publicnode.com',
    chainId: 137,
  },
};

export function derivePolyEndpoints(cfg: SvxConfig): PolyEndpoints {
  const net = cfg.polyNetwork;
  const def = DEFAULTS[net];
  return {
    network: net,
    chainId: def.chainId,
    clobHost: cfg.polyClobHost.trim() || def.clobHost,
    rpcUrl: cfg.polyRpcUrl.trim() || def.rpcUrl,
  };
}

export interface LoadedPolyKey {
  account: Account;
  address: `0x${string}`;
  walletClient: WalletClient;
  endpoints: PolyEndpoints;
}

let cached: LoadedPolyKey | null = null;

export function loadPolyOperatorKey(cfg: SvxConfig): LoadedPolyKey {
  if (cached) return cached;

  const raw = process.env.POLY_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      'POLY_PRIVATE_KEY is not set. Generate one with `pnpm --filter svx-bot generate-poly-wallet` and add it to .env.',
    );
  }
  const pk = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      'POLY_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string (66 chars total). Refusing to use a malformed key.',
    );
  }

  const endpoints = derivePolyEndpoints(cfg);
  const account = privateKeyToAccount(pk as `0x${string}`);
  const chain = endpoints.network === 'amoy' ? polygonAmoy : polygon;
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(endpoints.rpcUrl),
  });

  cached = { account, address: account.address, walletClient, endpoints };
  log.info('svx.poly_keypair.loaded', {
    address: account.address,
    network: endpoints.network,
    chainId: endpoints.chainId,
    clobHost: endpoints.clobHost,
  });
  return cached;
}

/** For tests — clear the cached keypair so a different env can be loaded. */
export function _resetPolyKeyCache(): void {
  cached = null;
}
