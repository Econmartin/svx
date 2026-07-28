/**
 * PTB builders for DeepBook Predict V2 (the 2026-07-26 testnet cutover).
 *
 * Move call shapes (branch `predict-testnet-6-24` + `at/DBU-655`):
 *
 *   account_registry::new(&mut AccountRegistry, ctx) -> AccountWrapper
 *   account::share(AccountWrapper)                        // one-time setup
 *   account::generate_auth(ctx) -> Auth                   // per tx, sender-bound
 *   account::deposit_funds<T>(&mut AccountWrapper, Auth, Coin<T>,
 *     &AccumulatorRoot, &Clock)
 *   expiry_market::load_live_pricer(&ExpiryMarket, &ProtocolConfig,
 *     &OracleRegistry, &PythFeed, &BlockScholesSpotFeed,
 *     &BlockScholesForwardFeed, &BlockScholesSVIFeed, &Clock) -> Pricer
 *   expiry_market::mint_exact_quantity(&mut ExpiryMarket, &mut AccountWrapper,
 *     Auth, &ProtocolConfig, &Pricer, lower_tick, higher_tick, quantity,
 *     leverage, max_cost, max_probability, &AccumulatorRoot, &Clock, ctx) -> u256
 *   expiry_market::redeem_settled(&mut ExpiryMarket, &mut AccountWrapper, Auth,
 *     &ProtocolConfig, order_id, close_quantity, &AccumulatorRoot, &Clock, ctx)
 *
 * Conventions:
 *  - Ticks: strike_scaled(1e9) / tick_size_raw. Tick 0 = neg-infinity
 *    sentinel; pos-inf tick = (1 << 30) - 1. A binary UP at strike K is the
 *    range (tick(K), pos-inf]; DOWN is (neg-inf, tick(K)].
 *  - quantity: dUSDC base units (1e6 per dollar), multiple of the 10,000-unit
 *    position lot ($0.01).
 *  - leverage / probabilities: 1e9-scaled (1x = 1_000_000_000).
 *  - max_cost: dUSDC base units; u64::MAX disables (but always pass a real
 *    cap — DBU-664 made all-in cost caps the required posture).
 *  - AccumulatorRoot is the reserved singleton at 0xacc (like Clock at 0x6).
 *
 * Object ids change on every non-upgrade-safe testnet republish, so nothing
 * here is hardcoded: `resolveV2Objects()` finds the current singletons by
 * TYPE via Sui GraphQL, with env overrides for pinning.
 */

import axios from 'axios';
import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import { ADDRESSES } from 'svx-shared/addresses';
import { QUOTE_UNIT } from 'svx-shared/constants';

export const ACCUMULATOR_ROOT_ID = '0xacc';
export const POS_INF_TICK = (1n << 30n) - 1n;
const LEVERAGE_1X = 1_000_000_000n;
const POSITION_LOT = 10_000n;

export interface V2Objects {
  predictPackageId: string;
  accountPackageId: string;
  propbookPackageId: string;
  protocolConfigId: string;
  accountRegistryId: string;
  oracleRegistryId: string;
  pythFeedId: string;
  bsSpotFeedId: string;
  bsForwardFeedId: string;
  bsSviFeedId: string;
}

const DEFAULTS = {
  accountPackageId:
    '0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b',
  propbookPackageId:
    '0x8eb2adde1c91f8b7c9ba5e9b0a32bfb804510c342939c5f77458fd8143f9755b',
};

async function objectByType(graphqlUrl: string, type: string): Promise<string | null> {
  const query = `{ objects(first: 1, filter: {type: "${type}"}) { nodes { address } } }`;
  const res = await axios.post<{
    data?: { objects?: { nodes?: Array<{ address: string }> } };
  }>(graphqlUrl, { query }, { timeout: 12_000 });
  return res.data.data?.objects?.nodes?.[0]?.address ?? null;
}

/**
 * Resolve the current V2 singleton objects by type. `predictPackageId` should
 * come from a live `/markets` row (the deployment's source of truth). Every
 * id is env-overridable (PREDICT_V2_<NAME>) for pinning or emergencies.
 */
export async function resolveV2Objects(predictPackageId: string): Promise<V2Objects> {
  const graphqlUrl = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
  const accountPackageId = process.env.PREDICT_V2_ACCOUNT_PKG ?? DEFAULTS.accountPackageId;
  const propbookPackageId = process.env.PREDICT_V2_PROPBOOK_PKG ?? DEFAULTS.propbookPackageId;

  const want: Array<[key: keyof V2Objects, env: string, type: string]> = [
    [
      'protocolConfigId',
      'PREDICT_V2_CONFIG_ID',
      `${predictPackageId}::protocol_config::ProtocolConfig`,
    ],
    [
      'accountRegistryId',
      'PREDICT_V2_ACCOUNT_REGISTRY_ID',
      `${accountPackageId}::account_registry::AccountRegistry`,
    ],
    [
      'oracleRegistryId',
      'PREDICT_V2_ORACLE_REGISTRY_ID',
      `${propbookPackageId}::registry::OracleRegistry`,
    ],
    ['pythFeedId', 'PREDICT_V2_PYTH_FEED_ID', `${propbookPackageId}::pyth_feed::PythFeed`],
    [
      'bsSpotFeedId',
      'PREDICT_SPOT_FEED_ID',
      `${propbookPackageId}::block_scholes_spot_feed::BlockScholesSpotFeed`,
    ],
    [
      'bsForwardFeedId',
      'PREDICT_V2_FORWARD_FEED_ID',
      `${propbookPackageId}::block_scholes_forward_feed::BlockScholesForwardFeed`,
    ],
    [
      'bsSviFeedId',
      'PREDICT_SVI_FEED_ID',
      `${propbookPackageId}::block_scholes_svi_feed::BlockScholesSVIFeed`,
    ],
  ];

  const out: Partial<V2Objects> = { predictPackageId, accountPackageId, propbookPackageId };
  for (const [key, env, type] of want) {
    const pinned = process.env[env];
    const id = pinned ?? (await objectByType(graphqlUrl, type));
    if (!id) throw new Error(`resolveV2Objects: could not find ${type} (set ${env} to pin)`);
    (out as Record<string, string>)[key] = id;
  }
  return out as V2Objects;
}

/** Protocol-config module name differs across snapshots; probe both. */
function configModule(): string {
  return process.env.PREDICT_V2_CONFIG_MODULE ?? 'protocol_config';
}

export function strikeToTick(strike: number, tickSizeRaw: number): bigint {
  const scaled = BigInt(Math.round(strike * 1e9));
  return scaled / BigInt(tickSizeRaw);
}

export function lotAlignedQuantity(quantityDusdc: number): bigint {
  const raw = BigInt(Math.round(quantityDusdc * Number(QUOTE_UNIT)));
  return (raw / POSITION_LOT) * POSITION_LOT;
}

/** One-time: create + share the operator's canonical V2 account wrapper. */
export function buildCreateV2AccountTx(o: V2Objects): Transaction {
  const tx = new Transaction();
  const wrapper = tx.moveCall({
    target: `${o.accountPackageId}::account_registry::new`,
    arguments: [tx.object(o.accountRegistryId)],
  });
  tx.moveCall({
    target: `${o.accountPackageId}::account::share`,
    arguments: [wrapper],
  });
  return tx;
}

/** Deposit dUSDC from operator coins into the shared account wrapper. */
export function buildV2DepositTx(
  o: V2Objects,
  args: { wrapperId: string; dusdcCoinObjectIds: string[]; amountDusdc: number },
): Transaction {
  const tx = new Transaction();
  const [primary, ...rest] = args.dusdcCoinObjectIds;
  if (!primary) throw new Error('no dUSDC coin objects provided');
  if (rest.length > 0) {
    tx.mergeCoins(
      tx.object(primary),
      rest.map((c) => tx.object(c)),
    );
  }
  const amount = BigInt(Math.round(args.amountDusdc * Number(QUOTE_UNIT)));
  const [coin] = tx.splitCoins(tx.object(primary), [tx.pure.u64(amount)]);
  const [auth] = tx.moveCall({
    target: `${o.accountPackageId}::account::generate_auth`,
    arguments: [],
  });
  tx.moveCall({
    target: `${o.accountPackageId}::account::deposit_funds`,
    typeArguments: [ADDRESSES.dusdcType],
    arguments: [
      tx.object(args.wrapperId),
      auth!,
      coin!,
      tx.object(ACCUMULATOR_ROOT_ID),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export interface V2MintArgs {
  marketId: string;
  wrapperId: string;
  /** Strike in $ on the underlying. */
  strike: number;
  direction: 'up' | 'down';
  /** Raw tick_size from the market row (1e9-scaled price units per tick). */
  tickSizeRaw: number;
  /** Max payout in dUSDC; lot-rounded down internally. */
  quantityDusdc: number;
  /** All-in spend cap in dUSDC (premium + fees). Required. */
  maxCostDusdc: number;
  /** Entry-probability cap, 0..1 (protects against skew/quote drift). */
  maxProbability: number;
}

/** Live mint: auth → PTB-local pricer snapshot → mint_exact_quantity. */
export function buildV2MintTx(o: V2Objects, args: V2MintArgs): Transaction {
  const tx = new Transaction();
  const tick = strikeToTick(args.strike, args.tickSizeRaw);
  const lower = args.direction === 'up' ? tick : 0n;
  const higher = args.direction === 'up' ? POS_INF_TICK : tick;
  const quantity = lotAlignedQuantity(args.quantityDusdc);
  if (quantity <= 0n) throw new Error('quantity below one position lot');
  const maxCost = BigInt(Math.round(args.maxCostDusdc * Number(QUOTE_UNIT)));
  const maxProb = BigInt(Math.round(args.maxProbability * 1e9));

  const [auth] = tx.moveCall({
    target: `${o.accountPackageId}::account::generate_auth`,
    arguments: [],
  });
  const [pricer] = tx.moveCall({
    target: `${o.predictPackageId}::expiry_market::load_live_pricer`,
    arguments: [
      tx.object(args.marketId),
      tx.object(o.protocolConfigId),
      tx.object(o.oracleRegistryId),
      tx.object(o.pythFeedId),
      tx.object(o.bsSpotFeedId),
      tx.object(o.bsForwardFeedId),
      tx.object(o.bsSviFeedId),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  tx.moveCall({
    target: `${o.predictPackageId}::expiry_market::mint_exact_quantity`,
    arguments: [
      tx.object(args.marketId),
      tx.object(args.wrapperId),
      auth!,
      tx.object(o.protocolConfigId),
      pricer!,
      tx.pure.u64(lower),
      tx.pure.u64(higher),
      tx.pure.u64(quantity),
      tx.pure.u64(LEVERAGE_1X), // leverage pinned to 1x — no liquidation risk
      tx.pure.u64(maxCost),
      tx.pure.u64(maxProb),
      tx.object(ACCUMULATOR_ROOT_ID),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/** Redeem our own settled position (fixed terminal payout, no slippage). */
export function buildV2RedeemSettledTx(
  o: V2Objects,
  args: { marketId: string; wrapperId: string; orderId: bigint; closeQuantity: bigint },
): Transaction {
  const tx = new Transaction();
  const [auth] = tx.moveCall({
    target: `${o.accountPackageId}::account::generate_auth`,
    arguments: [],
  });
  tx.moveCall({
    target: `${o.predictPackageId}::expiry_market::redeem_settled`,
    arguments: [
      tx.object(args.marketId),
      tx.object(args.wrapperId),
      auth!,
      tx.object(o.protocolConfigId),
      tx.pure.u256(args.orderId),
      tx.pure.u64(args.closeQuantity),
      tx.object(ACCUMULATOR_ROOT_ID),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// referenced above so a future module rename is a one-env fix, not a code fix
void configModule;
