/**
 * deepbook_margin::* — typed PTB stubs for the cross-margin layer on top
 * of DeepBook v3.
 *
 * Paper-mode only in v1. Same approach as iron-bank-client: emit typed
 * intent objects describing the four primitives the margin-lever
 * strategy composes (open account, deposit share-token collateral, borrow
 * dUSDC, take a DeepBook spot position, close, repay). The intents are
 * recorded as if they had been submitted; the live PTB construction
 * lands when the operator funds collateral.
 *
 * Source: https://docs.sui.io/onchain-finance/deepbook-margin
 */

export interface MarginAccountOpenIntent {
  kind: 'deepbook_margin::open_account';
  operator: string;
}

export interface MarginCollateralDepositIntent {
  kind: 'deepbook_margin::deposit_collateral';
  operator: string;
  /** Type tag of the share-token collateral being posted (e.g. iron_bank share). */
  collateralTypeTag: string;
  amountRaw: bigint;
}

export interface MarginBorrowIntent {
  kind: 'deepbook_margin::borrow';
  operator: string;
  /** Coin type to borrow (e.g. dUSDC). */
  coinTypeTag: string;
  amountRaw: bigint;
}

export interface MarginSpotTradeIntent {
  kind: 'deepbook_margin::spot_trade';
  operator: string;
  /** Pool id on DeepBook v3. */
  poolId: string;
  side: 'buy' | 'sell';
  /** Base-asset amount (e.g. BTC), raw units. */
  baseAmountRaw: bigint;
  /** Price hint for paper-mode bookkeeping; live mode reads the book. */
  pricePaperHint?: number;
}

export interface MarginRepayIntent {
  kind: 'deepbook_margin::repay';
  operator: string;
  coinTypeTag: string;
  amountRaw: bigint;
}

export type MarginLeverIntent =
  | MarginAccountOpenIntent
  | MarginCollateralDepositIntent
  | MarginBorrowIntent
  | MarginSpotTradeIntent
  | MarginRepayIntent;

/**
 * Compose the full open-leveraged-spot sequence the margin-lever
 * strategy would submit in one PTB. Returned as an ordered list of
 * intents — the order is the PTB call order.
 */
export function buildOpenLeveragedSpotIntent(args: {
  operator: string;
  collateralTypeTag: string;
  collateralAmountRaw: bigint;
  borrowCoinTypeTag: string;
  borrowAmountRaw: bigint;
  poolId: string;
  side: 'buy' | 'sell';
  baseAmountRaw: bigint;
  pricePaperHint?: number;
}): MarginLeverIntent[] {
  if (args.borrowAmountRaw <= 0n) throw new Error('margin.borrow.amount_non_positive');
  if (args.collateralAmountRaw <= 0n) throw new Error('margin.collateral.amount_non_positive');
  if (args.baseAmountRaw <= 0n) throw new Error('margin.trade.amount_non_positive');
  if (!args.operator) throw new Error('margin.operator_missing');
  if (!args.poolId) throw new Error('margin.pool_id_missing');
  return [
    { kind: 'deepbook_margin::open_account', operator: args.operator },
    {
      kind: 'deepbook_margin::deposit_collateral',
      operator: args.operator,
      collateralTypeTag: args.collateralTypeTag,
      amountRaw: args.collateralAmountRaw,
    },
    {
      kind: 'deepbook_margin::borrow',
      operator: args.operator,
      coinTypeTag: args.borrowCoinTypeTag,
      amountRaw: args.borrowAmountRaw,
    },
    {
      kind: 'deepbook_margin::spot_trade',
      operator: args.operator,
      poolId: args.poolId,
      side: args.side,
      baseAmountRaw: args.baseAmountRaw,
      pricePaperHint: args.pricePaperHint,
    },
  ];
}

/** Close-and-repay sequence. Reverses the spot leg and repays the loan. */
export function buildCloseAndRepayIntent(args: {
  operator: string;
  poolId: string;
  side: 'buy' | 'sell';
  baseAmountRaw: bigint;
  pricePaperHint?: number;
  borrowCoinTypeTag: string;
  repayAmountRaw: bigint;
}): MarginLeverIntent[] {
  if (args.baseAmountRaw <= 0n) throw new Error('margin.close.amount_non_positive');
  if (args.repayAmountRaw <= 0n) throw new Error('margin.repay.amount_non_positive');
  if (!args.operator) throw new Error('margin.operator_missing');
  if (!args.poolId) throw new Error('margin.pool_id_missing');
  return [
    {
      kind: 'deepbook_margin::spot_trade',
      operator: args.operator,
      poolId: args.poolId,
      side: args.side,
      baseAmountRaw: args.baseAmountRaw,
      pricePaperHint: args.pricePaperHint,
    },
    {
      kind: 'deepbook_margin::repay',
      operator: args.operator,
      coinTypeTag: args.borrowCoinTypeTag,
      amountRaw: args.repayAmountRaw,
    },
  ];
}
