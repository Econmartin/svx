# SVX demo script (≤5 minutes)

Target: a Sui Overflow judge with finance background. Goal: convince them
this is the most realistic mainnet-day-one strategy in the DeepBook Predict
track.

## 0:00–0:20 — Hook

> "DeepBook Predict prices every BTC strike continuously, every few seconds,
> via an SVI volatility surface. Polymarket prices a few discrete strikes via
> a human-driven order book. When they disagree by more than three percentage
> points, there's a trade. Here is a bot that takes those trades
> automatically — and is already trading them on Polygon mainnet today."

Show the dashboard landing page. Point to the live status badge, the
realized-PnL chart, and the recent-signals table. Open `/mainnet` for the
Polygon side.

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

Switch to the **Signals** page. Filter to `live_executed` (mainnet) or
`paper_executed` (testnet view).

> "Every row is a real signal generated from real Predict + real Polymarket
> data. Each one names the oracle, the strike, the Predict probability, the
> Polymarket Yes price, the spread, and the side we'd take."

Click a row, point to the `predict_iv` column ("0.65 → Predict thinks the
strike is 65% likely") and the `poly_iv` column ("0.59 → Polymarket implies
59%; the 6% gap is the trade").

Switch to the **/mainnet** page. Point to:

- The pUSD balance + wallet address (link to polygonscan).
- **Open Polymarket positions** — the bot's current Yes/No share holdings.
- **Closed Polymarket positions** — settled trades with payout, PnL, and a
  polygonscan link to the auto-redeem tx.
- The realized pUSD PnL (24h / all-time) StatRow values — those are the
  numbers the daily-loss gate enforces against.

> "Each closed row is the full lifecycle: signal → buy on Polymarket → wait
> for UMA → auto-redeem winning shares for pUSD. The redeem tx is on
> polygonscan, the PnL is recorded, the daily-loss gate updates."

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
two parts: live Polymarket operations (top-up, kill-switch, log triage)
and the pre-flight checklist for the future Sui mainnet switch.

> "The Polymarket leg is mainnet today — the bot trades real pUSD against
> real BTC strike markets and auto-redeems winning shares via the
> NegRiskAdapter. When DeepBook Predict ships on Sui mainnet, the second
> leg flips on with a config change and an address swap. The runbook
> covers both."

> "There are no users. There is no vault. There is no token. SVX trades its
> own balance. The 50% mainnet-prize gate is already cleared: the bot
> runs, the bot trades, the bot is on mainnet — Polygon now, Sui as soon
> as Predict ships there."

## 4:30–5:00 — What's next + the Hyperliquid stretch goal

> "The hackathon brief explicitly listed Hyperliquid delta hedging as the
> stretch goal for this exact bot. We built it.
>
> Every Polymarket fill triggers a delta-sized BTC perp hedge on
> Hyperliquid — short BTC when we bought Yes, long when we bought No. The
> hedge closes at settlement on the same poll loop that detects UMA
> resolution. Combined PnL on the dashboard is poly + HL = pure-vol PnL.
>
> Three venues, one bot, delta-neutral by construction. We don't care
> which way BTC moves — only whether the spread we observed was real."

Open the `/mainnet` dashboard:
- Point to the **HL exposure** stat — current open hedge notional.
- Point to the **HL PnL (all)** stat — funding cost + perp PnL.
- Point to the **Combined PnL (all)** stat — the pure-vol number.
- Scroll to "Open Hyperliquid hedges" — one row per active hedge with
  size, side, open price.
- Scroll to "Closed Polymarket positions" — Poly PnL, HL PnL, Combined
  columns side-by-side. Show how the combined column has tighter swings
  than the Poly column alone.

> "Two more lines of work from here:
>
> 1. **Dynamic hedge rebalancing** for longer-dated positions — re-sizing
>    the HL leg as delta drifts during the day. Currently a static hedge
>    at trade open is sufficient because Polymarket BTC markets typically
>    resolve same-day.
> 2. **Multi-asset** — extend the matching layer to ETH and SOL once
>    Predict adds them. The math, sizing, risk gate, and execution paths
>    are all asset-agnostic; only the matching glue needs an extension."

Close on the dashboard URL + GitHub link. Done.

## Things to NOT say

- "Beats the market" — you don't know that yet.
- "Risk-free arbitrage" — there is no such thing.
- "Will scale to billions" — focus on what you have running today.
- "We're a fund" — you're a bot. That's the whole point.
