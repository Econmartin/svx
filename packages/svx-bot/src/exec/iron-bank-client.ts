/**
 * iron_bank::* — typed PTB stubs for the USDsui supply protocol.
 *
 * Paper-mode only in v1. The strategy/margin-lever loop calls these to
 * describe what would be submitted; no transactions are signed or sent.
 * Live mode is a follow-up step that requires the operator to fund
 * USDsui supply first.
 *
 * Source: https://docs.sui.io/onchain-finance/
 */

/** Description of an iron_bank::supply intent. */
export interface IronBankSupplyIntent {
  kind: 'iron_bank::supply';
  /** USDsui amount (raw units, 6 decimals on mainnet). */
  amountRaw: bigint;
  /** Operator's Sui address — recipient of the resulting share token. */
  operator: string;
  /** Optional ISO timestamp for the intent. */
  createdAt?: string;
}

/** Description of an iron_bank::withdraw intent. */
export interface IronBankWithdrawIntent {
  kind: 'iron_bank::withdraw';
  /** Share-token amount (raw units). */
  shareAmountRaw: bigint;
  /** Operator's Sui address — recipient of the unwound USDsui. */
  operator: string;
  createdAt?: string;
}

/**
 * Build a paper-mode `iron_bank::supply` intent. Does not construct a
 * SuiClient TransactionBlock — that's reserved for the live integration
 * which requires the package id + share-token type id to be known. The
 * returned intent is what the strategy ledgers, and what tests snapshot.
 */
export function buildIronBankSupplyIntent(
  amountRaw: bigint,
  operator: string,
): IronBankSupplyIntent {
  if (amountRaw <= 0n) throw new Error(`iron_bank.supply.amount_non_positive ${amountRaw}`);
  if (!operator) throw new Error('iron_bank.supply.operator_missing');
  return { kind: 'iron_bank::supply', amountRaw, operator };
}

export function buildIronBankWithdrawIntent(
  shareAmountRaw: bigint,
  operator: string,
): IronBankWithdrawIntent {
  if (shareAmountRaw <= 0n)
    throw new Error(`iron_bank.withdraw.share_amount_non_positive ${shareAmountRaw}`);
  if (!operator) throw new Error('iron_bank.withdraw.operator_missing');
  return { kind: 'iron_bank::withdraw', shareAmountRaw, operator };
}
