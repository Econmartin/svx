/**
 * PTB (Programmable Transaction Block) builders for DeepBook Predict.
 *
 * Move call signatures (per `predict-testnet-4-16`):
 *
 *   public fun create_manager(ctx) -> ID
 *
 *   public fun mint<Quote>(
 *     predict: &mut Predict,
 *     manager: &mut PredictManager,
 *     oracle: &OracleSVI,
 *     key: MarketKey,            // constructed inline via market_key::new
 *     quantity: u64,
 *     clock: &Clock,
 *     ctx,
 *   )
 *
 *   public fun redeem<Quote>(...)
 *   public fun redeem_permissionless<Quote>(...)
 *
 *   market_key::new(oracle_id: ID, expiry: u64, strike: u64, is_up: bool) -> MarketKey
 *
 * Quantity is denominated in *quote units* (dUSDC × 10^6). Strike is on the
 * Predict scale (× 1e9). Cost = quantity × ask_price (where ask is on 1e9
 * scale) — but the protocol withdraws cost from the manager's balance, so we
 * just need to ensure the manager has sufficient dUSDC.
 *
 * The manager's balance is topped up via `predict_manager::deposit<dUSDC>`
 * — but to call that we need the operator to be the sender. That's handled
 * inline in `buildMintTx` if a top-up is requested.
 */

import { Transaction } from '@mysten/sui/transactions';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import { ADDRESSES, type PredictAddresses } from 'svx-shared/addresses';
import { FLOAT_SCALING, QUOTE_UNIT } from 'svx-shared/constants';

export interface MintArgs {
  oracleId: string;
  expiryMs: number;
  /** Strike in $ on the underlying (will be scaled by 1e9 inside this fn). */
  strike: number;
  /** 'up' or 'down'. */
  direction: 'up' | 'down';
  /**
   * Notional in dUSDC (max payout). Will be converted to quote units (× 1e6).
   * Note: Predict's `quantity` parameter IS the dUSDC quote amount, so for $50
   * you pass `50_000_000` here. We accept the human-readable number and scale.
   */
  quantityDusdc: number;
  managerId: string;
  /** Optional dUSDC top-up to the manager before minting (in dUSDC). */
  topUpDusdc?: number;
  /** Coin object IDs the operator owns to use for top-up (if any). */
  dusdcCoinObjectIds?: string[];
  addresses?: PredictAddresses;
}

export interface RedeemArgs extends Omit<MintArgs, 'topUpDusdc' | 'dusdcCoinObjectIds'> {
  /** If true, build `redeem_permissionless` (only valid for settled oracles). */
  permissionless?: boolean;
}

export function buildMintTx(args: MintArgs): Transaction {
  const a = args.addresses ?? ADDRESSES;
  const tx = new Transaction();

  // Optional: top up the PredictManager from the operator's dUSDC wallet.
  if (args.topUpDusdc && args.topUpDusdc > 0) {
    if (!args.dusdcCoinObjectIds || args.dusdcCoinObjectIds.length === 0) {
      throw new Error(
        'topUpDusdc requested but no dusdcCoinObjectIds provided — fetch them via SuiClient.getCoins',
      );
    }
    const topUpUnits = bigintFromDusdc(args.topUpDusdc);
    // Merge all dUSDC coin objects into the first, then split off `topUpUnits`.
    const [primary, ...rest] = args.dusdcCoinObjectIds;
    if (!primary) throw new Error('no dUSDC coin object available');
    const primaryRef = tx.object(primary);
    if (rest.length > 0) {
      tx.mergeCoins(
        primaryRef,
        rest.map((id) => tx.object(id)),
      );
    }
    const [topUpCoin] = tx.splitCoins(primaryRef, [topUpUnits]);
    tx.moveCall({
      target: `${a.packageId}::predict_manager::deposit`,
      typeArguments: [a.dusdcType],
      arguments: [tx.object(args.managerId), topUpCoin],
    });
  }

  const key = tx.moveCall({
    target: `${a.packageId}::market_key::new`,
    arguments: [
      tx.pure.id(args.oracleId),
      tx.pure.u64(BigInt(args.expiryMs)),
      tx.pure.u64(scaledStrike(args.strike)),
      tx.pure.bool(args.direction === 'up'),
    ],
  });

  tx.moveCall({
    target: `${a.packageId}::predict::mint`,
    typeArguments: [a.dusdcType],
    arguments: [
      tx.object(a.predictObjectId),
      tx.object(args.managerId),
      tx.object(args.oracleId),
      key,
      tx.pure.u64(bigintFromDusdc(args.quantityDusdc)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildRedeemTx(args: RedeemArgs): Transaction {
  const a = args.addresses ?? ADDRESSES;
  const tx = new Transaction();

  const key = tx.moveCall({
    target: `${a.packageId}::market_key::new`,
    arguments: [
      tx.pure.id(args.oracleId),
      tx.pure.u64(BigInt(args.expiryMs)),
      tx.pure.u64(scaledStrike(args.strike)),
      tx.pure.bool(args.direction === 'up'),
    ],
  });

  const target = args.permissionless
    ? `${a.packageId}::predict::redeem_permissionless`
    : `${a.packageId}::predict::redeem`;

  tx.moveCall({
    target,
    typeArguments: [a.dusdcType],
    arguments: [
      tx.object(a.predictObjectId),
      tx.object(args.managerId),
      tx.object(args.oracleId),
      key,
      tx.pure.u64(bigintFromDusdc(args.quantityDusdc)),
      tx.object(SUI_CLOCK_OBJECT_ID),
    ],
  });

  return tx;
}

export function buildCreateManagerTx(addresses: PredictAddresses = ADDRESSES): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${addresses.packageId}::predict::create_manager`,
    arguments: [],
  });
  return tx;
}

function scaledStrike(strike: number): bigint {
  return BigInt(Math.round(strike * Number(FLOAT_SCALING)));
}

function bigintFromDusdc(dusdc: number): bigint {
  return BigInt(Math.round(dusdc * Number(QUOTE_UNIT)));
}
