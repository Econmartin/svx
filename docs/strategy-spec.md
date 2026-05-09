# SVX strategy specification

This document is the source of truth for what SVX trades and why. Read it
before changing the math or the risk controls.

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

## What v1 deliberately does NOT do

- **No delta hedging on Hyperliquid.** Pure binary mispricing has bounded
  loss (the premium); adding a perp hedge adds cross-venue execution risk,
  funding-rate exposure, and a third API to babysit. Stretch.
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
BTC binary markets typically expire **end-of-day** or **end-of-week**. With
the default ±1h matching tolerance, signal opportunities therefore cluster
around Polymarket's expiry hour (e.g. 16:00 UTC daily for the "Bitcoin above
___ on <date>?" series).

This is a feature of the venue mismatch, not a bug in the bot. As Predict
extends to longer-dated oracles or Polymarket adds intra-day markets, the
signal universe expands automatically — no code changes needed.
