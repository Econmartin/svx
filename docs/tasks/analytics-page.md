# Task — Self-analyzing Performance / Analytics page

You are picking up this task in a fresh worker session. Read this end to end
before writing code. Then read the linked files at the bottom.

## TL;DR

SVX has been recording trades for several days. The dashboard shows a simple
closed-trades table and a cumulative PnL chart, but there's no way to assess
strategy quality. Build a **Performance** page that turns the existing trade
data into edge / calibration / risk-adjusted-return analysis the operator (and
demo judges) can read at a glance.

The data capture is already done — `trades` table has the necessary fields
including settlement_price, ms_to_expiry_at_exec, predict_prob_at_exec,
poly_ask_at_exec, edge_at_exec. You're building visualization + summary stats
on top of existing data.

## Context

- Repo: `/Users/martinswdev/Repos/SVX` (also at github.com/Econmartin/svx).
- Bot is running on Coolify, accumulating live trades.
- Strategy: 1-leg directional bet on Predict against Polymarket disagreement.
  See [docs/strategy-spec.md](../strategy-spec.md).
- Each settled trade has cost, payout, pnl, and at-execution-time captures of
  predict probability, Polymarket ask, IV, edge claimed, and time-to-expiry.
- Current dashboard pages: Overview, Signals, Positions, Surface, About.
  Add a new **Performance** page.

## What to build

A new page at `/performance` (`packages/svx-dashboard/app/performance/page.tsx`)
showing:

### 1. Headline numbers row (StatRow)
- Total trades (closed)
- Win rate (closed wins / closed trades)
- Total PnL ($)
- ROI (PnL / total cost)
- Max drawdown ($) — running peak-to-trough on cumulative PnL
- Avg edge captured (avg of edge_at_exec across executed trades)

### 2. Calibration plot (the marquee chart)

Bucket trades by `predict_prob_at_exec`:
- 0–10%, 10–20%, ... 90–100% (10 buckets)

For each bucket:
- x: midpoint of the bucket (e.g. 0.85 for the 80–90% bucket)
- y: realized win rate in that bucket
- size: number of trades in the bucket

Plot a 45° reference line (perfect calibration). Use `recharts` `ScatterChart`
with the reference line as a `<Line>` overlay.

**This is the single most demo-worthy chart in the project.** "Over 200 trades,
the bot's stated probability matched realized win rate within 2pp" is the
killer claim.

Render an empty-state when fewer than 30 trades total — calibration on small
samples is misleading.

### 3. PnL distribution histogram

20-bin histogram of `pnlUsdc` across all closed trades. Color positive bars
green, negative red. Median + mean lines as `<ReferenceLine>`s.

### 4. Cumulative PnL with drawdown shaded

Take the existing cum-PnL line chart from Overview, add a shaded area for
drawdown periods (from running peak to current). Keep the +/- color logic.

### 5. Edge captured vs realized PnL scatter

x: `edge_at_exec` (probability points)
y: `pnlUsdc / costUsdc` (per-unit PnL ratio)

If the strategy works, this should show positive correlation. Overlay a
linear fit line.

### 6. PnL by oracle expiry duration

Group trades by `msToExpiryAtExec` bucket (0–15min, 15–30min, 30–60min, 1h+)
and bar-chart the avg PnL per trade. Helps spot if the bot does better on
short or longer-dated oracles.

### 7. Detailed trades table

Expanded version of the closed-positions table with all the new fields
visible. Include:
- Time, oracle (truncated), strike, direction, qty, cost
- predict_prob_at_exec, poly_ask_at_exec, edge_at_exec
- settlement_price, settlement_margin (= settlement / strike − 1)
- pnl_usdc, mint_tx_digest (linked to suiscan), redeem_tx_digest (linked)
- ms_to_expiry_at_exec → human-readable

Sortable, filterable by direction / win-loss.

## Architecture notes

- All data should come from the existing `/positions/closed` endpoint —
  no new API routes needed for the basic page. If you want server-side
  aggregation for large datasets later, add `/performance/summary` and
  `/performance/calibration-buckets` endpoints.
- Keep the page client-rendered with `usePolling` (30s) — refreshes as
  new trades close.
- Reuse `StatRow` and the existing recharts patterns from `app/page.tsx`.
- No new deps — recharts already supports everything you need.

## Numerical details

### Max drawdown formula
```
let peak = 0;
let maxDd = 0;
for each trade in chronological order:
  cum += trade.pnl
  peak = max(peak, cum)
  maxDd = min(maxDd, cum - peak)  // negative value
```

### Calibration bucket
```
const bucket = Math.floor(predictProbAtExec * 10);  // 0..9
const midpoint = (bucket + 0.5) / 10;
```
Skip trades where `predictProbAtExec` is null/undefined.

### Settlement margin
```
margin = (settlement_price - strike) / strike;   // positive = ITM for UP
// negate for direction='down'
```

## Files to read first

1. `packages/svx-dashboard/app/page.tsx` — existing chart patterns + StatRow usage.
2. `packages/svx-dashboard/lib/api.ts` — TradeRecord type with the new fields.
3. `packages/svx-dashboard/components/StatRow.tsx` — reuse for the headline row.
4. `packages/svx-dashboard/lib/usePolling.ts` — polling hook.
5. `packages/svx-bot/src/ledger/store.ts` — `tradeRows()` is the source of truth.
6. `docs/strategy-spec.md` — what we're trying to validate.

## Acceptance criteria

1. New `/performance` page renders without errors when the trade table is empty
   (shows "Insufficient data — needs ≥30 closed trades for analysis").
2. Headline stats match what you'd compute by hand from the closed-trades JSON.
3. Calibration plot is the visual hero — clean, with 45° reference, sized
   bubbles per bucket.
4. PnL distribution + cum-PnL with drawdown render with realistic test data.
5. Detailed trades table is sortable on every numeric column.
6. Mobile-responsive — works on a phone for judges browsing the demo URL.
7. Existing pages still work; tests still pass.

## Stretch (only if v1 ships smoothly)

- **Win rate by hour-of-day heatmap** — 24×1 strip showing avg PnL or win rate per UTC hour. Reveals whether the bot does better at certain times.
- **Sharpe ratio per day** — daily PnL series → annualized Sharpe. Demo-grade metric.
- **CSV export button** for the detailed trades table.
- **A/B threshold simulator** — slider over the saved trades to show "what if threshold had been X" without re-running the bot.

## What NOT to do

- Don't auto-execute or modify trade behavior — this is **read-only**.
- Don't change the `trades` schema; the columns you need are already there.
- Don't post any trade data to external services.
- Don't add charts that need >30 closed trades to be meaningful and then
  show them with 5 trades — display a clear empty state instead.

Good luck. Calibration plot first.
