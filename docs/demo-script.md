# SVX demo script (≤5 minutes)

Target: a Sui Overflow judge with finance background. Goal: convince them
this is the most realistic mainnet-day-one strategy in the DeepBook Predict
track.

## 0:00–0:20 — Hook

> "DeepBook Predict prices every BTC strike continuously, every few seconds,
> via an SVI volatility surface. Polymarket prices a few discrete strikes via
> a human-driven order book. When they disagree by more than three percentage
> points, there's a trade. Here is a bot that takes those trades
> automatically."

Show the dashboard landing page. Point to the live status badge, the
realized-PnL chart, and the recent-signals table.

## 0:20–1:00 — The math, briefly

Switch to the **Surface** page. Show:

- The IV smile for the soonest-expiring oracle.
- The UP-probability curve descending across strikes.
- "This is the curve we evaluate at every Polymarket strike."

Don't go deeper than necessary; the writeup carries the rigor. If pressed:
*"Raw SVI, w(k) = a + b·(ρ(k − m) + √((k − m)² + σ²)). Same parameterization
as Predict's on-chain oracle. Validated against Python `math.erf` reference
to within 1e-6."*

## 1:00–2:30 — Live trading log

Switch to the **Signals** page. Filter to `paper_executed`.

> "Every row is a real signal generated from real Predict + real Polymarket
> data. Each one names the oracle, the strike, the Predict probability, the
> Polymarket Yes price, the spread, and the side we'd take. We've been
> running this for [N] weeks; here's the log."

Click a row, point to the `predict_iv` column ("0.65 → Predict thinks the
strike is 65% likely") and the `poly_iv` column ("0.59 → Polymarket implies
59%; the 6% gap is the trade").

Switch to the **Positions** page. Show closed trades, PnL distribution.

> "Win rate is [X]%. Average trade PnL is [Y] dUSDC. Over [N] weeks of
> testnet operation, total realized PnL is [Z] dUSDC."

## 2:30–3:30 — Risk controls demo

Open a terminal. Run:

```bash
pnpm svx pause
```

Refresh the dashboard — the status badge flips to red `paused`. New signals
keep being logged but `risk_blocked` reasons appear.

```bash
pnpm svx resume
```

Walk through the risk control table from
[risk-controls.md](risk-controls.md). Emphasize the "non-negotiable" framing
and the manual kill switch.

> "Every control here is a hard gate. None is a knob. You can shut the bot
> down from the command line in under a second. That's why this is a bot you
> can run on mainnet."

## 3:30–4:30 — Mainnet readiness

Switch to a terminal and show `docs/mainnet-runbook.md`. Highlight the
capital ramp table and the pre-flight checklist.

> "When DeepBook Predict ships on mainnet, SVX flips one config flag and
> swaps in the mainnet package ID. The capital ramp starts at 50 USDC per
> trade, scales to target over two weeks. Operator key on a hardware wallet,
> alerts wired, on-call rotation if it's a team."

> "There are no users. There is no vault. There is no token. SVX trades its
> own balance. The 50% mainnet-prize gate is trivially clearable: the bot
> runs, the bot trades, the bot is on mainnet."

## 4:30–5:00 — What's next

> "Three stretch goals on the roadmap:
>
> 1. Hyperliquid delta hedge for pure-vol PnL.
> 2. Internal Predict-vs-Predict butterfly/calendar arb-free checker — a
>    diagnostic for the SVI feeder.
> 3. Multi-asset: ETH, SOL, anything Predict adds.
>
> The math, the data layer, and the risk gate are all multi-asset by
> construction; only the matching logic needs an extension."

Close on the dashboard URL + GitHub link. Done.

## Things to NOT say

- "Beats the market" — you don't know that yet.
- "Risk-free arbitrage" — there is no such thing.
- "Will scale to billions" — focus on what you have running today.
- "We're a fund" — you're a bot. That's the whole point.
