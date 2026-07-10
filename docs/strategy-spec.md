# SVX strategy specification

This document is the source of truth for what SVX trades and why. Read it
before changing the math or the risk controls.

## Status (2026-07-03) — post-audit portfolio

A four-agent audit on 2026-07-03 (before the mainnet relaunch) reviewed every
strategy and the shared rails. Current portfolio:

| Strategy | Status | One-line rationale |
|---|---|---|
| Divergence-mint | **LIVE** (testnet dUSDC; paper on mainnet) | Predict's favorite at ≥8pp divergence is underconfident (~74–84¢ quoted, 84–94% realized); two disjoint validation windows — see [backtest-report.md](backtest-report.md). Added 2026-07-10. |
| Calibration-harvest | **LIVE** (testnet dUSDC; paper on mainnet) | The complement band: every Predict favorite <90¢ at divergence <8pp. May: n=64, 90.6% win, +14.2% ROI. Disjoint from the mint band by construction; shared per-(oracle,strike) dedupe. Added 2026-07-11. |
| Poly-arb | **LIVE** | Entry math verified; gates raised to 8pp spread + 5% EV-after-ask; hedge removed (naked binaries, $4 clips). |
| Expiry-convergence | **LIVE** | Late-certainty discount on BTC dailies; sigma gate runs on 2× trailing RV with strict universe filters. |
| Vol-arb (IV−RV perps) | **CUT** | A perp has no vega. $29.12 fees vs −$1.80 direction PnL over 5,219 fills, reconciled to the cent. Hard-disabled in code. |
| Margin-Lever | **OFF** | Signal = forward-basis z-score that diverges on noise near oracle expiry; testnet feed marks its own paper PnL. Needs a redesign. |

Key rail changes shipped with the audit (details in [risk-controls.md](risk-controls.md)):
daily poly loss limit keys on **settlement time**; circuit breaker counts
**real poly PnL** and ignores NULL-pnl rows; `autoResumeOnBoot=false` (redeploys
never clear pauses, and no automated path removes the manual kill flag);
`submitted`/`partial` fills are visible to every lifecycle query; failed redeems
retry with backoff and never guess the negRisk contract; and a **wallet-vs-ledger
reconciliation invariant** pauses the bot on unexplained pUSD drift
(`svx rebaseline` acknowledges deposits/withdrawals).

## Status (2026-05-11)

**Polymarket leg: LIVE on Polygon mainnet.** The bot submits market-buy
orders on the Polymarket CLOB v2, holds outcome shares through expiry, polls
gamma for UMA resolution, and auto-redeems winning shares via the
NegRiskAdapter / ConditionalTokens contracts. Realized pUSD PnL is enforced
against `dailyPolyLossLimitUsdc` (default $10 — auto-pause on breach).

**Predict leg: PAPER pending Sui mainnet.** All four protocol primitives
(`create_manager`, `deposit`, `mint`, `redeem_permissionless`) are exercised
end-to-end on testnet — the operator's PredictManager is funded with dUSDC
and has live trades on record. Flipping to mainnet is an address-swap +
`PAPER_TRADING=false`, documented in [mainnet-runbook.md](mainnet-runbook.md).

## The trade

For every (Predict oracle, Polymarket strike-market) where:

1. The underlying matches (BTC).
2. Polymarket's expiry is within ±`expiryToleranceSec` of the Predict
   oracle's expiry (default ±1 hour).
3. Polymarket's strike falls inside the Predict oracle's strike grid
   `[minStrike, minStrike + tickSize × 100_000]` and lands on a tick.

we evaluate Predict's SVI surface at the Polymarket strike and compare to the
Polymarket order-book best bid/ask. The trade is:

| Condition                                               | Predict side | Polymarket side |
|---------------------------------------------------------|--------------|-----------------|
| `predict_up - poly_yes_ask > threshold`                 | mint DOWN    | buy Yes         |
| `poly_yes_bid - predict_up > threshold`                 | mint UP      | sell Yes        |

Default `threshold` = 3 percentage points. Both legs are notional-matched.

## Pricing math

Predict's on-chain digital binary: `UP price = N(d2)` where

```
k    = ln(K / F)
w(k) = a + b · (ρ(k − m) + √((k − m)² + σ²))    # raw SVI total variance
d2   = −((k + w/2) / √w)
```

`UP + DOWN = 1` is the parity invariant. Annualized IV from total variance:
`σ_annual = √(w(k) / T)` where `T = msToExpiry / msPerYear`.

Implementation: [packages/svx-bot/src/pricing/svi.ts](../packages/svx-bot/src/pricing/svi.ts) and
[packages/svx-bot/src/pricing/bs.ts](../packages/svx-bot/src/pricing/bs.ts).
Test vectors: [docs/math-validation.md](math-validation.md).

## Sizing

Fixed-fraction with hard caps. **No Kelly until v2** — Kelly assumes you
trust your edge estimate, and v1 should not.

```
notional_per_trade = min(
  fixed_size_dusdc × edge_multiplier,    # fixed × clamp(edge / threshold, 0.5, 2)
  max_position_pct × NAV,                # default 5%
  remaining_daily_budget
)
```

Implementation: [packages/svx-bot/src/exec/sizer.ts](../packages/svx-bot/src/exec/sizer.ts).

## Risk controls (non-negotiable)

| Control                  | Default      | Source                                  |
|--------------------------|--------------|------------------------------------------|
| Per-trade size cap       | 100 dUSDC    | `MAX_POSITION_DUSDC`                     |
| Per-trade NAV cap        | 5%           | `MAX_POSITION_PCT`                       |
| Daily loss limit         | 500 dUSDC    | `DAILY_LOSS_LIMIT_DUSDC` → 24h auto-pause|
| Open position cap        | 10           | `MAX_OPEN_POSITIONS`                     |
| SVI staleness            | 300 s        | `MAX_SVI_STALENESS_SEC`                  |
| Polymarket bid-ask spread| 5 vol pts    | `POLY_MAX_BIDASK_VOL_PTS`                |
| Polymarket 24h volume    | $1000 floor  | `POLY_MIN_24H_VOLUME_USD`                |
| Consecutive losses       | 5            | `CIRCUIT_BREAKER_LOSSES` → 1h pause      |
| Manual kill switch       | always on    | `/tmp/svx-paused` filesystem flag        |

Each control has a dedicated path in [packages/svx-bot/src/exec/risk.ts](../packages/svx-bot/src/exec/risk.ts) and
[packages/svx-bot/src/signal/filter.ts](../packages/svx-bot/src/signal/filter.ts).

## Polymarket execution path

The bot submits orders to Polymarket through the [CLOB v2 SDK](https://github.com/Polymarket/clob-client)
using an L1 EVM keypair (`SignatureTypeV2.EOA`). pUSD is the collateral
asset; it lives in the operator's own wallet and is wrapped from USDC.e via
Polymarket's Collateral Onramp (see [mainnet-runbook.md](mainnet-runbook.md) §1.1).

Outcome selection mirrors the spread rationale:

| `predictDirection` | Mathematical opportunity | Poly outcome bought |
|---|---|---|
| `down` | `predict_up < poly_yes_ask` — Predict says less likely than poly prices | YES (buy the cheaper side) |
| `up`   | `predict_up > poly_yes_ask` — Predict says more likely than poly prices | NO (buy the cheaper side; equivalent to selling YES) |

Per-trade pUSD cap is `MAX_POLY_POSITION_USDC` (default $2 — small enough to
be tolerable as naked-binary exposure pending the planned Hyperliquid hedge).

### Settlement + auto-redeem

After every loop iteration the bot polls gamma every 5 min for unsettled
poly trades. When a market closes with `outcomePrices[Yes]=1` or `=0`, the
bot:

1. Records `poly_settled=1`, `poly_payout_usdc = filledShares * (won ? 1 : 0)`,
   `poly_pnl_usdc = payout - cost`, `poly_settlement_outcome`.
2. Groups winning trades by `conditionId` and submits **one** redeem tx per
   market — `NegRiskAdapter.redeemPositions(conditionId, [yesAmt, noAmt])`
   for NegRisk markets, `ConditionalTokens.redeemPositions(...)` otherwise.
3. Persists `poly_redeem_tx_hash` + `poly_redeem_status`. Failures are
   surfaced on the dashboard for manual cleanup (runbook §1.5).

The realized pUSD PnL feeds the daily loss limit on every subsequent
`risk.checkPoly()` — auto-pauses the bot for 24h on breach.

## Hyperliquid delta hedge — DISABLED (2026-07 audit)

> **Status: hedge opens are OFF (`hlHedgeEnabled=false` in tunables.ts).**
> The audit found two compounding defects: (1) delta was computed at the
> 15-minute Predict oracle's TTM instead of the Polymarket market's — Δ
> scales ~1/√T, so a 15-min TTM on a 6-hour binary oversized the hedge ~5×
> (the TTM bug is now fixed in code for whenever the hedge returns); and
> (2) a *correctly* sized ATM hedge for a $4 clip at daily horizons is
> hundreds of dollars of notional, which `maxHlPerTradeUsdc` rightly blocks —
> so the hedge only ever fired far from the strike, where it matters least.
> "Delta-neutral by construction" was therefore false in practice. The honest
> risk shape — small naked binaries bounded by clip size, position caps,
> stops, and daily limits — is now the documented design. Close machinery for
> legacy legs remains active. The original design below is retained for
> reference and for a future re-enable with poly-expiry sizing + adequate caps.

The Polymarket leg leaves directional exposure equal to `Δ × shares` where
`Δ = ∂N(d2)/∂S = φ(d2) / (S · √w)` evaluated at the snapshot's spot,
strike, IV and **the Polymarket expiry's TTM**. After every successful
Polymarket fill the bot opens a perp on Hyperliquid sized to exactly that
delta, on the side that neutralizes it:

| Polymarket side | Bot Δ exposure | Hyperliquid hedge |
|---|---|---|
| Bought Yes (above strike) | +Δ (long BTC) | Short BTC perp |
| Bought No (below strike) | −Δ (short BTC) | Long BTC perp |

The hedge closes on the same settlement-poll loop that resolves the Poly
trade — IOC limit, reduce-only, opposite side. Combined PnL on the
dashboard is `poly_pnl_usdc + hl_pnl_usdc`. The whole strategy is
delta-neutral by construction; the residual is pure vol-spread edge.

Risk gates layered on top (all in `risk.checkHl`):
- `maxHlPerTradeUsdc` — per-trade USD-notional cap on the hedge.
- `maxHlOpenUsdc` — total open HL exposure (USD).
- `dailyHlLossLimitUsdc` — 24h-rolling HL PnL ≤ -limit → auto-pause.
- Default leverage 1×. Code path supports higher but defaults to 1× so
  liquidation is functionally impossible at current trade sizes.

Implementation: [`pricing/binary-delta.ts`](../packages/svx-bot/src/pricing/binary-delta.ts),
[`exec/hyperliquid-client.ts`](../packages/svx-bot/src/exec/hyperliquid-client.ts),
hedge wiring in [`index.ts`](../packages/svx-bot/src/index.ts) after the
Polymarket fill block.

## Divergence-mint (Predict favored side — added 2026-07-10)

Mints the side **Predict prices above 50¢** whenever Predict's SVI-implied
probability and the Polymarket book disagree by ≥ 8pp on the same
(strike, expiry). Predict-side only — no Polymarket leg, no hedge. One bet
per (oracle, strike): the 15s loop re-observes the same opportunity dozens of
times, and a second entry would be leverage on the same coin flip.

Mechanism: at large divergences Predict's favorite is directionally right but
underconfident — quoted ~74–84¢, it realizes 84–94%. Validated on two
disjoint windows (May-2026: n=50, 94% win, +11.9% ROI; July-2026: n=24,
87.5%, ≈+18.5%; deduped, 2% fee haircut). The formulation matters: betting
the arb's Predict leg or its mirror both flip sign between those windows —
which side the leg points at depends on which venue is quoting rich that
month. Full method and caveats: [backtest-report.md](backtest-report.md).

Gates (all in `strategy/divergence-mint.ts`, pure + unit-tested): divergence
≥ `divergenceMintThreshold` (0.08), favored price ≤ 0.95, one open position
per (oracle, strike), `divergenceMintMaxOpen` cap (10), 24h realized-loss
standdown (−20 dUSDC), data-integrity filters from the shared pipeline
(stale SVI, expiry mismatch) still apply. Fixed clip
(`divergenceMintNotionalDusdc`, 5 dUSDC). Settlement, PnL, and
permissionless redeem ride the existing oracle-settlement machinery; trades
are tagged `strategy='divergence_mint'`.

Runs live on testnet dUSDC today; paper on the mainnet instance until
DeepBook Predict ships on Sui mainnet (then the same
`MAINNET_PAPER_TRADING=false` + address-swap flip as the arb leg). Kill:
`DIVERGENCE_MINT_ENABLED=false` per deployment.

## Expiry-convergence (Polymarket BTC dailies, final hour — added 2026-07)

Buys the deep-in-the-money side of BTC daily binaries in their final
5–90 minutes at 90–97¢, collecting the "late-certainty discount": holders
dump near-certain positions early to recycle capital into the next market,
and no market maker pins the book that close to resolution. First-hand proof
the discount exists: during the 2026-07 incident the bot paid $8 to a
counterparty running exactly this trade (the 800-shares-at-1¢ loss) — the
strategy flips SVX to the collecting side.

**Entry gates (all must pass):**

- Strict question parser — strike must be a `$`-prefixed or `k`-suffixed
  dollar amount, and dominance/holdings/no-touch ("stay above … through")
  questions are rejected outright.
- Strike sanity band: strike within [0.5, 2.0] × spot.
- Volume floor: `polyMinVolume24hUsd` applies (a dead book's 95¢ ask is an
  absence of sellers, not a discount).
- RV warm-up: ≥15 min of mid history before the estimator is trusted.
- Sigma distance: spot ≥ 4σ from the strike where σ = trailing HL realized
  vol × **2 (fat-tail safety multiplier)** — i.e. 8 trailing sigmas. Trailing
  lognormal RV understates BTC tails by orders of magnitude (Student-t tails,
  vol clustering, scheduled macro events invisible to any trailing window).
- Crowd-disagreement standdown: ask below 90¢ means the market prices real
  doubt — trust the crowd over trailing RV, skip.
- EV floor: `(1 − ask) − Φ(−dσ) ≥ 2%`, with pCross computed on the
  safety-multiplied σ so the gate genuinely binds.

**Risk shape:** win +3–10% per ~1h hold; loss ≈ −95% on a strike crossing
(the −15% convergence-specific stop cuts earlier when a bid exists, but
near-expiry books gap — size assuming full loss). Clips are $4 —
**clip size IS the risk budget** — and all clips are correlated on "BTC
doesn't move this hour", which is why the position cap and the sigma
multiplier both matter. Positions hold to resolution (the trailing ratchet
can't trigger below +20%) and settle/redeem through the same machinery as
poly-arb. Implementation: [`strategy/convergence.ts`](../packages/svx-bot/src/strategy/convergence.ts),
walker in `index.ts` (`walkExpiryConvergence`).

## Vol-arb — CUT 2026-07 (standalone Hyperliquid strategy, added 2026-05-15)

> **Status: hard-disabled in code — the `VOL_ARB_ENABLED` env var is
> deliberately ignored.** The audit reconciled the strategy to the cent
> against HL's own records: $29.12 in fees, −$1.80 direction PnL over 5,219
> fills. A perp has no vega; an IV−RV spread cannot be harvested with a
> delta-one instrument. The 2s ticker still runs for telemetry and as the
> realized-vol sampler feeding the expiry-convergence sigma gate.
> Re-enabling requires a code change and an instrument with gamma.

Original design, retained for reference:

Sibling strategy to the poly-arb cross-venue trade. Doesn't depend on
Polymarket — useful while Polymarket's Deposit Wallet API rollout is
breaking third-party trading, and stands on its own afterwards as
a second source of HL-side PnL.

**The signal:** Predict's SVI surface gives a forward-looking ATM IV.
Hyperliquid's recent mid-price history gives realized vol over the same
horizon. When the two diverge meaningfully AND Predict's surface has a
directional bias, the bot opens a perp position in that direction:

```text
σ_predict = √(w(k=0) / T_oracle)       # ATM IV, shortest-expiry oracle
σ_realized = √(Σ(r_i − r̄)² / (n−1) × samples_per_year)
spread = σ_predict − σ_realized

if |spread| > openThreshold AND |P_up_at_spot − 0.5| > biasThreshold:
  open long  if P_up_at_spot > 0.5
  open short otherwise
```

**Position lifecycle:**

- Close on signal weakening (`|spread| < closeThreshold` — hysteresis vs. open)
- Close on time-stop (default 60 min)
- One open position at a time (v1)

**Independent risk envelope** — `maxVolArbPerTradeUsdc`, `maxVolArbOpenUsdc`,
`dailyVolArbLossLimitUsdc` are separate from the poly-arb hedge gates so
the two strategies don't crowd each other out of HL margin.

**Off by default** — set `VOL_ARB_ENABLED=true` only after eyeballing the
`/vol-arb` dashboard page, which is always-on for telemetry (records the
IV/RV time series + decisions even when execution is off).

Implementation: [`strategy/vol-arb.ts`](../packages/svx-bot/src/strategy/vol-arb.ts).
Tests: [`tests/vol-arb.test.ts`](../packages/svx-bot/tests/vol-arb.test.ts) (25 cases).

## What v1 deliberately does NOT do

- **No dynamic hedge rebalancing.** Static hedge at trade open is sufficient
  for sub-day expiries (Polymarket BTC markets typically settle same-day).
  Rebalancing as delta drifts during the day is follow-up work.
- **No spread trades.** Verticals/calendars/butterflies are out of scope.
- **No Predict-vs-Predict internal arb.** Detecting butterfly/calendar
  violations *within* Predict's surface is a Phase 4 stretch — it's a useful
  *diagnostic* for the SVI feeder rather than an alpha source for v1.

## Edge sources and edge decay

- **Polymarket-side stickiness.** Polymarket order books update in human
  time; SVI updates faster. Most of the early edge is Predict's surface
  moving and Polymarket lagging.
- **Oracle latency.** If the Block Scholes feed lags spot, our IV is wrong.
  The staleness kill switch handles the worst case; we additionally log
  SVI-vs-spot-implied-vol as a health metric in the dashboard.
- **Slippage.** Polymarket fills at order-book best ask, not mid. We always
  quote against ask in live signals. This is where most paper-trading PnL
  evaporates.
- **Edge decay.** Once SVX (or anyone else) starts trading this
  systematically on mainnet, spreads compress. The strategy spec mentions
  this in the demo script — it makes the project more credible, not less.

## Cross-venue practical limits

DeepBook Predict's testnet runs **rolling 15-minute BTC oracles**. Polymarket's
BTC binary markets span intraday, end-of-day, and end-of-week expiries. The
two venues don't share expiries — Predict's 15-min binary at the same strike
as a Polymarket end-of-day binary is pricing a different probability.

**Cross-expiry repricing (2026-05-11):** the spread computation extracts
Predict's annualized IV from the SVI surface at the matched strike
(`σ = √(w(k) / T_oracle)`) and reprices the binary at the Polymarket expiry
(`w_poly = σ² · T_poly`, `predictUp = N(d2)`). This is a flat-vol-across-
expiries approximation — standard for short-dated and reasonably accurate
when the term structure of vol is stable.

After this fix, signal opportunities expand far beyond the ±1h overlap
window. The `expiryToleranceSec` config (default 14 days) is now a sanity
cap on extrapolation rather than the primary gate. Polymarket's intraday
markets (added in the same change) further widen the trading window.
