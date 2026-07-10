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
  /** Minimum (predict vs polymarket) probability spread to consider trading.
   *  Raised 0.03 → 0.08 post-incident: two weeks of (healed) data showed 3%
   *  divergences carried no edge — the bot paid the book spread every time
   *  and netted −$120. Fat divergences only; expect a few signals/day. */
  spreadThreshold: 0.08,
  /** Model edge must clear the entry ASK by this much: modelProb − ask ≥
   *  polyMinEvFrac. spreadThreshold compares two probabilities; this one
   *  compares against the price actually PAID, which embeds the book
   *  spread — a 8% prob-edge on a 10¢-wide book is still a losing trade. */
  polyMinEvFrac: 0.05,
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
  /** Per-trade cap as a fraction of NAV. Effectively disabled at 1.0.
   *  Testnet dUSDC lives mostly inside the PredictManager, not the operator
   *  wallet, so state.navUsdc (wallet-only) reads absurdly low ($6-$80) and
   *  any nonzero pct cap gates every signal on a technicality. The absolute
   *  maxPositionDusdc=$50 ceiling still applies. */
  maxPositionPct: 1.0,
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
  // Doubled 2 → 4 after mainnet hit ~100% gains. Bigger per-trade
  // captures more $$ per signal; total exposure cap (maxOpenPolyPositions)
  // stays at 1000 so we don't pin the queue.
  maxPolyPositionUsdc: 4,
  /** Hard cap on concurrent open Polymarket positions. Was 1000 ("demo
   *  mode, effectively uncapped") — which meant nothing bounded total
   *  concurrent exposure during the 2026-07 incident. 10 × $4 clips = $40
   *  max at risk at any moment. */
  maxOpenPolyPositions: 10,
  /** Min shares at top-of-book before we'll fill — avoids partial-fill drift. */
  polyMinBookDepthShares: 20,
  /** Floor on a sized poly order. The depth-clamp can shrink an order below
   *  what's worth spending CLOB fees on; below this we skip the market. */
  polyMinOrderUsdc: 0.5,
  /** After a fill_failed on a given token, skip that token for this long.
   *  Stops the bot from hammering the same FOK-failing book every 15s. */
  polyFillFailedCooldownMs: 5 * 60_000,
  /** Failed on-chain redeems retry with this gap between attempts (transient
   *  RPC failures self-heal; persistent reverts stop at the attempt cap and
   *  stay visible via the unredeemed-payout total on /status). */
  polyRedeemRetryGapMs: 30 * 60_000,
  /** Give up retrying a failing redeem after this many attempts. */
  polyRedeemMaxAttempts: 5,
  /** Reconciliation invariant: pause the bot when the pUSD wallet balance
   *  drifts from the ledger-implied expectation by more than this. The one
   *  control that catches a silent booking bug (the July-incident class)
   *  regardless of where the bug lives. Operator deposits/withdrawals move
   *  the wallet legitimately — re-baseline after funding (delete the
   *  `poly_reconcile_baseline` meta row or run `svx rebaseline`). */
  reconcileDriftThresholdUsdc: 5,
  /** Bumped 50 → 100 alongside the per-trade doubling so a losing day
   *  doesn't trip the daily pause before the larger trade size has had
   *  a chance to play out. */
  dailyPolyLossLimitUsdc: 100,
  /** Max wait for the Polymarket leg to fill. */
  polyFillTimeoutMs: 30_000,
  /** Auto-abandon Polymarket trades that have been "filled but unsettled"
   *  for longer than this. Catches the "stuck queue" failure mode where
   *  UMA never resolves and mid-life-exit never triggers — those rows
   *  would otherwise pin the maxOpenPolyPositions counter forever.
   *  Marked with poly_settlement_outcome='abandoned' (still counts in
   *  PnL as a loss = full cost). Default 14 days. */
  polyStaleSettlementDays: 14,
  /** Mid-life STOP-LOSS on the poly leg: sell when mark-to-market P&L frac
   *  ≤ −this. 0.5 = cut the position once it's lost half its cost. The
   *  original design was take-profit-only ("hold to settlement on the way
   *  down") — that harvested negative skew: winners clipped at +10-20%,
   *  losers ridden to $0. Set 0 to disable (not recommended). */
  polyStopLossFrac: 0.5,
  /** Exit ladder: max distance below the CURRENT best bid an early-exit
   *  attempt may fill (price points). The old FOK market sell swept the
   *  whole book — intraday price-history showed stops realizing 5–10pp
   *  below the tape on thin books. Each walker tick sells what the book
   *  offers at ≥ (bestBid − this) via FAK and retries the remainder next
   *  tick against a fresh book. */
  polyExitMaxSlippagePts: 0.02,
  /** Entry cap: max price points ABOVE the observed ask a FOK entry may
   *  pay. Thin book → the order fails and the tick is skipped, instead of
   *  walking up and overpaying for the edge that justified the entry. */
  polyEntryMaxSlippagePts: 0.02,
  /** Min gap between entries on the SAME poly outcome token. An early exit
   *  frees the concentration slot; without this the very next loop re-bought
   *  the same market at a worse price (the July-2 $60k churn: 24¢ → 29¢ →
   *  38¢ → 42¢, all torched at expiry). */
  polyReentryCooldownMs: 30 * 60_000,
  /** Refuse poly entries priced at/below this. A 1-2¢ ask means the market
   *  is ~99% sure — any "edge" Predict's SVI wing claims out there is model
   *  junk, not information (800 shares of No @ 1¢, RIP $8). */
  polyMinEntryPrice: 0.03,
  /** Refuse poly entries priced at/above this — near-certain side, no room
   *  left to be paid for the risk. */
  polyMaxEntryPrice: 0.97,
  /** Auto-abandon Predict (Sui) trades whose on-chain redeem keeps
   *  MoveAbort(1)-ing on decrease_position. Typical cause: oracle aged
   *  out and lost the position record, so the redeem can never succeed.
   *  Predict oracles settle in ~15 min so stuck redeems get stuck
   *  immediately — this needs a MUCH shorter cutoff than the Polymarket
   *  one (14d would let the queue spam for two weeks). 6 hours gives a
   *  normal redeem plenty of time to land while draining a stuck queue
   *  same-day. */
  predictStaleRedeemHours: 6,

  // ─────────────────────────────────────────────────────────────────────────
  // Risk caps — Hyperliquid hedge leg
  // ─────────────────────────────────────────────────────────────────────────
  /** Master switch for OPENING new HL delta-hedge legs on poly fills.
   *  DISABLED by the 2026-07 audit, twice over: (1) the hedge sized delta at
   *  the 15-min Predict oracle's expiry instead of the Polymarket market's —
   *  Δ scales ~1/√T, so a 15-min TTM on a 6-hour binary oversized the hedge
   *  ~5×; (2) a CORRECT ATM hedge for a $4 clip at daily horizons is hundreds
   *  of dollars of notional, which maxHlPerTradeUsdc rightly blocks — so the
   *  hedge only ever fired far from the strike, where it matters least.
   *  Poly-arb positions are therefore naked binaries bounded by the per-trade
   *  clip; that is now the DOCUMENTED risk shape rather than a false
   *  "delta-neutral by construction" claim. Close machinery for any legacy
   *  open legs is unaffected by this switch. Re-enabling requires sizing at
   *  the POLY expiry and caps that can actually accommodate the notional. */
  hlHedgeEnabled: false,
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
  /** Per-trade USD cap on HL hedge legs. Doubled 12 → 24 alongside the
   *  poly per-trade doubling so the hedge size scales with the larger
   *  poly stake. Must stay above hlMinOrderUsdc=10. */
  maxHlPerTradeUsdc: 24,
  /** Total open HL exposure cap. Doubled 200 → 400 to match the
   *  larger per-trade size. */
  maxHlOpenUsdc: 400,
  /** Daily HL loss limit. Doubled 50 → 100 to match the larger trade
   *  sizes — a losing day shouldn't pause the bot before the bigger
   *  per-trade cap has had a chance to play out. */
  dailyHlLossLimitUsdc: 100,
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
  /** Per-trade USD cap on vol-arb perp positions. Doubled 12 → 24
   *  alongside the poly + HL hedge doublings so vol-arb captures
   *  proportionally larger wins on real signals. */
  maxVolArbPerTradeUsdc: 24,
  /** Total open vol-arb exposure cap. Doubled 200 → 400. */
  maxVolArbOpenUsdc: 400,
  /** Daily vol-arb loss limit. Doubled 50 → 100. */
  dailyVolArbLossLimitUsdc: 100,
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
  // Strategy 3: Margin-Lever (paper-mode only in v1)
  //
  // Borrow dUSDC on deepbook_margin against an iron_bank USDsui share,
  // deploy into a directional BTC spot view driven by Predict's SVI bias,
  // repay from the close. Lives on Sui mainnet (vs Predict testnet for the
  // pricing brain). Live execution is GATED — see strategy/margin-lever.ts.
  // ─────────────────────────────────────────────────────────────────────────
  /** |P(↑) − 50%| at which the strategy opens a paper position. 0.10 means
   *  the surface has to think one side is at least 60% / 40%. */
  marginLeverOpenBias: 0.10,
  /** |P(↑) − 50%| below which an open position closes. Hysteresis. */
  marginLeverCloseBias: 0.04,
  /** Time-stop in minutes. Predict oracles are sub-hour, but the spot
   *  position rides on DeepBook orderbook independently — cap held time. */
  marginLeverMaxHoldMinutes: 45,
  /** Per-trade USD notional cap on the BTC spot leg. */
  marginLeverPerTradeNotionalUsdc: 500,
  /** Cap on borrowed dUSDC notional given simulated collateral. Acts as
   *  the leverage envelope: at 1000 USD of supplied USDsui share, a 3x
   *  cap caps total spot exposure at 3000. */
  marginLeverMaxBorrowNotionalUsdc: 1500,
  /** Daily paper-loss limit. Strategy holds (no new opens) on breach. */
  marginLeverDailyLossLimitUsdc: 100,
  /** Loop tick. Same cadence as the main poly-arb loop is fine — Predict's
   *  SVI doesn't move faster than that, and the open/close decisions are
   *  cheap. */
  marginLeverTickMs: 15_000,

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
  /** RATCHET STEP for the trailing take-profit (repurposed 2026-07 from the
   *  old fixed exit threshold — same knob, new semantics). The old behavior
   *  sold the whole position the moment P&L hit +20%, which clipped every
   *  winner while losers rode to $0. Now: winners RIDE. Each time the
   *  high-water P&L crosses a multiple of this step (+20%, +40%, ...), the
   *  exit floor locks in at that multiple; we only sell when P&L falls back
   *  below the highest locked floor. A trade that runs to resolution never
   *  sells at all — it redeems at $1. */
  polyEarlyExitMinProfitFrac: 0.20,

  // ─────────────────────────────────────────────────────────────────────────
  // Expiry-convergence strategy (Polymarket BTC dailies, final hour)
  // ─────────────────────────────────────────────────────────────────────────
  /** Buy the deep-ITM side of near-expiry dailies at 90-97¢ when realized
   *  vol says the strike is unreachable. See strategy/convergence.ts for the
   *  mechanism (we were the COUNTERPARTY to this trade during the July
   *  incident — the 800-shares-at-1¢ loss was someone running this). */
  convergenceEnabled: true,
  /** Only markets expiring within this window are considered. */
  convergenceMaxMinutes: 90,
  /** ...but not closer than this — books go haywire in the last minutes and
   *  a fill there can't be managed if it goes wrong. */
  convergenceMinMinutes: 5,
  /** Spot must sit at least this many sigmas (realized vol, √T-scaled) from
   *  the strike. 4σ ≈ 3e-5 terminal probability — under LOGNORMAL trailing
   *  RV, which understates BTC tails badly (see convergenceSigmaSafetyMult). */
  convergenceMinSigma: 4,
  /** Multiply trailing RV by this before computing sigma-distance. BTC
   *  short-horizon returns are Student-t-fat (a "4σ" lognormal move is
   *  ~0.7-1.4% likely, not 0.003%), a 1h trailing window misses vol-regime
   *  breaks, and scheduled macro events are deterministic forward vol no
   *  trailing sampler can see. 2× means the 4σ gate demands 8 trailing
   *  sigmas of distance — it also makes the EV gate genuinely bind instead
   *  of being auto-passed by the sigma gate. */
  convergenceSigmaSafetyMult: 2,
  /** Require at least this much mid-price history before trusting the RV
   *  estimate. The sampler is memory-only; right after a restart the
   *  estimator would otherwise run on a handful of 2s returns. */
  convergenceMinRvHistoryMs: 15 * 60_000,
  /** Strike must sit within [lo, hi] × spot. Kills the market-universe
   *  contamination class outright: "Bitcoin dominance above 60" parses to
   *  strike 60, which is 0.0005× spot — no real BTC price binary has a
   *  strike outside this band. */
  convergenceStrikeBandLoFrac: 0.5,
  convergenceStrikeBandHiFrac: 2.0,
  /** Convergence-specific stop-loss (P&L frac vs cost). The shared −50%
   *  stop is miscalibrated here: a 93¢ entry down 50% means the market
   *  already prices ~50/50 crossing odds — the thesis died long before.
   *  −15% ≈ ask fell to ~79¢ ≈ market doubt has doubled; get out while a
   *  bid still exists. */
  convergenceStopLossFrac: 0.15,
  /** Ask below this means the crowd prices real doubt — trust the crowd
   *  over trailing RV and stand down. */
  convergenceMinPrice: 0.90,
  /** Ask above this leaves no meat after tail risk. */
  convergenceMaxPrice: 0.97,
  /** Required EV per $1 share: (1 − ask) − Φ(−dσ). */
  convergenceMinEvFrac: 0.02,
  /** Per-trade pUSD clip. Small on purpose: the loss shape is −95% on a
   *  crossing, so clip size IS the risk budget. Kept ≤ maxPolyPositionUsdc
   *  so the shared RiskGate.checkPoly rail passes sized orders. */
  maxConvergencePerTradeUsdc: 4,
  /** Walker cadence. Books near expiry move fast but 60s is plenty — the
   *  edge is a level (the discount), not a race. */
  convergenceCheckIntervalMs: 60_000,

  // ─────────────────────────────────────────────────────────────────────────
  // Divergence-mint strategy (Predict favored side — the flagship candidate
  // for DeepBook Predict mainnet; see strategy/divergence-mint.ts)
  // ─────────────────────────────────────────────────────────────────────────
  /** Master switch. Also env-overridable per deployment via
   *  DIVERGENCE_MINT_ENABLED. Paper on mainnet until Predict ships there
   *  (follows the same paperTrading gate as the arb's Predict leg). */
  divergenceMintEnabled: true,
  /** Min |Predict − Poly| divergence. 0.08 is the validated gate: May-2026
   *  94% win/+11.9% ROI, July-2026 ~87.5%/+18% (deduped, 2% fee). */
  divergenceMintThreshold: 0.08,
  /** Refuse favored-side entries above this — no payoff room after fee. */
  divergenceMintMaxCostPrice: 0.95,
  /** Fixed dUSDC clip per trade. */
  divergenceMintNotionalDusdc: 5,
  /** Max simultaneous open divergence positions (distinct oracle/strike). */
  divergenceMintMaxOpen: 10,
  /** Stand down for the day at −this realized dUSDC over trailing 24h. */
  divergenceMintDailyLossLimitDusdc: 20,

  // ─────────────────────────────────────────────────────────────────────────
  // Calibration-harvest strategy — the complement band of the favored-side
  // edge. Divergence-mint takes signals at ≥ divergenceMintThreshold; the
  // harvest takes [0, threshold): every OTHER Predict favorite below its
  // (tighter) price cap. Bands are disjoint so the strategies never overlap.
  // Validated on July data via GET /backtest?threshold=0&side=favored:
  // 48 settled, 97.9% win, +10.5% ROI after 2% fee; the /calibration report
  // shows why — the surface is underconfident everywhere below ~90¢.
  // ─────────────────────────────────────────────────────────────────────────
  /** Master switch. Env-overridable via CALIBRATION_HARVEST_ENABLED. */
  calibrationHarvestEnabled: true,
  /** Tighter price cap than the mint: above 90¢ the surface is measured
   *  well-calibrated, so there's no edge to harvest. */
  calibrationHarvestMaxCostPrice: 0.9,
  /** Fixed dUSDC clip per trade. */
  calibrationHarvestNotionalDusdc: 5,
  /** Max simultaneous open harvest positions (distinct oracle/strike). */
  calibrationHarvestMaxOpen: 10,
  /** Stand down for the day at −this realized dUSDC over trailing 24h. */
  calibrationHarvestDailyLossLimitDusdc: 20,

  // ─────────────────────────────────────────────────────────────────────────
  // Butterfly-harvester TELEMETRY (see strategy/butterfly.ts) — counts
  // digital-monotonicity violations on the fitted surface before any
  // execution is considered. "We trade the surface's own arbitrage
  // violations" starts by proving they exist.
  // ─────────────────────────────────────────────────────────────────────────
  /** Scan cadence. Violations are transient; the loop already holds fresh
   *  snapshots every 15s, so 60s sampling is plenty for telemetry. */
  butterflyCheckIntervalMs: 60_000,
  /** Record floor — ignore sub-1pp wiggles (numerical noise). */
  butterflyMinMarginFrac: 0.01,
  /** "Tradeable" label: margin that would survive ~2× the protocol fee. */
  butterflyTradeableMarginFrac: 0.05,

  // ─────────────────────────────────────────────────────────────────────────
  // Boot-time behaviour
  // ─────────────────────────────────────────────────────────────────────────
  /** When true, the bot resumes (clears the persisted pause flag) on every
   *  startup. FLIPPED TO FALSE by the 2026-07 audit: with real money on, a
   *  crash-looping process must not clear a daily-loss pause, the circuit
   *  breaker, or (worst) the operator's manual kill flag on every restart.
   *  Resume deliberately via `svx resume` — that's the only path that
   *  removes /tmp/svx-paused. */
  autoResumeOnBoot: false,

  // ─────────────────────────────────────────────────────────────────────────
  // Polymarket API endpoints (stable URLs — override via env if needed)
  // ─────────────────────────────────────────────────────────────────────────
  polymarketGammaBase: 'https://gamma-api.polymarket.com',
  polymarketClobBase: 'https://clob.polymarket.com',
} as const;

export type Tunables = typeof TUNABLES;
