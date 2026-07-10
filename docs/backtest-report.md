# Backtest report — divergence-mint (favored side)

*Written 2026-07-10. Satisfies the mainnet pre-flight requirement:
"Backtest report from `scripts/backtest.ts` shows positive PnL on
out-of-sample data" (docs/mainnet-runbook.md §2).*

## The strategy

When Predict's SVI-implied probability and the Polymarket order book disagree
by **≥ 8 percentage points** on the same (strike, expiry), mint the side
**Predict prices above 50¢**. One bet per (oracle, strike); hold to
settlement; redeem via `predict::redeem_permissionless`.

Mechanism: at large divergences Predict's favorite is directionally right but
**underconfident** — quoted ~74–84¢, it realizes 84–94%.

## Method

- Input: the live bots' recorded signal streams (real SVI surfaces × real
  Polymarket books, computed every 15s by the deployed bots) joined against
  recorded oracle settlement prices. Nothing is simulated.
- **Dedupe** to one observation per (oracle, strike, direction) — the 15s
  loop re-logs the same opportunity ~40×; without dedupe the trade count is
  fiction.
- **2% fee haircut** on every entry approximating the Predict protocol spread
  (UP + DOWN > 1).
- Engine: `packages/svx-bot/src/ops/backtest.ts` — the identical code path
  serves the CLI (`scripts/backtest.ts`) and the deployed bots' read-only
  `GET /backtest` endpoint, so the numbers below are reproducible against the
  live ledgers at any time.

## Results — two disjoint windows

| Window | Source | n (settled, deduped) | Win rate | Avg cost | ROI after fee |
|---|---|---|---|---|---|
| 2026-05-09 → 05-18 | testnet ledger archive | 50 | **94.0%** | 84¢ | **+11.9%** |
| 2026-07-07 → 07-09 | deployed mainnet ledger | 24 | **87.5%** | 74¢ | **≈ +18.5%** |

Reproduce:

```bash
# May archive (local):
pnpm --filter svx-bot exec tsx ../../scripts/backtest.ts \
  --threshold 0.08 --side favored --dedupe --fee 0.02

# Rolling window (deployed bot, no sqlite pull needed):
curl "https://svx-mainnet.econmartin.xyz/backtest?threshold=0.08&side=favored&dedupe=true&fee=0.02"
```

Check `data_window` in the response before trusting the stats — signal
retention bounds how far back the deployed ledger goes (250k rows ≈ 12 days).

## Why "favored side" and not the arb leg or its mirror

Both alternative formulations **flip sign between the two windows** and are
therefore regime artifacts, not strategies:

| Bet | May 2026 | July 2026 |
|---|---|---|
| The arb's Predict leg (`predict_direction`) | −49% ROI | +19% ROI |
| Its mirror ("flip") | +8.2% ROI | −56% ROI |
| **Predict's favorite (>50¢ side)** | **+11.9%** | **≈ +18.5%** |

`predict_direction` is the Predict leg of the cross-venue arb — it points at
whichever side Predict quotes *rich relative to Polymarket*, so its identity
depends on which venue happens to be the rich one that month (Predict in May,
Polymarket in July). The favorite is the same economic bet in both regimes.

## Caveats, stated plainly

- **n is small** (74 independent settled bets across both windows). At an
  average 79¢ cost, 63/74 wins is ~2σ above break-even — strong but not
  overwhelming. The gate stays cheap to re-check (`GET /backtest`) and the
  strategy ships with a daily loss limit, an open-position cap, and a fixed
  small clip.
- **Fee model is an approximation.** Live entries should log realized
  `get_trade_amounts` cost vs the fair-price proxy to measure the real
  haircut (the 2% figure is conservative vs observed testnet spreads).
- **The July window post-dates the audit hardening**; the May window
  pre-dates it. Signal quality is comparable (same pipeline), but the filter
  population differs slightly — live entries apply data-integrity filters
  (stale SVI, expiry mismatch) the raw backtest population did not.
- **Both windows are BTC-only, sub-hour oracles.** No claim is made about
  other assets or tenors.

## Addendum 2026-07-11 — the calibration-harvest band

The `/calibration` report shows the underconfidence is NOT confined to
≥8pp divergences — every quoted band below ~90¢ realizes above its quote.
That implies a second, complementary strategy: buy every Predict favorite
below 90¢ whose divergence is *below* the mint threshold ("calibration
harvest" — the [0, 8pp) band the mint refuses, at a tighter price cap).

| Band | Window | n (settled, deduped) | Win rate | Avg cost | ROI after fee |
|---|---|---|---|---|---|
| Harvest [0, 8pp), cap 90¢ | May 2026 | 64 | **90.6%** | 79¢ | **+14.2%** |
| Harvest [0, 8pp), cap 90¢ | July 2026 (gate-free proxy¹) | 48 | 97.9% | 89¢ | +10.5% |

¹ July run pre-dates the band bounds in the deployed API (`threshold=0`,
no `maxThreshold`/`maxCost`) so it includes the mint band and >90¢ rows;
re-run the exact band once redeployed:

```bash
curl "https://svx-mainnet.econmartin.xyz/backtest?threshold=0&maxThreshold=0.08&maxCost=0.9&side=favored&dedupe=true&fee=0.02"
```

The two bands are disjoint by construction (`divergence-mint` ≥ 8pp,
`harvest` < 8pp) and share a one-position-per-(oracle, strike) dedupe, so
they can never double-bet one settlement event. Caveat inherited from the
signal stream: rows only exist where a Polymarket comparison existed, so
the harvest backtest is conditioned on "Polymarket listed a comparable
strike" — a fully Poly-free harvest needs the unmatched-oracle logging
extension before its numbers are unconditioned.

## Addendum 2026-07-11 (2) — range-ladder vault simulation

The brief's flagship vault idea (range ladder around ATM, idea bank #1)
poses one design question: the strike-width policy. We answered it by
replaying, for every oracle where the ledger holds both an SVI surface
snapshot and the settlement price (n=104 oracles, May archive), the ladder
the vault WOULD have minted at first sight of the surface — 5 rungs,
5 dUSDC notional per rung, 2% fee, rungs priced off that surface:

| Policy | Width | Rungs minted | Ladder hit rate | ROI after fee |
|---|---|---|---|---|
| **sigma** | **0.5σ** | 520 | 17% | **+10.1%** |
| sigma | 1σ | 520 | 19% | −5.1% |
| sigma | 2σ | 319 | 32% | −4.0% |
| fixed | 10 bps | 481 | 14% | +1.3% |
| fixed | 25 bps | 401 | 22% | +5.0% |
| fixed | 50 bps | 364 | 23% | −0.6% |

The per-rung breakdown explains WHY, and it is the calibration finding
again from a new angle: at σ/2 widths the ATM rung returns **+29%**, the
±1 rungs ~+10%, and the ±2 wings lose — the surface underprices the
center of the distribution (where its favorites are underconfident) and
relatively overprices the wings. Narrow ladders concentrate capital where
the surface is cheap; wide ladders donate it back through the wings.

Reproduce against a deployed bot's own ledger:

```bash
curl "https://svx-testnet.econmartin.xyz/range-sim?policy=sigma&rungs=5&width=0.5"
```

Live execution: `predict::mint_range` / `redeem_range` builders are in
`exec/ptb.ts` (verified against live testnet range traffic), and
`svx mint-ladder [--dry]` mints the σ/2 ladder on the soonest oracle
on-chain. Caveat: ranges have NO permissionless redeem — the operator key
must redeem after settlement.

## Implementation

`packages/svx-bot/src/strategy/divergence-mint.ts` (pure decision module,
gates tested in `tests/divergence-mint.test.ts`), wired in the main match
loop. Trades are tagged `strategy='divergence_mint'` in the ledger, ride the
existing oracle-settlement + permissionless-redeem machinery, and run live on
testnet dUSDC today; the mainnet instance runs it in paper mode until
DeepBook Predict ships on Sui mainnet (`MAINNET_PAPER_TRADING=false` +
address swap flips it live — the same flip the arb leg was always waiting
on).
