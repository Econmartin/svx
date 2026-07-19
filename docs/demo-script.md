# SVX demo-day script (5:00, strict)

**Format:** open `svx.econmartin.xyz/present` full-screen. Eleven steps:
slides interleaved with the real live site. Arrow-Right advances through
everything. Arrow-Left goes back. Escape exits. On live pages, a corner
chip tells you what to point at. Numbers with a green dot are live from
the bots and have safe fallbacks.

`/surface` and `/vaults` are NOT in the flow. They are Q&A backup.

**The story in one line:** Predict prices its favorites too low. We proved
it with real trades, killed the ideas that didn't work, and kept two
strategies that do.

---

## Slide 1 — What SVX is (0:00–0:40)

> "SVX is a trading bot. It trades prediction markets. Bets like: will
> Bitcoin be above sixty-four thousand at two p.m.
>
> DeepBook Predict is a new Sui protocol that prices those bets with real
> options math, from a live volatility surface.
>
> But a protocol alone is not a market. A market needs traders who correct
> bad prices. It needs an outside check that the prices are honest. And it
> needs tooling that survives real outages.
>
> SVX does all three. It is one of the first outside bots trading Predict,
> and it is running right now."

## Slide 2 — What we found (0:40–1:15)

> "Here is our main finding. We compared Predict's own prices to what
> actually happened. No model of ours involved.
>
> When Predict priced a bet around eighty-six cents, meaning an
> eighty-six percent chance, it won every single time. Twenty-four out of
> twenty-four in the current window. That number is live from our ledger.
>
> In short: Predict prices its favorites too low.
>
> And DeepBook's own audit found the same issue: items P-two and O-one on
> their public list. We found it from the outside. They found it from the
> inside. Same answer.
>
> Now the bot itself, live."

## LIVE /overview — the bot, mid-outage (1:15–1:40)

*Point at: oracle STALE, the last-update age, Signals 24h: 0, the LIVE dot.*

> "This is the real dashboard. The bot is running. But look: the price
> feed is stale. It has been frozen since July twelfth, on Predict's side,
> not ours.
>
> So the bot refuses to trade. Zero signals in twenty-four hours. That
> number right there. Trading on a frozen feed is trading on garbage.
>
> The brief asked for a kill switch on feed lag. This is it. Working."

## Slide 3 — How it works (1:40–2:10)

> "Three venues. Predict, on Sui testnet: we read the surface, compute
> fair prices, and mint bets on-chain: mint, settle, redeem, all executed
> live. Polymarket, on Polygon: real money. That is where we proved we
> can execute. Hyperliquid: gives us Bitcoin's actual volatility.
>
> One risk stack over all of it. Position caps. Loss limits. And the
> wallet is checked against our books. If they drift apart, trading
> pauses itself.
>
> Here is the real money."

## LIVE /poly-arb (mainnet) — what we kept (2:10–2:35)

*Point at: the top cards. Fills, win rate, strategy PnL.*

> "Real Polymarket trades, our own money. Three hundred eighty-eight
> settled. Eighty-one percent made a profit. Live numbers.
>
> The strategy is simple: when Predict and Polymarket disagree on the same
> bet, buy the cheap side.
>
> This page is a winner we kept. The next page is the one that failed."

## LIVE /vol-arb (mainnet) — what failed (2:35–3:00)

*Point at: the "Execution CUT" banner, the fee numbers, the ticker below.*

> "Our first idea. It was wrong. We tried to profit when implied
> volatility disagreed with actual volatility, by trading a perpetual
> future on Hyperliquid. A perpetual future is just a rolling bet on
> Bitcoin's price. It moves with price, not volatility. So there was
> nothing to harvest.
>
> The bill: five thousand two hundred trades, twenty-nine dollars of fees,
> two dollars of movement. We shut it off in code.
>
> Across everything, real money is down seven dollars. Up six from what we
> kept. Down thirteen from what we killed. We show the losses because that
> is how you know the wins are real."

## Slide 4 — Getting to mainnet (3:00–3:40)

> "Three reasons we are ready.
>
> One: every function we call is in the
> audited package headed to mainnet. The basic cycle we have run end to
> end on testnet. Ranges and LP supply are coded and simulated, waiting
> only on the frozen feed.
>
> Two: we tested the vault ideas by simulation before risking money. Our
> replay over a hundred settled oracles showed narrow range ladders
> earning about ten percent. The insurance idea lost money, because the
> insurance costs more than the yield. We published both answers.
>
> Three: the hard part of production already happened to us. Sui switched
> off its old RPC. It broke Predict's own feed. That is the freeze you
> saw. It hit us too. We swapped providers within the hour and reported
> the outage. Their fix is merged, so it looks like it is getting fixed."

## LIVE /divergence-mint — what the failures taught us (3:40–4:00)

*Point at: the two strategy bands, the result cards, the backtest label.*

> "The failures pointed at the real edge. Predict underprices favorites,
> so we built two strategies that buy them. One buys when Predict and
> Polymarket disagree by a lot. The other buys favorites in the quiet
> cases. No overlap between them.
>
> Every settled trade so far has won: one live here, five in the mainnet
> mirror. Small sample; the feed froze days after launch. The replay below
> says exactly what it is: a backtest."

## Slide 5 — Who can use it (4:00–4:20)

> "Two audiences. The Predict and Sui teams: we run their protocol end to
> end every day, independently. When we find issues, we report them. The
> feed outage you saw is a live example.
>
> And other operators. The code is open source with a runbook, and every
> new operator makes Predict's prices tighter.
>
> Today it is one operator. The edge is measured and published, and that
> is what attracts the next one."

## Slide 6 — How it pays for itself (4:20–4:40)

> "Simple. The bot trades its own money. We find mispricings, test them,
> and trade the ones that survive. Winners fund the operation. Losers get
> shut off and written up.
>
> No token. No deposits. No pooled funds. If that ever changes, it happens
> after an audit and legal sign-off, not before."

## Slide 7 — Why Sui, and close (4:40–5:00)

> "Predict only exists on Sui, and it needs Sui. Settlement fast enough
> for hour-long bets. Objects we can hold and redeem in code. And
> transaction blocks that open a whole ladder of bets in one atomic
> transaction.
>
> SVX. One of the first outside desks on Predict. Live today. Mainnet on
> day one."

---

## Q&A answers (short, honest)

- **"What's your win rate?"** Two numbers, kept separate. Real money:
  three hundred eighty-eight settled Polymarket fills, eighty-one percent
  profitable. The ninety-four percent is a backtest of the favorites
  strategy, recomputable live from our ledger. Executed favorites so far:
  six settled, six wins (one live, five paper) plus four still open.
- **"Why is real money down?"** Down seven total. Up six from the kept
  strategies. Down thirteen from the hedge experiment we killed and wrote
  up.
- **"Why no trades right now?"** Sui turned off its old RPC. That broke
  Predict's feed on July twelfth. Our bot sees tens of thousands of
  candidates a day and refuses all of them: stale feed. Same shutoff hit
  us July ninth; we fixed ours within the hour and reported theirs.
- **"When do trades resume?"** We checked on-chain: the feeder wallet went
  silent at seventeen forty-eight UTC on July twelfth. Their fix is merged
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
