# SVX demo-day script (5:00, strict)

**Format:** open `svx.econmartin.xyz/present` full-screen. Twelve steps:
slides interleaved with the real live site. The final step lands on the
live homepage, which stays on screen for Q&A. Arrow-Right advances through
everything. Arrow-Left goes back. Escape exits. On live pages, a corner
chip tells you what to point at. Numbers with a green dot are live from
the bots and have safe fallbacks.

`/surface` and `/vaults` are NOT in the flow. They are Q&A backup.

**The story in one line:** Predict prices its favorites too low. We proved
it with real trades, killed the ideas that didn't work, and kept two
strategies that do.

---

## Slide 1 — What SVX is (0:00–0:30)

> "SVX is a trading bot for prediction markets, built on DeepBook Predict,
> which prices bets like:
>
> will Bitcoin be above $64,000 at 2 p.m.
>
> from a live volatility surface.
>
> But a protocol alone is not a
> market. A market needs traders, honest-price checks, and tooling that
> survives outages, and SVX is all three, running right now."

## Slide 2 — What we found (0:30–1:00)

> "We compared Predict's own prices to what actually happened, with no
> model of ours involved.
>
> Favorites priced around 86 cents
> won every single time,
> 24 out of 24, live from our ledger.
>
> Predict prices its favorites too low, and DeepBook's own audit tracks
> the same finding. Here is the bot, live."

## LIVE /overview — the bot, mid-outage (1:00–1:30)

*Point at: oracle STALE, Signals 24h: 0, bankroll and PnL, the LIVE dot.*

> "The bot is running, but the price feed has been frozen since July 12
> on Predict's side, so it refuses to trade. Zero signals in 24 hours,
> right there.
>
> That is the kill switch the brief asked for, working in production."

## Slide 3 — How it works (1:30–1:55)

> "Under the hood there are three venues and one risk stack. Predict
> prices everything, Polymarket is where we trade real money, and
> Hyperliquid measures actual volatility. Position caps, loss limits, and
> the wallet is checked against our books, with trading pausing on any
> drift.
>
> Here is the real money."

## LIVE /poly-arb (mainnet) — what we kept (1:55–2:25)

*Point at: the top cards. Fills, win rate, strategy PnL.*

> "These are real Polymarket trades with our own money, 388 settled and
> 81% profitable. The strategy is
> simple: when the two venues disagree on the same bet, we buy the cheap
> side. And the next page is the one that failed."

## LIVE /vol-arb (mainnet) — what failed (2:25–2:55)

*Point at: the "Execution CUT" banner, the fee numbers, the live ticker.*

> "Our first idea was wrong. We tried to trade implied against realized
> volatility using a perpetual future, which is just a rolling bet on
> price, so there was nothing to harvest. 5,219 trades and $29 of fees
> for $2 of movement, and we shut it off in code.
>
> Overall real money is down $7, up $6 from what we kept and down $13
> from what we killed, and showing you that is the point."

## Slide 4 — Getting to mainnet (2:55–3:30)

> "Three reasons we are ready. Everything we call is in the audited
> package headed to mainnet, and the basic cycle runs end to end on
> testnet. The vault ideas are answered by simulation, where narrow
> ladders earned about 10% over 100 oracles and the insurance idea lost
> money, so we published both. And the hard part
> already happened: Sui's RPC shutoff broke their feed and hit us too. We
> migrated within the hour and reported it, and their fix is merged."

## LIVE /divergence-mint — what the failures taught us (3:30–4:00)

*Point at: the two strategy bands, the result cards, the backtest label.*

> "The failures pointed at the real edge. Predict underprices favorites,
> so we built two strategies that buy them, one for big disagreements
> between the venues and one for the quiet cases. Every settled trade so
> far has won, on a small sample, and the replay down here is labelled
> exactly what it is, a backtest."

## Slide 5 — Who can use it (4:00–4:15)

> "Two audiences. The Predict and Sui teams, because an independent bot
> exercises their protocol daily and reports what it finds. And other
> operators, because it is open source with a runbook, and every new
> operator makes the prices tighter."

## Slide 6 — How it pays for itself (4:15–4:35)

> "It pays for itself by trading its own money, in small positions on
> purpose. Winners fund the operation and losers get shut off and written
> up. The next step is scale, with deeper analytics and more strategy
> checks along the way. And no token, no deposits, no pooled funds without
> an audit and legal sign-off."

## Slide 7 — Why Sui, and close (4:35–4:55)

> "Why Sui? Because Predict only exists here: settlement fast enough for
> hour-long bets, objects we can hold and redeem in code, and one atomic
> transaction can open a whole ladder. SVX, one of the first outside desks
> on Predict, live today, mainnet on day one."

## Step 12 — the live homepage (close)

*One more Arrow-Right lands on the homepage. Leave it up for Q&A.*

> "So that's SVX, live, looking forward to mainnet."

---

## Q&A answers (short, honest)

- **"What's your win rate?"** Two numbers, kept separate. Real money:
  388 settled Polymarket fills, 81% profitable. The 94% is a backtest of
  the favorites strategy, recomputable live from our ledger. Executed
  favorites so far: 6 settled, 6 wins (1 live, 5 paper) plus 4 still
  open.
- **"Why is real money down?"** Down $7 total. Up $6 from the kept
  strategies. Down $13 from the hedge experiment we killed and wrote up.
- **"Why no trades right now?"** Sui turned off its old RPC. That broke
  Predict's feed on July 12. Our bot sees tens of thousands of
  candidates a day and refuses all of them: stale feed. Same shutoff hit
  us July 9; we fixed ours within the hour and reported theirs.
- **"When do trades resume?"** We checked on-chain: the feeder wallet went
  silent at 17:48 UTC on July 12. Their fix is merged
  in their repo, not yet deployed. The moment their feed returns, our bot
  resumes by itself. Zero changes needed on our side.
- **"Could your model be wrong about the mispricing?"** There is no model
  of ours in that number. It is Predict's own price versus what actually
  happened.
- **"Will mainnet have what you need?"** Yes. We read the package. Their
  tracker shows two open gates, so mainnet is weeks away. If an interface
  shifts, that is an adapter change for us, not a redesign.
- **"Where's the delta hedge?"** Built, run with real money, then
  disabled. It hedged at the wrong expiry, and at our sizes a correct
  hedge costs more than it saves. Re-enable conditions are on the page.
- **"Your vaults page says three oracles?"** The live page recomputes on
  what the bot's database still holds: three, since the feed froze. The
  hundred-oracle result is the archived study in our backtest report. Two
  datasets, both labelled.
- **"Show me the math."** `/surface` for the pricing. `/vaults` for the
  vault research. `/wallets` for on-chain proof with transaction digests.
  `/signals` for every refused signal.
- **"Why would others run this?"** The edge is published and the runbook
  is public. More operators means tighter prices. We win by being early
  and by knowing the edges best.
- **"Vault? Token?"** Neither exists and neither is promised. If we ever
  pool funds, it happens after an audit and legal sign-off. Single
  operator keeps it clean today.

## Fallbacks

- Slides carry fallback numbers if the network dies. The deck cannot blank.
- If a judge takes the mouse: the whole site is the appendix. The About
  page maps every requirement to a URL.

## Things to NOT say

- Never "ninety-four percent win rate" without "backtest" in the same
  sentence.
- Never "we executed range ladders / LP supply on-chain". Coded and
  simulated only; the feed froze first.
- Never promise services or a vault as products. The model is: trade our
  own money, publish the results.
- Never "delta-neutral". The hedge is off.
- Never "risk-free."
- Never promise a mainnet date. Point at their tracker.

## Extra time — the appendix pages (speak these if you have spare minutes)

### /surface — the pricing math, live

*Point at: the smile curve, the no-arbitrage checker, the butterfly card.*

> "This is Predict's volatility surface, live from the chain. The curve
> shows the implied volatility the protocol quotes at every strike. We
> re-derive every price ourselves, matched to one part in a million
> against a reference implementation, and run a no-arbitrage check on
> every update. Any violation shows up here as a butterfly alert."

### /vaults — the vault research

*Point at: the ladder table, the live-window warning note, the PLP card.*

> "This is where we tested the brief's vault ideas before risking money.
> The ladder table replays a strategy that spreads bets across a range of
> strikes. In the archived 100-oracle study, narrow rungs earned about
> 10%. The live table only replays what the database still holds, which
> is 3 oracles since the feed froze, and the note on the card says
> exactly that. Below it is the liquidity-plus-insurance idea, which
> lost money in simulation, so we published the no."

### /wallets — the on-chain proof

*Point at: the Sui manager balance, the clickable transaction digests,
the Polygon and Hyperliquid balances.*

> "Everything I have claimed is checkable here. This is the bot's Sui
> account: it started with 5,000 test dollars and the balance now reads
> about 5,080, so up around 80, with 4 open positions still waiting on
> the stalled settlement. Realized profit across all closed trades is
> plus 154; the difference
> is capital sitting inside those open positions until the crank resumes.
> Every transaction digest here is clickable and goes to the Sui explorer.
> Below that, the real-money Polygon wallet and the Hyperliquid account,
> which reconcile against our books continuously."

*Numbers note: balance up ~80 dUSDC vs the 5,000 start; realized PnL
+154 counts closed trades only. The ~74 gap is cost locked in the 4 open
positions on the expired-but-unsettled weekly oracle. They pay out when
Mysten's settlement crank resumes; nothing to do on our side.*
