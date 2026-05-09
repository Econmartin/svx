# Task — Add Polymarket execution leg

You are picking up this task in a fresh worker session. Treat this doc as the
complete brief — read it end to end before writing code. Then read the files
linked at the bottom.

## TL;DR

SVX currently executes a **1-leg directional bet on Predict** using
Polymarket prices as a reference. The user wants to add the **second leg —
actually executing on Polymarket** — so the bot runs true cross-venue
hedged vol-arb instead of a directional view-trade.

The existing Predict path is **working in production on Coolify** and must
not be regressed. Add the Polymarket leg as a parallel execution path that
the strategy can opt into.

## Context for the worker

- Repo: `/Users/martinswdev/Repos/SVX` (also at github.com/Econmartin/svx).
- Track: Sui Overflow 2026, DeepBook Predict track. Submission deadline
  June 21 2026.
- The bot is deployed on Coolify (Hetzner box, owner has the URL). Local dev
  works via `docker compose up`.
- The user trades from a **single Sui wallet** with a **PredictManager**
  already created (id stored in `data/operator.json`).
- A first $0.50 live trade was bug-flushed end-to-end: mint → settle → redeem
  → +$0.242 PnL. The Predict execution path is proven.
- Live caps right now: `MAX_POSITION_DUSDC=15`, `MAX_OPEN_POSITIONS=10`,
  `DAILY_LOSS_LIMIT_DUSDC=150`, `SPREAD_THRESHOLD=0.03`.
- See [docs/strategy-spec.md](../strategy-spec.md) for the full strategy.

## Why we want this

Quoting from `docs/strategy-spec.md`:

> SVX is **technically a 1-legged directional bet** against Polymarket's
> price. To do true vol-arb (hedged both legs), you'd need to execute on
> Polymarket too, which means a Polygon wallet + their TOS.

For the demo writeup we'd ideally claim "hedged cross-venue arb" rather than
"directional bet informed by Polymarket disagreement." The demo script
([docs/demo-script.md](../demo-script.md)) currently lists the Polymarket
execution as a v2 stretch goal.

## Polymarket key facts (read carefully — different from Sui)

- **Chain**: Polygon (EVM, chainId 137). NOT Ethereum mainnet.
- **Quote asset**: native USDC on Polygon (NOT bridged).
- **Wallet**: needs an EVM wallet (private key in standard Ethereum format,
  not Sui bech32). The user does NOT yet have one set up.
- **TOS / geo**: US users are blocked from trading; some other jurisdictions
  too. Confirm with the user that they're comfortable accepting Polymarket's
  TOS before going live.
- **Account model** (this is the multi-step gotcha):
  1. User signs an EIP-712 message → Polymarket derives an L1 proxy wallet
     contract address (a Gnosis Safe).
  2. User funds the **proxy wallet** with USDC on Polygon.
  3. User generates **L2 API credentials** (API key + secret + passphrase)
     by signing another message via the CLOB SDK.
  4. Orders are placed by signing each one with the L1 key + authenticated
     to the API with the L2 creds.
- **Order types**: limit (`GTC`, `FOK`, `GTD`) and market. Market orders
  fill at the best available price plus slippage; limit orders may not fill.
- **Fees**: Polymarket fees are 0% maker / 0% taker on most markets right
  now (verify before assuming) but reserve the right to charge.
- **SDK**: `@polymarket/clob-client` (TypeScript) is well-documented. There's
  also a Python one. Use the TS one to fit our stack.
- **Settlement**: UMA optimistic oracle. Resolves a few hours after the
  underlying event. Predict settles immediately on next price push past
  expiry. So the **two legs settle at slightly different times** — usually
  same direction (whoever's right about BTC > $80k stays right) but cash
  flow timing differs.

## Architecture proposal (default; you can deviate with rationale)

Add to `packages/svx-bot/src/exec/`:

- `polymarket-client.ts` — wraps `@polymarket/clob-client`. Handles wallet
  derivation, L2 cred bootstrapping, order signing, order submission.
- `polymarket-keypair.ts` — loads the EVM private key from
  `POLY_PRIVATE_KEY` env var (hex-encoded, 0x-prefixed). Validates with a
  read-only RPC call.

Update `packages/svx-bot/src/exec/`:

- Extend the existing live execution path so that for a chosen signal, the
  bot can submit BOTH a Predict mint AND a Polymarket order. They cannot be
  atomic across chains; submit Polymarket first (it's the side with risk of
  not filling), then Predict only if the Polymarket leg fills.
- New trade record fields: `polyOrderId`, `polyFilledShares`,
  `polyFillPrice`, `polyTxHash` (Polygon tx for the fill).

Update `packages/svx-bot/src/signal/spread.ts`:

- The `decision.predictDirection` and which side of Polymarket to trade are
  already computed correctly (`spreadBuyOnPoly` → buy Yes on Poly + mint
  DOWN on Predict; `spreadSellOnPoly` → sell Yes on Poly + mint UP on
  Predict). Make sure the code emits both legs cleanly.

Update `packages/svx-bot/src/exec/risk.ts`:

- New gate: max Polymarket open exposure (USDC). Symmetric to the Predict
  cap but separate because we're spending USDC on Polygon, not dUSDC on Sui.
- New gate: min Polymarket order book depth at our price (don't fire if
  the best ask only has 5 shares; we'd partial-fill at bad average prices).

New env vars (add to `.env.example` and `config.ts`):

- `POLY_EXECUTION_ENABLED=false` — defaults OFF. The user must explicitly
  enable Polymarket execution. Critical safety gate.
- `POLY_PRIVATE_KEY` — EVM private key for the Polymarket wallet (Secret).
- `POLY_PROXY_WALLET` — derived proxy wallet address (script can compute and
  persist this similarly to `setup-manager` for Predict).
- `POLY_RPC_URL` — Polygon RPC. Default to a public one for read; user
  supplies a private one for writes (Alchemy/Infura).
- `MAX_POLY_POSITION_USDC=5` — start tiny, same vibe as the Predict
  bug-flush.
- `POLY_MIN_BOOK_DEPTH_SHARES=50` — minimum size at the level we'd trade.

## What NOT to do

- Do **not** modify the existing Predict mint/redeem path — it's working in
  production. Add new code paths in parallel.
- Do **not** auto-execute Polymarket trades without explicit operator
  config: `POLY_EXECUTION_ENABLED=true` AND a valid `POLY_PRIVATE_KEY`. Even
  then start with paper-only Polymarket logging until the user signs off.
- Do **not** assume the Predict and Polymarket prices map 1:1 across the
  same time horizon — see "expiry_mismatch" in the strategy doc. Same
  `EXPIRY_TOLERANCE_SEC` filter applies.
- Do **not** hard-code Polymarket trading fees as 0% — read them from the
  current API at runtime so we don't get caught by a fee change.
- Do **not** post trade logs / activity to any external service (Slack, X,
  etc.). The user hasn't authorized this.

## Acceptance criteria (v1)

1. **Setup script**: `scripts/setup-poly-wallet.ts` derives the proxy wallet,
   creates L2 creds, persists both to `data/poly-operator.json`. Refuses to
   run if the env vars aren't set.
2. **Force-trade script**: `scripts/force-poly-trade.ts` — analogous to
   `force-mint.ts`. Buys 1 share of a chosen Polymarket Yes token at market.
   Refuses if `--shares > 1` without `--i-know-what-im-doing`.
3. **Bot wiring**: when `POLY_EXECUTION_ENABLED=true`, signals that pass
   threshold + filters submit both legs. Polymarket leg first; Predict only
   if Polymarket fills within 30s. Both recorded in the same trade row.
4. **Risk gates**: separate Polymarket caps enforced; new
   `risk_blocked: poly_*` reasons surface in the dashboard.
5. **Dashboard**: positions table shows both legs (Polymarket fill price,
   shares, status) for live trades. No new pages required.
6. **Local Docker stack still works**: `docker compose up` boots, both
   services healthy, signal stream captures.
7. **Tests pass**: existing 36 tests stay green; add at least 5 new tests
   for Polymarket order construction and the 2-leg sizing math.

## Files to read first (in order)

1. `README.md` — project overview.
2. `docs/strategy-spec.md` — what we're trading and why.
3. `packages/svx-bot/src/index.ts` — main loop, where the live execution
   path lives. Pay attention to the section that calls `buildMintTx` /
   `submitTx` — that's the integration point for Polymarket execution.
4. `packages/svx-bot/src/signal/spread.ts` — the `TradeDecision` shape
   already encodes which side of Polymarket to trade.
5. `packages/svx-bot/src/exec/risk.ts` — risk gate pattern to mirror.
6. `packages/svx-bot/scripts/setup-manager.ts` and `force-mint.ts` — model
   the new Polymarket scripts after these.
7. `packages/svx-bot/src/pricing/polymarket.ts` — existing read-only client.
   Refactor to share types with the new write client.

## What to ask the user before implementing

1. **Do they have an EVM wallet they want to use, or should we generate a
   fresh one?** A fresh one is cleaner (no mixing with personal funds) but
   requires them to fund it with MATIC for gas + USDC for trading.
2. **Are they OK with Polymarket's TOS / geo restrictions?** Don't proceed
   if they're in a blocked jurisdiction.
3. **What's their starting Polymarket bankroll?** Suggest $10–$50 USDC for
   bug-flush; size the initial caps to that.
4. **Polygon RPC**: do they have an Alchemy/Infura key, or should we
   default to a public RPC (rate-limited but free)?

## After v1 ships, candidate v2 work

- Cross-venue inventory rebalancing (when one side keeps winning, sweep
  back to the other).
- Hyperliquid delta hedge for the residual binary exposure.
- Multi-asset (ETH, SOL on Predict / Polymarket).
- Auto-resolution waiting + one-tx claim of UMA-resolved Polymarket payouts.

Good luck. Ping the user with the four questions above before writing
production code; everything else you can decide autonomously.
