# SVX strategy specification

This document is the source of truth for what SVX trades and why. Read it
before changing the math or the risk controls.

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

## Hyperliquid delta hedge

The Polymarket leg leaves directional exposure equal to `Δ × shares` where
`Δ = ∂N(d2)/∂S = -φ(d2) / (S · √w)` evaluated at the snapshot's spot,
strike, IV and TTM. After every successful Polymarket fill the bot opens a
perp on Hyperliquid sized to exactly that delta, on the side that
neutralizes it:

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

## Vol-arb (standalone Hyperliquid strategy, added 2026-05-15)

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
