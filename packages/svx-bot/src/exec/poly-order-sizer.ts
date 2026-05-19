/**
 * Polymarket FOK order sizing.
 *
 * Polymarket market BUY orders are FOK (fill-or-kill): the entire `usdcAmount`
 * must be fillable at-or-below the limit derived from the book, or the order
 * is rejected with 400 "order couldn't be fully filled". Submitting our
 * configured `maxPolyPositionUsdc` blindly burns API quota on illiquid markets
 * (e.g. $2 @ $0.058 ask → needs 34.5 shares but book has only 20).
 *
 * This sizer clamps the order to what the visible book can actually fill,
 * keyed by `depth × ask`, with a small safety factor to absorb microsecond
 * book moves between snapshot and submit. Pure function — fully unit-testable.
 */
export interface PolySizeInput {
  /** Per-trade cap in pUSD (cfg.maxPolyPositionUsdc). */
  maxOrderUsdc: number;
  /** Floor below which the order isn't worth submitting (cfg.polyMinOrderUsdc). */
  minOrderUsdc: number;
  /** Shares offered at the best ask. From the orderbook snapshot. */
  bookDepthShares: number;
  /** Best ask price. */
  ask: number;
}

export type PolySizeResult =
  | {
      ok: true;
      /** What to pass as `usdcAmount` to `polyExec.marketBuy`. */
      submitUsdc: number;
      /** True when we sized down because of book depth (otherwise = maxOrderUsdc). */
      clampedToDepth: boolean;
    }
  | {
      ok: false;
      reason: 'thin_book' | 'invalid_input';
      /** Diagnostic only — what the order would have been at full size. */
      attemptedUsdc: number;
    };

/**
 * 5% headroom under the visible depth so a stale snapshot won't kill the FOK.
 * Chosen empirically — Polymarket books on BTC strike markets typically refresh
 * every few seconds; a 5% buffer covers most micro-moves.
 */
const DEPTH_SAFETY_FACTOR = 0.95;

export function sizePolyOrder(input: PolySizeInput): PolySizeResult {
  const { maxOrderUsdc, minOrderUsdc, bookDepthShares, ask } = input;
  if (!isFinite(ask) || ask <= 0 || ask >= 1) {
    return { ok: false, reason: 'invalid_input', attemptedUsdc: maxOrderUsdc };
  }
  if (!isFinite(bookDepthShares) || bookDepthShares <= 0) {
    return { ok: false, reason: 'thin_book', attemptedUsdc: maxOrderUsdc };
  }
  const fillableUsdc = bookDepthShares * ask * DEPTH_SAFETY_FACTOR;
  const submitRaw = Math.min(maxOrderUsdc, fillableUsdc);
  // Round down to the cent — Polymarket quotes in 1¢ ticks.
  const submitUsdc = Math.floor(submitRaw * 100) / 100;
  if (submitUsdc < minOrderUsdc) {
    return { ok: false, reason: 'thin_book', attemptedUsdc: maxOrderUsdc };
  }
  return {
    ok: true,
    submitUsdc,
    clampedToDepth: submitRaw < maxOrderUsdc,
  };
}
