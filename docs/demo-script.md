# SVX demo-day script (5:00, strict)

**Format:** open `svx.econmartin.xyz/present` full-screen. The sequence
INTERLEAVES slides with the site's real live pages — eleven steps total:

  slide, slide, LIVE /surface, slide, LIVE /poly-arb (mainnet
  auto-selected), slide, LIVE /vaults, slide, slide, LIVE /divergence-mint,
  closing slide.

Arrow-Right advances through everything (slides AND pages) from anywhere;
Arrow-Left goes back; Escape exits presenter mode. On live-page steps a
small corner chip shows the step number and what to point at — the page
itself is the real running site. Slide numbers with a green dot are
fetched live from the bots; each has a safe fallback, so nothing can blank
mid-talk. Speak the page beats below while the live page is on screen.

**Speak in plain words.** No Greek letters, no equations out loud — the
script below is written exactly as it should be said.

---

## Slide 1 — Problem, solution, value (0:00–0:45)

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

## Slide 2 — The proof (0:45–1:30)

> "Here's the proof it matters. Across every settled oracle — with no
> model of ours in the loop, just Predict's own quoted prices versus what
> actually happened — Predict's favorites quoted at around eighty-seven
> cents actually won about ninety-eight percent of the time. The surface
> is systematically underconfident below ninety cents.
>
> And here's the part I love: DeepBook's own public pre-deployment audit
> tracks the same finding as open items P-two and O-one. We found it from
> the outside with live trading; their auditors found it from the inside.
> Same conclusion. That is exactly what an independent market participant
> is for — and this number recomputes live from the bot's ledger; the URL
> is on screen."

## Slide 3 — Technical implementation (1:30–2:25)

> "Under the hood: three venues, one risk stack. On Predict testnet we
> solve implied volatility from the on-chain surface and mint live — both
> binaries and range ladders, settled and redeemed on-chain. On Polymarket
> we trade real money on Polygon mainnet: three hundred eighty-six settled
> fills at an eighty-two percent win rate, and every cent reconciles — a
> wallet-versus-ledger check pauses trading on unexplained drift.
> Hyperliquid supplies our realized-volatility feed.
>
> And the honest ledger: real-money net is minus seven dollars — plus six
> from the strategies, minus thirteen from a delta-hedge experiment we
> measured, published the post-mortem for, and shut off. We think showing
> you the minus thirteen is the point. We killed three strategies with
> data; that's why you can trust the ones we kept."

*(If asked about the ninety-four percent later: that is a BACKTEST over
the recorded signal stream, reproducible live from the bot's own ledger;
the live executed sample is six for six, small but clean.)*

## Slide 4 — Path to production (2:25–3:20)

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
> Three — and this is the unusual one — the production migration already
> happened to us. Sui deprecated its old RPC interface two weeks ago. It
> broke Predict's own indexer; the feed has been frozen since July
> twelfth — you can check their status endpoint yourself. Our bot hit the
> same shutoff, we migrated providers within the hour, reported the outage
> to the DeepBook team, and our feeder-lag kill switch has correctly
> refused about forty-eight thousand signals a day ever since. That is
> what production operations actually look like, and we've already done
> them.
>
> And mainnet opens things testnet can't: real economics on the Predict
> leg, the three-protocol margin loop becomes physically possible for the
> first time — today those protocols live on different networks, and we've
> already built and simulated it — and multi-asset the day they list
> Ethereum."

## Slide 5 — Users and product-market fit (3:20–3:55)

> "Three users, in adoption order. Today: the protocol team — our
> calibration feed and infrastructure monitoring are the analytics this
> brief asked for; we're already effectively Predict's external test desk.
> At mainnet: operators — the whole stack is open source with a runbook,
> and every additional SVX instance is an independent arbitrageur pulling
> the surface toward truth, which is how Predict's pricing becomes
> trustworthy enough for size. Later: LPs, once the vault phase is
> audited.
>
> Why they adopt is simple: quants go where there is measurable edge, and
> we published the measurement."

## Slide 6 — Monetization and roadmap (3:55–4:30)

> "Sustainability in three phases, matching those users. Phase one, now:
> the bot trades its own balance — the strategies fund the operation.
> Phase two, mainnet week one: the calibration feed and a settled-redeem
> keeper as services — the keeper claims other users' winning positions
> for a tip, which is revenue from day one. Phase three, post-audit: the
> tokenized vault — LPs deposit, the validated strategies run, with
> on-chain economics anyone can audit.
>
> Deliberately no token and no pooled funds until audit and legal
> sign-off. That's a compliance choice, not a gap."

## Slide 7 — Why Sui, and close (4:30–5:00)

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
- **"Could the calibration gap be your model being wrong?"** No model of
  ours is in the loop — it compares Predict's own quoted probability
  against realized settlement outcomes. Our surface reader is validated to
  one part in a million against a reference implementation.
- **"How do you know mainnet will have what you need?"** The primitives
  are in the audited mainnet-bound package — we read it. Their public
  pre-deploy tracker shows two remaining deploy gates, so mainnet is
  weeks, not days — and we're a config flip behind it.
- **"Where's the delta hedge the brief suggested?"** Built, exercised with
  real money, then disabled: it sized the hedge at the wrong expiry, and
  at our clip sizes a correct hedge costs more than the risk it removes.
  The page documents the re-enable conditions.
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
