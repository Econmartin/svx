/**
 * Strike/tick helpers for DeepBook Predict mints.
 *
 * Every Predict transaction is now built by DeepBook's SDK
 * (`pricing/predict-sdk.ts`) — the hand-rolled PTBs that lived here targeted
 * the pre-launch testnet package and its 8-object pricer signature, which the
 * September 2026 mainnet release replaced. What stays is the one piece of
 * protocol knowledge the strategy layer needs BEFORE it builds anything:
 * which strikes the chain will admit.
 *
 * Conventions (unchanged on mainnet):
 *  - Ticks: strike_scaled(1e9) / tick_size_raw. Tick 0 = neg-infinity
 *    sentinel; pos-inf tick = (1 << 30) - 1. A binary UP at strike K is the
 *    range (tick(K), pos-inf]; DOWN is (neg-inf, tick(K)].
 *  - quantity: quote-coin base units (1e6 per dollar), multiple of the
 *    10,000-unit position lot ($0.01).
 */

import { QUOTE_UNIT } from 'svx-shared/constants';

export const POS_INF_TICK = (1n << 30n) - 1n;
const POSITION_LOT = 10_000n;

export function strikeToTick(strike: number, tickSizeRaw: number): bigint {
  const scaled = BigInt(Math.round(strike * 1e9));
  return scaled / BigInt(tickSizeRaw);
}

/**
 * Snap a tick onto the market's ADMISSION grid.
 *
 * `strike_exposure::assert_admitted_mint_ticks` accepts a bound only if it is
 * a sentinel (0 / pos-inf), the market's current reference tick, or a multiple
 * of `admission_tick_size / tick_size`. Our strikes come off a continuous SVI
 * grid, so an unsnapped tick aborts the mint (code 1).
 */
export function admissionMultiple(tickSizeRaw: number, admissionTickSizeRaw: number): bigint {
  const m = BigInt(Math.max(1, Math.round(admissionTickSizeRaw))) /
    BigInt(Math.max(1, Math.round(tickSizeRaw)));
  return m > 0n ? m : 1n;
}

export function snapTickToAdmission(
  tick: bigint,
  tickSizeRaw: number,
  admissionTickSizeRaw: number,
): bigint {
  const mult = admissionMultiple(tickSizeRaw, admissionTickSizeRaw);
  if (mult <= 1n) return tick;
  const rem = tick % mult;
  // Round to the NEAREST admitted tick so the traded strike stays as close as
  // possible to the one the strategy priced.
  const down = tick - rem;
  const up = down + mult;
  return rem * 2n >= mult ? up : down;
}

/** The strike actually tradeable for a requested strike (admission-snapped). */
export function admissibleStrike(
  strike: number,
  tickSizeRaw: number,
  admissionTickSizeRaw: number,
): number {
  const snapped = snapTickToAdmission(
    strikeToTick(strike, tickSizeRaw),
    tickSizeRaw,
    admissionTickSizeRaw,
  );
  return (Number(snapped) * tickSizeRaw) / 1e9;
}

export function lotAlignedQuantity(quantityDusdc: number): bigint {
  const raw = BigInt(Math.round(quantityDusdc * Number(QUOTE_UNIT)));
  return (raw / POSITION_LOT) * POSITION_LOT;
}
