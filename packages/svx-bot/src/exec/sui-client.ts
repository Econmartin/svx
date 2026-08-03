/**
 * Sui chain client — gRPC (`sui.rpc.v2`).
 *
 * Sui deprecated JSON-RPC on its own fullnodes in July 2026 (the outage that
 * took our V1 integration down), and DeepBook's Predict SDK reads state over
 * gRPC with no server in between. This module is the single place the bot
 * constructs a chain client, so the transport choice is one edit, not thirty.
 *
 * `SUI_GRPC_URL` overrides the endpoint; the default is the network's public
 * fullnode, which serves gRPC even though its JSON-RPC port returns 404.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';

export type SuiChainClient = SuiGrpcClient;

let cached: SuiGrpcClient | undefined;

export function suiGrpcUrl(): string {
  return process.env.SUI_GRPC_URL ?? 'https://fullnode.testnet.sui.io:443';
}

export function makeSuiClient(): SuiChainClient {
  if (cached) return cached;
  cached = new SuiGrpcClient({
    network: (process.env.SUI_NETWORK as 'testnet' | 'mainnet') ?? 'testnet',
    baseUrl: suiGrpcUrl(),
  });
  return cached;
}

/** dUSDC-style balance in whole units (gRPC returns base units as a string). */
export async function readCoinBalance(
  sui: SuiChainClient,
  owner: string,
  coinType: string,
  unit: number,
): Promise<number> {
  const res = await sui.getBalance({ owner, coinType });
  const raw = res.balance?.balance ?? '0';
  return Number(raw) / unit;
}

/** Owned coin object ids for a coin type (gRPC `listCoins`). */
export async function listCoinObjectIds(
  sui: SuiChainClient,
  owner: string,
  coinType: string,
): Promise<string[]> {
  const res = await sui.listCoins({ owner, coinType });
  return (res.objects ?? [])
    .map((o) => o.objectId)
    .filter((id): id is string => typeof id === 'string');
}

/** Parsed Move object contents (`json`), or null when unreadable. */
export async function readObjectJson<T = Record<string, unknown>>(
  sui: SuiChainClient,
  objectId: string,
): Promise<T | null> {
  try {
    const res = await sui.getObject({ objectId, include: { json: true } });
    return (res.object?.json as T) ?? null;
  } catch {
    return null;
  }
}

/** Object type string (`0xpkg::module::Struct`), or null. */
export async function readObjectType(
  sui: SuiChainClient,
  objectId: string,
): Promise<string | null> {
  try {
    const res = await sui.getObject({ objectId });
    return res.object?.type ?? null;
  } catch {
    return null;
  }
}
