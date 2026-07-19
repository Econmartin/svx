# SVX demo-day script (5:00, strict)

**Format:** open `svx.econmartin.xyz/present` full-screen. The sequence
INTERLEAVES slides with the site's real live pages — eleven steps total:

  slide, slide, LIVE /overview, slide, LIVE /poly-arb (mainnet
  auto-selected), LIVE /vol-arb (mainnet), slide, LIVE /divergence-mint,
  slide, slide, closing slide.

Arrow-Right advances through everything (slides AND pages) from anywhere;
Arrow-Left goes back; Escape exits presenter mode. On live-page steps a
small corner chip shows the step number and what to point at — the page
itself is the real running site. Slide numbers with a green dot are
fetched live from the bots; each has a safe fallback, so nothing can blank
mid-talk. Speak the page beats below while the live page is on screen.

`/surface` and `/vaults` are deliberately NOT in the timed flow — they are
the Q&A appendix (math and vault-simulation depth, on demand).

**Speak in plain words.** No Greek letters, no equations out loud — the
script below is written exactly as it should be said.

---

## Slide 1 — Problem, solution, value (0:00–0:40)

> "Prediction markets today can't become real market structure, because
> they're priced by vibes — hand-listed events, slow settlement, no
> volatility surface. DeepBook Predict fixes the protocol side: every
> strike, every expiry, priced off a live surface.
>
> But a protocol is not yet a market. A market needs three things no
> protocol can ship for itself: professional participants who trade
> mispricings away, independent verification that the prices are honest,
> and tooling that survives real production conditions.
>
> SVX is all three, running today: Predict's first independent trading
> desk, its first external auditor, and its first infrastructure monitor."

## Slide 2 — The proof (0:40–1:15)

> "Here's the proof it matters. Across every settled oracle — with no
> model of ours in the loop, just Predict's own quoted prices versus what
> actually happened — Predict's favorites quoted at around eighty-seven
> cents actually won about ninety-eight percent of the time. The surface
> is systematically underconfident below ninety cents.
>
> And here's the part I love: DeepBook's own public pre-deployment audit
> tracks the same finding as open items P-two and O-one. We found it from
> the outside with live trading; their auditors found it from the inside.
> Same conclusion. Now let me show you the bot itself — live, in the
> middle of a real outage."

## LIVE /overview — the kill switch, working (1:15–1:40)

*Point at: oracle STALE and the last-update age; Signals 24h: zero; the
testnet bankroll and realized PnL; the LIVE indicator at the bottom.*

> "This is the real dashboard, right now. The bot process is live — but
> Predict's oracle feed is stale; those are deliberately separate health
> states. Instead of trading the enormous fake spreads that expired data
> produces, every signal is being rejected. The brief asked for a kill
> switch on feeder lag — this is it, demonstrating itself in production."

## Slide 3 — Technical implementation (1:40–2:10)

> "Under the hood: three venues, one risk stack. On Predict testnet we
> solve implied volatility from the on-chain surface and mint live — both
> binaries and range ladders, settled and redeemed on-chain. On Polymarket
> we trade real money on Polygon mainnet — and every cent reconciles: a
> wallet-versus-ledger check pauses trading on unexplained drift.
> Hyperliquid supplies our realized-volatility feed.
>
> Let me show you the real-money side — including the part that lost."

## LIVE /poly-arb (mainnet) — real-money proof (2:10–2:35)

*Point at: the top cards — mainnet, real money; settled-trade count; win
rate; strategy PnL. Mention the wallet-vs-ledger reconciliation.*

> "This is not simulated. Three hundred eighty-six settled Polymarket
> fills with the operator's own money, at an eighty-two percent win rate.
> The retained strategy is positive. The total at the bottom includes a
> failed experiment — which deserves its own page."

## LIVE /vol-arb (mainnet) — the honest failure (2:35–3:00)

*Point at: the "Execution CUT by the 2026-07 audit" banner; the $29.12 in
fees for −$1.80 over 5,219 fills; the 2-second realized-vol ticker still
running below.*

> "Our first thesis was wrong, and here's the page that says so. A linear
> perp has no volatility exposure, so it can't harvest an
> implied-versus-realized spread: five thousand two hundred nineteen fills,
> twenty-nine dollars in fees, for less than two dollars of price moves. We
> reconciled it to the cent, hard-disabled it in code, and kept the useful
> part — the realized-vol feed still runs and now protects the strategies
> we kept. Real-money net across everything is minus seven dollars: plus
> six from the keepers, minus thirteen from the experiments we killed.
> Showing you the minus thirteen is the point — we kill strategies with
> data, and that's why you can trust the ones we kept."

## Slide 4 — Path to production (3:00–3:40)

> "Mainnet day one isn't a promise for us — it's a config flip, and we can
> prove readiness three ways.
>
> One: every primitive we use — mint, permissionless redeem, ranges, LP
> supply — is confirmed in the audited, mainnet-bound package, and we've
> already executed every one of them on testnet.
>
> Two: the strategy questions are pre-answered by simulation, which this
> track requires. Our range-ladder replay over a hundred settled oracles
> says: half-sigma-width rungs, plus ten percent. Our LP-plus-insurance
> simulation says: don't — and we published that no with its numbers.
>
> Three: the production migration already happened to us. Sui deprecated
> its old RPC interface two weeks ago; it broke Predict's own feed — frozen
> since July twelfth, their fix already merged upstream and awaiting
> redeploy. Our bot hit the same shutoff, we migrated providers within the
> hour, reported the outage to the DeepBook team — and you saw the result
> two minutes ago: the kill switch refusing about forty-eight thousand
> signals a day, correctly.
>
> And mainnet opens things testnet can't: real economics on the Predict
> leg, the three-protocol margin loop becomes physically possible for the
> first time — already built and simulated — and multi-asset the day they
> list Ethereum."

## LIVE /divergence-mint — the Predict-native strategy (3:40–4:00)

*Point at: both strategy bands (divergence-mint + calibration-harvest);
the live result cards; the replay card with its explicit backtest label.*

> "The failures led to the actual finding. That calibration gap became two
> non-overlapping strategies: large cross-venue divergences, and the
> remaining favorites below ninety cents. These are live testnet results,
> and the replay below is labelled exactly what it is — a backtest."

## Slide 5 — Users and product-market fit (4:00–4:20)

> "Three users, in adoption order. Today: the protocol team — our
> calibration feed and infrastructure monitoring are the analytics this
> brief asked for; we're already effectively Predict's external test desk.
> At mainnet: operators — the whole stack is open source with a runbook,
> and every additional SVX instance is an independent arbitrageur pulling
> the surface toward truth. Later: LPs, once the vault phase is audited.
>
> Why they adopt is simple: quants go where there is measurable edge, and
> we published the measurement."

## Slide 6 — Monetization and roadmap (4:20–4:40)

> "Sustainability in three phases, matching those users. Phase one, now:
> the bot trades its own balance — the strategies fund the operation.
> Phase two, mainnet week one: the calibration feed and a settled-redeem
> keeper as services — the keeper claims other users' winning positions
> for a tip, which is revenue from day one. Phase three, post-audit: the
> tokenized vault. Deliberately no token and no pooled funds until audit
> and legal sign-off — that's a compliance choice, not a gap."

## Slide 7 — Why Sui, and close (4:40–5:00)

> "Why Sui? Because this cannot be built anywhere else. Predict is the
> only volatility-surface-priced prediction protocol in existence, and Sui
> is why it works: sub-second finality makes sub-hour option cycles real;
> the object model gives us a manager account we mint, settle, and redeem
> against programmatically; and programmable transaction blocks let us
> open an entire range ladder — or eventually the full three-protocol
> margin loop — atomically, in one transaction.
>
> SVX: Predict's first independent trading desk, first external auditor,
> and first infrastructure monitor. Live today, mainnet on day one — and
> everything you just heard is verifiable at svx dot econmartin dot xyz,
> right now."

---

## Q&A parking-lot answers (plain words, honest labels)

- **"What's your actual win rate?"** Separate the two claims. Executed,
  real money: three hundred eighty-six settled Polymarket fills, eighty-two
  percent winners, net slightly positive. The ninety-four percent belongs
  to the favored-side strategy and is a BACKTEST over the recorded signal
  stream — reproducible live from the bot's own ledger with one URL. The
  live executed sample there is six for six — small, because the strategy
  went live days before the feeder froze.
- **"Why is real-money PnL negative?"** Minus seven dollars total: plus
  six from strategies, minus thirteen from the delta-hedge experiment we
  measured and killed. The losers are documented post-mortems; the
  strategies themselves are positive.
- **"Why are there no live trades right now?"** Sui's scheduled RPC
  shutoff broke Predict's own indexer — their status endpoint returns a
  four-oh-four on checkpoint fetch. The surface froze July twelfth; since
  then our bot evaluates about forty-eight thousand signals a day and
  refuses every one via the staleness filter. The brief asked for a kill
  switch on feeder lag — it's demonstrating itself live. Same shutoff hit
  our bot July ninth; we migrated within the hour and reported the outage.
- **"When do trades resume?" (follow-up)** We verified this on-chain, not
  just through their API: the surface feeder's wallet posted its last
  transaction at seventeen forty-eight UTC on July twelfth and has been
  silent since — same minute their API's last surface row shows. The
  server-side fix is already merged upstream — the DeepBook repo migrated
  those reads to the new interface on July thirteenth — it just isn't
  deployed yet. The moment their feeder resumes, our surface unfreezes and
  trading restarts with zero changes on our side — the staleness gate
  simply lifts itself.
- **"Could the calibration gap be your model being wrong?"** No model of
  ours is in the loop — it compares Predict's own quoted probability
  against realized settlement outcomes. Our surface reader is validated to
  one part in a million against a reference implementation.
- **"How do you know mainnet will have what you need?"** The primitives
  are in the audited mainnet-bound package — we read it. Their public
  pre-deploy tracker shows two remaining deploy gates, so mainnet is
  weeks, not days — and we're a config flip behind it. (Config flip means
  our migration architecture is ready — if final mainnet interfaces shift,
  that's an adapter change, not a redesign.)
- **"Where's the delta hedge the brief suggested?"** Built, exercised with
  real money, then disabled: it sized the hedge at the wrong expiry, and
  at our clip sizes a correct hedge costs more than the risk it removes.
  The page documents the re-enable conditions.
- **"Show me the math / the vault research."** The Q&A appendix pages:
  `/surface` for the SVI smile, no-arbitrage checker, and butterfly
  telemetry; `/vaults` for the ladder policy shoot-out, the PLP-plus-
  insurance NO, and the margin-loop simulation. `/wallets` has the
  on-chain proof — PredictManager objects and clickable Sui transaction
  digests; `/signals` shows every current svi-stale rejection.
- **"Why should anyone else run this?"** Because the edge is published and
  the runbook is public. Each new operator is an independent arbitrageur —
  and the more there are, the tighter Predict's surface gets. We win by
  being first and by running the services layer.
- **"Vault? Token?"** Not until audit and legal sign-off — deliberately.
  Single-operator today is what keeps this clean.

## Fallbacks

- The /present slides carry documented fallback numbers if the venue
  network dies — the deck cannot blank.
- If a judge grabs the mouse: the whole site IS the appendix — nav order
  matches the build story, and the About page's evidence card maps every
  track requirement to a verifiable URL.

## Things to NOT say

- Do not say "we have a ninety-four percent win rate" without the word
  "backtest" in the same sentence.
- "Delta-neutral by construction" — the hedge is off; that claim is dead.
- "Risk-free" — no such thing.
- Don't promise mainnet dates — cite their public tracker instead.
