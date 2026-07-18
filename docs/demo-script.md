# SVX demo script (5:00, hard cap)

Target: a Sui Overflow judge with a finance background. The pitch in one
sentence: **everything works end to end on real infrastructure, the strategy
built FOR Predict is profitable and validated out-of-sample, and along the
way we measured the SVI feeder's calibration and can hand Mysten the
numbers.** The failures are not hidden — they're the middle act, each with
the data that killed it.

The site is ordered as the demo. Start at the landing page and walk the
numbered "build, in order" steps top to bottom — the nav bar follows the
same sequence, so if a judge grabs the mouse they land in the same story.

Every claim links to a live page or an API URL. Nothing is a slide.

---

## 0:00–0:30 — Hook (landing page)

> "DeepBook Predict prices every BTC strike continuously via an on-chain SVI
> volatility surface. Polymarket prices a few hand-listed strikes via a
> human order book. This bot reads Predict's surface, finds the
> disagreements, and trades them — on testnet against Predict itself with
> dUSDC, and with real money on Polygon mainnet. Everything you're about to
> see is live; you can verify any number from your own laptop."

Stay on the landing page. The numbered journey below the hero IS the agenda
— read the five step titles aloud, ten seconds, then start walking.

## 0:30–1:15 — Step 1: the pricing brain (`/surface`)

*Network toggle: TESTNET (stay here from the start — the surface IS testnet Predict).*

- Live SVI smile for the soonest oracle; UP-probability curve across strikes.
- "We back-solve implied vol from the on-chain `OracleSVI` params and
  reprice any strike at any expiry. The butterfly arbitrage-free checker
  runs on every update."
- If pressed on math: raw SVI `w(k) = a + b(ρ(k−m) + √((k−m)²+σ²))`,
  validated against a Python `math.erf` reference to 1e-6; 36 math tests.

## 1:15–2:15 — Step 2: real money against the surface (`/poly-arb`)

*Network toggle: flip to MAINNET — say it out loud: "switching to the real-money side." Stay on mainnet through step 3.*

- Flip the network toggle to **mainnet**: real fills on the Polygon CLOB,
  UMA settlement detection, on-chain auto-redeem via the NegRiskAdapter.
- Point at one settled trade row: entry price, exit, realized PnL.
- The credibility beat, verbatim:
  > "This bot trades the operator's own real money. Every cent is
  > reconciled: a wallet-vs-ledger invariant recomputes what the wallet
  > SHOULD hold on every tick and pauses trading on unexplained drift. When
  > our exits were realizing five to ten points below the tape, we caught
  > it in this data and replaced the market orders with a floor-priced
  > exit ladder."

## 2:15–2:55 — Step 3: the post-mortems (`/vol-arb`, gesture at `/margin-lever`)

> "Three strategies did not survive contact with real money, and we can say
> exactly why. The IV-RV perp strategy paid $29.12 in fees for $1.80 of
> direction PnL over five thousand fills — a perp has no vega; the
> instrument cannot harvest a vol signal. It's hard-disabled in code, and
> this page is its post-mortem. The delta hedge and the margin-lever signal
> got the same treatment: measured, documented, off."

One breath, then the pivot line: **"We kill losers with data. Which is why
you can believe the next two pages."**

## 2:55–3:40 — Step 4: the finding (landing-page calibration table)

*Network toggle: back to TESTNET for the rest of the demo.*

- Scroll to the quoted-vs-realized calibration table (live from
  `GET /calibration`, recomputed from the bot's own ledger).
- The brief called this bot "a live stress test of the SVI feeder" — deliver
  the test result:
  > "Against every recorded oracle settlement: above 90 cents Predict's
  > surface is well calibrated. Below 90 it is systematically
  > underconfident — favorites quoted at 55 to 80 cents realize 19 to 24
  > points higher. And the gap concentrates exactly where Polymarket
  > disagrees with the surface. That's protocol-grade feedback on the SVI
  > feeder, computed live, reproducible with one curl."

## 3:40–4:40 — Step 5: the strategy that finding implies (`/divergence-mint`)

- "If Predict's favorite is underpriced when the venues diverge, buy the
  favorite ON Predict. That's divergence-mint — the Predict-native strategy."
- Point at: live testnet positions with Sui tx digests (real `predict::mint`,
  real `redeem_permissionless`), the win-rate stat, the live-replay card.
- The validation beat:
  > "94 percent win rate, +11.9 percent ROI on May data. 93.5 and +11.5 on
  > July data. Two disjoint windows, deduped to independent bets, two
  > percent fee haircut — and the bot recomputes it from its own ledger on
  > demand; the URL is on screen."
- The mainnet-day-one beat:
  > "This runs live with dUSDC on testnet right now. The day Predict ships
  > on Sui mainnet it's an address swap and one config flip — the exact
  > redeploy-on-day-one the track asks for."

## 4:40–5:00 — Close (`/about`, requirements card at the top)

> "Testnet contract integration: live, tx digests on every row. End-to-end:
> you just watched it. Simulation results: two API endpoints you can curl
> right now. And the one strategy that's profitable is the one built for
> Predict — which is the venue this track is about."

---

## Parking-lot answers (if asked)

- **"Why are there no live trades right now?"** Tell it proactively — it's
  a strength: Sui's scheduled JSON-RPC shutoff (testnet: week of July 6)
  broke Mysten's own predict-server indexer — curl their /status and it
  says "failed to get latest checkpoint: 404". The SVI feed froze July 12;
  since then our bot has evaluated ~48,000 signals a day and refused every
  one via the svi_stale filter. The brief asked for "a kill switch on
  feeder lag" and "a live stress test of the SVI feeder" — both are
  demonstrating themselves live. The same shutoff hit OUR bot July 9; we
  diagnosed it and migrated RPC providers within the hour, then reported
  the feeder outage to the DeepBook team. Open positions are safe on-chain
  awaiting their settlement crank.
- **"Why is poly-arb only breakeven?"** The entry edge was real but
  execution slippage ate it — measured at 5–10pp on stops via minute-level
  prices-history. The exit ladder shipped this week; re-measuring over the
  next ~20 trades. We publish the loss, the cause, and the fix.
- **"Why should we trust the 94%?"** Dedupe (one bet per oracle event — the
  15s loop re-observes the same opportunity ~40×), a 2% fee haircut, two
  disjoint windows, and the replay runs server-side from the deployed
  ledger — you don't have to trust our CSVs.
- **"Could the calibration gap be YOUR model being wrong?"** No model of
  ours is in the loop: it compares Predict's own quoted probability against
  realized settlement outcomes. Our SVI evaluator is only used to READ the
  quote, and it's validated to 1e-6 plus an arbitrage-free checker.
- **"Where's the delta hedge?"** (the brief's stretch goal) Built and
  exercised on mainnet, then disabled by the audit: it sized delta at the
  15-minute oracle expiry instead of the Polymarket expiry, and a correctly
  sized ATM hedge exceeds the per-trade cap at $4 clips. Honest answer:
  at this clip size a hedge costs more than the risk it removes; the code
  and the re-enable conditions are documented.
- **"Why does margin-lever have no trades?"** By design: the audit found
  its signal decomposes to a forward-basis z-score that fires on noise, so
  it runs in paper mode with an open threshold the broken signal can't
  reach. The page shows it deciding "hold" every tick with the reason —
  a strategy alive, watching, and declining to trade.
- **"Kelly sizing?"** Fixed clips on purpose at this bankroll;
  equity-scaled sizing is a written task (docs/tasks) gated on more settled
  history.
- **"Vault? Token?"** Deliberately no Move package and no pooled funds — a
  single-operator bot stays out of securities territory until the
  post-audit vault phase (roadmap on /about).

## Fallbacks

- If venue Wi-Fi dies: `docs/api-samples/` has canned JSON for the key
  endpoints, and the README carries the same headline numbers with method.
- If a page errors mid-demo: the About page's evidence card covers every
  claim from a single page.

## Things to NOT say

- "Beats the market" — not established.
- "Risk-free arbitrage" — no such thing.
- "Delta-neutral by construction" — the hedge is off; that claim died in
  the audit.
- "Will scale to billions" — demo what runs today.
- "We're a fund" — it's a single-operator bot. That's the point.
