/**
 * Strategy tunables — all non-secret knobs live here as plain TS constants so
 * they can be tweaked directly (no env vars, no Coolify panel round-trip).
 *
 * What stays in env:
 *   - Secrets (private keys, API creds, operator JSON)
 *   - Network choices (testnet vs mainnet, RPC URLs, Predict server URL)
 *   - Execution kill-switches (PAPER_TRADING, *_EXECUTION_ENABLED, VOL_ARB_ENABLED)
 *   - Instance identity (SVX_INSTANCE_LABEL, SVX_DATA_DIR, SVX_API_HOST/PORT, SVX_LOG_LEVEL)
 *
 * Everything else — risk caps, thresholds, intervals, retention — lives here.
 * Change a value, redeploy. That's it.
 */

export const TUNABLES = {
  // ─────────────────────────────────────────────────────────────────────────
  // Poly-arb signal thresholds + filters
  // ─────────────────────────────────────────────────────────────────────────
  /** Minimum (predict vs polymarket) probability spread to consider trading. */
  spreadThreshold: 0.03,
  /** Skip signals where predictProb falls outside [min, max] — protocol
   *  rejects asks > 99% / < 1% anyway, so these waste gas. */
  minPredictProb: 0.05,
  maxPredictProb: 0.95,
  /** Don't persist filtered signals whose spread is below this fraction of
   *  threshold. Cuts ~80% of disk writes. Set to 0 to log everything. */
  signalLogMinSpreadFrac: 0.3,
  /** Reject Predict SVI snapshots older than this. */
  maxSviStalenessSec: 300,
  /** Reject Polymarket markets whose bid/ask is too wide (in IV points). */
  polyMaxBidaskVolPts: 0.05,
  /** Reject Polymarket markets with thin 24h volume. */
  polyMinVolume24hUsd: 1000,
  /** Max |Predict-expiry − Polymarket-expiry|. Sanity cap after the
   *  cross-expiry reprice landed (was a primary gate before that). */
  expiryToleranceSec: 14 * 24 * 3600,

  // ─────────────────────────────────────────────────────────────────────────
  // Risk caps — Predict (dUSDC) leg
  // ─────────────────────────────────────────────────────────────────────────
  /** Per-trade cap on the Predict mint cost. Bumped from 15 → 50 for the
   *  hackathon-demo window — bigger trades = more visible PnL bars. */
  maxPositionDusdc: 50,
  /** Per-trade cap as a fraction of NAV. */
  maxPositionPct: 0.05,
  /** Auto-pause if 24h realized dUSDC PnL drops below −this. Bumped from
   *  150 → 1000 — testnet, paper-mode, no real money risk. */
  dailyLossLimitDusdc: 1000,
  /** Hard cap on concurrent open Predict positions. Bumped from 10 → 100. */
  maxOpenPositions: 100,
  /** Concentration cap: never hold more than this many positions on the
   *  same (oracle, strike, direction). Forces diversification. */
  maxPositionsPerSignal: 2,
  /** Auto-pause after N consecutive losing trades. Bumped 5 → 20 — at
   *  higher trade frequency, 5-streaks happen by chance even on a
   *  positive-EV strategy. */
  circuitBreakerLosses: 20,

  // ─────────────────────────────────────────────────────────────────────────
  // Risk caps — Polymarket leg
  // ─────────────────────────────────────────────────────────────────────────
  maxPolyPositionUsdc: 2,
  /** Hard cap on concurrent open Polymarket positions. Cranked to 1000 for
   *  hackathon-demo mode — effectively uncapped. The stale-row abandon
   *  prune (see polyStaleSettlementDays) keeps this from drifting forever. */
  maxOpenPolyPositions: 1000,
  /** Min shares at top-of-book before we'll fill — avoids partial-fill drift. */
  polyMinBookDepthShares: 20,
  /** Floor on a sized poly order. The depth-clamp can shrink an order below
   *  what's worth spending CLOB fees on; below this we skip the market. */
  polyMinOrderUsdc: 0.5,
  /** After a fill_failed on a given token, skip that token for this long.
   *  Stops the bot from hammering the same FOK-failing book every 15s. */
  polyFillFailedCooldownMs: 5 * 60_000,
  /** Bumped from 10 → 50 — gives more room to absorb a losing day before
   *  the bot pauses itself. Still well under the funded pUSD balance. */
  dailyPolyLossLimitUsdc: 50,
  /** Max wait for the Polymarket leg to fill. */
  polyFillTimeoutMs: 30_000,
  /** Auto-abandon Polymarket trades that have been "filled but unsettled"
   *  for longer than this. Catches the "stuck queue" failure mode where
   *  UMA never resolves and mid-life-exit never triggers — those rows
   *  would otherwise pin the maxOpenPolyPositions counter forever.
   *  Marked with poly_settlement_outcome='abandoned' (still counts in
   *  PnL as a loss = full cost). Default 14 days. */
  polyStaleSettlementDays: 14,

  // ─────────────────────────────────────────────────────────────────────────
  // Risk caps — Hyperliquid hedge leg
  // ─────────────────────────────────────────────────────────────────────────
  /** What asset to hedge (must match Hyperliquid's perp universe). */
  hlHedgeAsset: 'BTC',
  /** Hyperliquid enforces a $10 minimum order value protocol-side. Any HL
   *  submission below this is rejected with "Order must have minimum value
   *  of $10". The bot pre-checks `usdNotional < hlMinOrderUsdc` and skips
   *  the submission cleanly so we don't error-spam every 2s. */
  hlMinOrderUsdc: 10,
  /** Hyperliquid taker fee rate as a decimal. Standard tier is 0.00035
   *  (3.5 bps). Lower with HYPE stake / volume tiers — adjust to your
   *  actual effective rate so the PnL accounting matches what your wallet
   *  shows. Applied to both legs (open + close) because IOC orders are
   *  always taker. Deducted from hl_pnl_usdc on close. */
  hlTakerFeeRate: 0.00035,
  /** Per-trade USD cap on HL hedge legs. Must be ≥ hlMinOrderUsdc or every
   *  hedge attempt gets rejected; was 2 (below HL min), bumped to 12. */
  maxHlPerTradeUsdc: 12,
  /** Total open HL exposure cap (sum of all hedge legs' notionals).
   *  Bumped 50 → 200 — at 1000 max poly trades each carrying a hedge, the
   *  old 50 cap would have been hit on the 5th hedge. */
  maxHlOpenUsdc: 200,
  /** Daily HL loss limit. Bumped 30 → 50 for the same reason — broader
   *  loss bandwidth at higher activity. */
  dailyHlLossLimitUsdc: 50,
  /** If true, skip a Poly fill when HL hedge can't be opened. */
  hlRequiredForPoly: false,

  // ─────────────────────────────────────────────────────────────────────────
  // Vol-arb (Predict IV vs HL realized vol)
  // ─────────────────────────────────────────────────────────────────────────
  /** Open trigger: |Predict ATM IV − HL RV| ≥ this AND directional bias. */
  volArbIvSpreadOpenThreshold: 0.05,
  /** Close trigger: |IV − RV| < this (hysteresis below open). */
  volArbIvSpreadCloseThreshold: 0.02,
  /** |P_up − 0.5| must exceed this to clear the directional-bias gate. */
  volArbDirectionBiasThreshold: 0.03,
  /** When |IV − RV| ≥ this, skip the directional-bias gate (vol thesis
   *  dominates). EFFECTIVELY DISABLED at 1.0 — perp positions can only
   *  capture vol via direction, so trading without bias on a 17%-spread
   *  neutral surface (P_up ≈ 50%) is a coin flip eaten by HL fees. The
   *  bypass logic makes sense for options (long gamma), not for linear
   *  perps. Set to 0.5 or lower to re-enable in extreme regimes. */
  volArbBiasBypassSpread: 1.0,
  /** Per-trade USD cap on vol-arb perp positions. Must be ≥ hlMinOrderUsdc
   *  (Hyperliquid's $10 floor) or every open is rejected — was 2, bumped
   *  to 12. */
  maxVolArbPerTradeUsdc: 12,
  /** Total open vol-arb exposure cap. Bumped 50 → 200. */
  maxVolArbOpenUsdc: 200,
  /** Daily vol-arb loss limit. Bumped 30 → 50. */
  dailyVolArbLossLimitUsdc: 50,
  /** Max minutes a vol-arb position stays open before time-stop. */
  volArbTimeStopMinutes: 60,
  /**
   * Min mid-price samples before vol-arb evaluates. Combined with
   * `volArbTickMs`, this controls warmup:
   *   12 samples × 2s = 24s cold-start (was 30 × 15s = 7.5 min).
   */
  volArbMinSamples: 12,
  /**
   * Vol-arb sampler/decision tick. The vol-arb loop runs on its OWN timer,
   * decoupled from the 15s poly-arb loop, so a slow Polymarket HTTP call
   * can't starve the vol-arb signal. Each tick pulls an HL mid (one cheap
   * REST call) and decides — sub-second wall time.
   */
  volArbTickMs: 2_000,
  /** Cached Predict ATM-IV TTL. ATM IV moves slowly relative to HL mid, so
   *  we snapshot the shortest BTC oracle once per this window and reuse it
   *  on every vol-arb tick. */
  volArbOracleCacheMs: 30_000,

  // ─────────────────────────────────────────────────────────────────────────
  // Bot scheduling + housekeeping
  // ─────────────────────────────────────────────────────────────────────────
  /** Main poly-arb scheduler interval. Vol-arb runs on its own faster tick
   *  (see `volArbTickMs`); this is for oracle/market refresh + settlements
   *  + balance reads + NAV snapshot + prune. */
  loopIntervalMs: 15_000,

  // ─────────────────────────────────────────────────────────────────────────
  // Polymarket mid-life exit (don't wait for UMA settlement)
  // ─────────────────────────────────────────────────────────────────────────
  /** Watcher loop walks open poly trades and sells back via marketSell when
   *  the mark-to-market P&L crosses the profit-take threshold. The Predict
   *  leg can't be exited (protocol has no sell function), but the poly leg
   *  can — locking in poly gains without waiting hours for UMA. */
  polyEarlyExitEnabled: true,
  /** Mark-to-market P&L (as a fraction of cost) at which we exit the poly
   *  leg early. 0.20 = "sell when current bid × shares is 20% above what we
   *  paid." Tune up to capture more before exiting; down to exit sooner. */
  polyEarlyExitMinProfitFrac: 0.20,

  // ─────────────────────────────────────────────────────────────────────────
  // Boot-time behaviour
  // ─────────────────────────────────────────────────────────────────────────
  /** When true, the bot resumes (clears the persisted pause flag + removes
   *  /tmp/svx-paused) on every startup. Makes redeploys a "push and see it
   *  running" affair — a prior daily-loss/circuit-breaker trip won't carry
   *  over into the next process. Flip to false for hands-off production. */
  autoResumeOnBoot: true,

  // ─────────────────────────────────────────────────────────────────────────
  // Polymarket API endpoints (stable URLs — override via env if needed)
  // ─────────────────────────────────────────────────────────────────────────
  polymarketGammaBase: 'https://gamma-api.polymarket.com',
  polymarketClobBase: 'https://clob.polymarket.com',
} as const;

export type Tunables = typeof TUNABLES;
