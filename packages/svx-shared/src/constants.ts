/**
 * Protocol-level constants for DeepBook Predict.
 * Mirrors `deepbook_predict::constants` (Move).
 *
 * - Prices/probabilities use FLOAT_SCALING (1e9): 500_000_000 = 50%.
 * - Quote-asset units (dUSDC) have 6 decimals: 1_000_000 = $1.
 * - Quantities at mint are in *quote units*. At settlement, winners receive
 *   `quantity` directly (i.e. quantity is the max payout in quote units).
 */

export const FLOAT_SCALING = 1_000_000_000n; // 1e9
export const FLOAT_SCALING_NUM = 1_000_000_000;

/** dUSDC has 6 decimals on testnet (matches the Predict required quote decimals). */
export const QUOTE_DECIMALS = 6;
export const QUOTE_UNIT = 1_000_000n; // 1 dUSDC

export const MS_PER_YEAR = 31_536_000_000;

/** Default protocol bounds (mirrors Move defaults; can be overridden on-chain by admin). */
export const DEFAULT_MIN_ASK_PRICE_FRAC = 0.01; // 1%
export const DEFAULT_MAX_ASK_PRICE_FRAC = 0.99; // 99%

/** Oracle staleness threshold used by the protocol (~30s). */
export const PROTOCOL_STALENESS_THRESHOLD_MS = 30_000;
