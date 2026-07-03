# SVX

**A fully-automated cross-venue trading bot for [DeepBook Predict](https://docs.sui.io/onchain-finance/deepbook-predict/).**

SVX runs two live strategies on one risk stack. **Poly-arb** prices every BTC binary on Predict's continuous SVI surface, compares to Polymarket's discrete-strike order books, and buys the side that's mispriced (entry requires an 8pp probability spread AND ≥5% model edge over the ask actually paid). **Expiry-convergence** buys the deep-in-the-money side of BTC dailies in their final 5–90 minutes at 90–97¢ when live realized vol says the strike is out of reach. Built for the Sui Overflow 2026 DeepBook Predict track.

Execution is live on Polymarket (Polygon mainnet) and ready to flip on Predict the moment Predict ships on Sui mainnet. The bot detects UMA settlement, auto-redeems winning shares back to pUSD (with retry + backoff), tracks realized PnL end-to-end, and continuously **reconciles the wallet against the ledger** — unexplained drift pauses trading.

## Live deployments

| Surface | URL | Hosting |
|---|---|---|
| Dashboard (primary) | <https://svx.econmartin.xyz> | Netlify (Let's Encrypt TLS) |
| Dashboard (on-chain) | <https://econmartin.wal.app> | [Walrus Sites](https://docs.wal.app) on Sui mainnet, resolved via the `econmartin` [SuiNS](https://suins.io) name |
| Bot API — testnet | `https://svx-testnet.econmartin.xyz` | Self-hosted on Coolify (read-only JSON) |
| Bot API — mainnet | `https://svx-mainnet.econmartin.xyz` | Self-hosted on Coolify (read-only JSON) |

The two dashboards serve identical code from the same git commit; the Walrus deploy stores the static bundle as a Sui object (id: `0x0a3fb7e6abe7a3287cc042186ac3f24638296400dad0e01bbab2cb2775b67565`) and is reachable via the Sui-native `wal.app` portal. Use whichever you prefer — both fetch live data from the same bot APIs.

## Why this project

The DeepBook Predict problem statement explicitly names cross-venue vol-arb between Predict and Polymarket as *"the single most realistic mainnet-day-one strategy — and it doubles as live stress test of the SVI feeder."* SVX is that bot.

- **Single-operator, no users, no pooled funds.** It trades its own balance. No collective investment scheme, no tokenized shares, no securities-law exposure.
- **Math-grade pricing.** Raw SVI evaluator + Black-Scholes binary pricing + Newton/bisection IV inversion, validated against Python `math.erf`-based reference vectors.
- **Live on mainnet (Polymarket leg).** Trades on the Polygon mainnet Polymarket CLOB through the operator's own wallet, with auto-redeem of winning shares once UMA resolves. Predict leg stays paper until Sui mainnet ships — that's a single config change.
- **Honest risk shape (naked binaries, hard clips).** Positions are small naked binaries bounded by per-trade clips ($4), a 10-position cap, per-strategy stop-losses, and settlement-keyed daily loss limits. The earlier Hyperliquid delta hedge was disabled by the 2026-07 audit (sized at the wrong expiry, then capped into irrelevance — see Limitations); Hyperliquid remains connected as the live realized-vol feed and for legacy-leg cleanup.
- **Ledger that can't quietly lie.** After the 2026-07 settlement incident, a wallet-vs-ledger reconciliation invariant runs every cycle: if the pUSD balance drifts from the ledger-implied expectation by more than a threshold, the bot pauses and says so. Deposits/withdrawals are acknowledged via `svx rebaseline`.

## Why two networks?

The dashboard shows a **testnet** bot and a **mainnet** bot side-by-side. They're not redundant — each demonstrates a piece the other can't.

- **Testnet bot.** DeepBook Predict has no Sui mainnet deployment yet — testnet is the only place the protocol exists today. The testnet bot mints, settles, and redeems via real Move calls with faucet dUSDC. It's the on-chain proof that the entire Predict integration works end-to-end (the spec's minimum requirement: *"Work end-to-end if you are building a product, we will test the entire flow."*).
- **Mainnet bot.** Uses testnet Predict as the **pricing brain** — reads the SVI surface live — while executing trades on **Polymarket (Polygon mainnet)** and hedging on **Hyperliquid (mainnet)**. The PnL on this bot is real money. The day Predict ships on Sui mainnet, `MAINNET_PAPER_TRADING=false` flips the Sui-mint leg from paper to live; no code change.

This is what "mainnet-day-one" concretely means: the cross-venue spread logic, SVI-driven signal generation, order submission, and settlement reconciliation are all running against real liquidity today.

## The strategy portfolio (post-2026-07 audit)

A four-agent audit on 2026-07-03 reviewed every strategy before the mainnet relaunch. The portfolio decision: keep what has a defensible mechanism, cut what provably doesn't.

| Strategy | Status | Verdict |
|---|---|---|
| **Poly-arb** (Predict SVI vs Polymarket book) | **LIVE** | Entry math verified correct; hedge removed (see Limitations); gates raised to 8pp spread + 5% EV-after-cost after two weeks of healed data showed 3% divergences carried no edge. |
| **Expiry-convergence** (deep-ITM dailies, final hour) | **LIVE** | The "late-certainty discount": holders dump near-certain positions early to recycle capital; nobody pins the book near resolution. Guards: strict question parser + strike sanity band, volume floor, 15-min RV warm-up, 2× fat-tail sigma multiplier (4σ gate demands 8 trailing sigmas), crowd-disagreement standdown, −15% stop, $4 clips. |
| **Vol-arb** (Predict IV vs HL realized vol, perps) | **CUT** | A perp has no vega — an IV−RV spread cannot be harvested with a delta-one instrument. Reconciled to the cent against HL records: $29.12 fees, −$1.80 direction PnL over 5,219 fills. Hard-disabled in code (env ignored); its 2s ticker survives as the RV sampler feeding convergence. |
| **Margin-Lever** (Sui three-protocol composition, paper) | **OFF** | The audit found its signal — N(d2) bias from the SVI surface — decomposes to a forward-basis z-score that diverges on noise as the shortest oracle nears expiry. Stays disabled (`MARGIN_LEVER_ENABLED=false`) until the signal is redesigned; the code and `/margin-lever` page remain for transparency. |

## Limitations & honest tradeoffs

A few things we knowingly cut or accepted as structural constraints — better to say them out loud than paper over:

- **Poly positions are naked binaries; the delta hedge is off.** The 2026-07 audit found the hedge sized delta at the 15-minute Predict oracle's expiry instead of the Polymarket market's (~5× oversize via 1/√T) — and a *correctly* sized at-the-money hedge for a $4 clip is hundreds of dollars of notional, which the per-trade HL cap rightly blocks. Rather than claim "delta-neutral by construction" while shipping something else, the hedge open path is disabled (`hlHedgeEnabled=false` in tunables) and the risk is bounded by clip size, position caps, stops, and daily limits instead. Re-enabling requires poly-expiry sizing and caps that fit the real notional.
- **Vol-arb was cut — a perp cannot harvest an IV−RV spread.** True vol-arb captures vol mispricing via gamma (options). Perps are linear. Audit reconciliation against HL's records: $29.12 in fees for −$1.80 of direction PnL over 5,219 fills. Hard-disabled in code; the `/vol-arb` page documents the post-mortem and keeps rendering the IV/RV telemetry that now feeds the convergence sigma gate.
- **Convergence trades correlated tail risk on purpose.** Every convergence clip is a variant of "BTC doesn't move X% this hour" — one violent move near the daily expiry cluster can stop out several clips at once. That's why clips are $4, the sigma gate uses a 2× fat-tail multiplier on trailing RV, and the strategy stands down whenever the crowd prices real doubt (ask < 90¢). Trailing RV cannot see scheduled events (CPI/FOMC); the multiplier is margin, not clairvoyance.
- **Predict positions can't exit before settlement.** Protocol exposes `mint` and `redeem_permissionless` only — no `burn`, no secondary market. We compensate by adding mid-life exit on the Polymarket leg (sells back when mark P&L crosses +20% of cost). The Predict side still rides to expiry — protocol property, not bot bug.
- **Cross-expiry reprice assumes flat-vol.** Predict expiries are sub-hour; Polymarket is daily/weekly. We treat Predict's IV as expiry-invariant and reprice the binary at the Polymarket expiry. Exact under the assumption, approximate with a sloped term structure. Adding a real term-structure model is future work.
- **POLY_1271 Deposit-Wallet setup is manual.** New Polymarket accounts require a smart-contract Deposit Wallet. The bot supports the POLY_1271 signature mode, but deploying the DW + re-deriving the L2 API key against it is a one-time manual step at polymarket.com. Documented in the runbook; not automatable today.
- **No Move package shipped.** Deliberate — every line of Move ships an audit surface. SVX composes with `predict::*` and `predict_manager::*` via Sui RPC only. Trade-off: we can't ship tokenized vault shares or pool-with-others primitives. For a hackathon bot that's the right call; for a full vault product it'd be a future iteration with proper audit.
- **Edge decays as more bots run this.** Cross-venue convergence trades have finite edge by construction — every additional bot tightens the spread. Building this strategy now is about being one of the first feeders calibrating Predict's surface against external venues, not about long-term cash-printing.

## Architecture

```
            ┌──────────────────────────────────────────────────────┐
            │                    SVX OPERATOR                      │
            │              (single Sui keypair)                    │
            └───────┬──────────────────────────────────┬───────────┘
                    │ owns                             │
                    ▼                                  │
       ┌────────────────────┐                          │
       │   PredictManager   │                          │
       │   (Sui object)     │                          │
       └────────────────────┘                          │
                                                       │
            ┌──────────────────────────────────────────┴───────────┐
            │                                                       │
   ┌────────▼────────┐  ┌────────────────┐  ┌────────────────────┐
   │  Predict server │  │   Polymarket   │  │      Sui RPC       │
   │  (REST + events │  │  gamma + clob  │  │  (read & submit)   │
   │   indexer)      │  │     APIs       │  │                    │
   └────────┬────────┘  └────────┬───────┘  └─────────┬──────────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 │
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │                   SVX BOT (TypeScript)                     │
   │  pricing/{svi,svi-arb,bs,predict,polymarket}               │
   │  signal/{match,spread,filter}                              │
   │  exec/{sizer,risk,ptb,keypair,                             │
   │        polymarket-client,hyperliquid-client,               │
   │        deepbook-margin-client,iron-bank-client}            │
   │  strategy/{convergence,vol-arb,margin-lever}               │
   │  ledger/{store}     ops/{kill}     api/{server}            │
   └────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │           SVX DASHBOARD (Next.js, read-only)               │
   │  Overview · Signals · Positions · Poly-arb · IV-RV         │
   │       · Margin-lever · Wallets · Surface · About           │
   └────────────────────────────────────────────────────────────┘
```

There is **no Move package** in this repo. SVX composes with Predict's existing on-chain code via Sui RPC; it does not deploy its own contracts. That's a deliberate scope choice — every line of Move you ship is a line that needs auditing before mainnet.

## Quickstart

```bash
# 0. Prereqs: Node 18+, pnpm, Sui CLI on testnet, dedicated keypair
sui client switch --address <your-svx-operator-address>
sui client envs       # ensure testnet is active

# 1. Install
pnpm install

# 2. Run the bot in paper mode (no on-chain tx)
pnpm svx start
#  -> writes signals + paper trades to ./data/svx.sqlite
#  -> serves the API on http://127.0.0.1:4321

# 3. Run the dashboard (separate terminal)
pnpm --filter svx-dashboard dev
#  -> http://localhost:3030

# 4. Tests
pnpm test

# 5. (Once dUSDC is funded) one-time setup
pnpm tsx scripts/setup-manager.ts
#  -> creates the operator's PredictManager, persists ID to data/operator.json

# 6. Switch to live trading
PAPER_TRADING=false pnpm svx start
```

## Run your own (full mainnet bot)

Walk-through for a fresh operator who's cloned the repo and wants to stand up the mainnet bot — paper Predict (testnet SVI as the pricing brain), live Polymarket on Polygon, live Hyperliquid perp hedge.

### 1. Generate the three operator wallets

```bash
# Sui (testnet — Predict has no mainnet deployment yet)
pnpm --filter svx-bot setup-manager
#  -> prints + persists the operator address + PredictManager ID to data/operator.json

# Polymarket (Polygon EOA)
pnpm --filter svx-bot generate-poly-wallet
#  -> prints the EOA address + private key ONCE. Copy the privkey into POLY_PRIVATE_KEY.

# Hyperliquid (Arbitrum-side EOA)
pnpm --filter svx-bot generate-hl-wallet
#  -> prints the EOA address + private key ONCE. Copy into HL_PRIVATE_KEY.
```

### 2. Polymarket Deposit Wallet (POLY_1271) — one-time

Polymarket's May 2026 rollout requires a smart-contract Deposit Wallet that verifies signatures via EIP-1271. EOA-direct orders are rejected with `maker address not allowed`.

```bash
# 1. Log in to polymarket.com with the EOA from step 1.
#    Make ONE tiny manual trade (e.g. $5) to deploy the Deposit Wallet.
# 2. Find the DW address on your Profile → Wallet page (or in the page HTML
#    as proxyAddress). Set it as POLY_FUNDER_ADDRESS in env.
# 3. Re-derive the L2 API key against the DW:
pnpm --filter svx-bot derive-poly-api-key-1271
#  -> prints + persists apiKey / secret / passphrase. Copy into
#     POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE.
```

Full details: [docs/mainnet-runbook.md](docs/mainnet-runbook.md) §1.4.5.

### 3. Fund each wallet

| Leg | Token | Network | Destination | Get it via |
|---|---|---|---|---|
| Sui (testnet) | dUSDC | Sui testnet | Operator address | Mysten faucet form (linked in the spec) |
| Polymarket | pUSD | Polygon | **Funder / Deposit Wallet** | Kraken USDC → Polygon → wrap → send to funder |
| Polymarket gas | POL | Polygon | Funder | Kraken POL → Polygon |
| Hyperliquid | USDC | Arbitrum → HL | HL operator | Kraken USDC → Arbitrum → bridge in HL Portfolio |

Polymarket pUSD path (one tx each):

```bash
# Kraken's "USDC on Polygon" arrives as USDC.e at the EOA (or as native USDC —
# verify on polygonscan; swap to USDC.e on Quickswap if needed).
pnpm --filter svx-bot wrap-usdce-to-pusd -- --amount=50 --confirm
pnpm --filter svx-bot send-pusd-to-proxy -- --to=<funder-addr> --amount=50 --confirm
pnpm --filter svx-bot verify-poly-wallet
```

Hyperliquid bridge: log in at app.hyperliquid.xyz with the HL EOA, Portfolio → Deposit. Then:

```bash
pnpm --filter svx-bot verify-hl-wallet
#  -> should show accountValueUsdc > 0 within ~30s of the bridge tx
```

### 4. Set Coolify env vars (or local `.env`)

Two services: `bot` (testnet) and `bot-mainnet`. Mainnet-prefixed envs map to the standard names inside the mainnet container.

```bash
# bot (testnet)
SUI_PRIVATE_KEY_BECH32=<bech32 from setup-manager>
OPERATOR_JSON=<contents of data/operator.json>
PAPER_TRADING=false                  # flip when ready to mint on testnet
SVX_INSTANCE_LABEL=testnet

# bot-mainnet
MAINNET_SUI_PRIVATE_KEY_BECH32=<same as above>
MAINNET_OPERATOR_JSON=<same as above>
MAINNET_PAPER_TRADING=true           # paper Predict (testnet SVI as pricing only)
MAINNET_POLY_EXECUTION_ENABLED=true
MAINNET_POLY_PRIVATE_KEY=<from generate-poly-wallet>
MAINNET_POLY_FUNDER_ADDRESS=<DW address>
MAINNET_POLY_SIGNATURE_TYPE=POLY_1271
MAINNET_POLY_API_KEY=<from derive-poly-api-key-1271>
MAINNET_POLY_API_SECRET=<…>
MAINNET_POLY_API_PASSPHRASE=<…>
MAINNET_HL_EXECUTION_ENABLED=true
MAINNET_HL_PRIVATE_KEY=<from generate-hl-wallet>
MAINNET_SVX_INSTANCE_LABEL=mainnet
```

All non-secret strategy knobs — thresholds, caps, intervals — live in [`packages/svx-bot/src/tunables.ts`](packages/svx-bot/src/tunables.ts). Edit the file, redeploy. **No env-var roulette for strategy params.**

### 5. Boot the stack

```bash
docker compose up -d
# bot (4321), bot-mainnet (4321), dashboard (3030)
```

### 6. Round-trip verification (recommended before un-pausing)

```bash
pnpm --filter svx-bot force-mint -- --quantity 0.1 --direction up --i-know-what-im-doing
pnpm --filter svx-bot force-poly-trade -- --usdc 0.5
pnpm --filter svx-bot force-hl-trade -- --size 0.0001 --side short --confirm --round-trip
```

Each is a single-tx flush that proves the wallet, the API auth, and the bot's response parser are all wired correctly. If any of these errors out, fix that path before letting the bot run on its own.

## Operations

```bash
pnpm svx pause              # halt new trades within one loop iteration
pnpm svx resume             # clear ALL pause sources (kill flag + ledger pause + breaker watermark)
pnpm svx rebaseline         # acknowledge a deposit/withdrawal to the reconciliation invariant
pnpm svx status             # current bot state from the local ledger
pnpm svx report             # PnL summary

pnpm tsx scripts/backtest.ts --threshold 0.04 --out data/backtest.csv
```

Manual kill switch is a filesystem flag (`/tmp/svx-paused`); the bot checks it every loop iteration and **no automated path ever removes it** — only `svx resume` does. Redeploys never clear a pause (`autoResumeOnBoot=false` since the 2026-07 audit). Daily-loss limits (keyed on settlement time), position-count caps, SVI staleness, the consecutive-loss circuit breaker (counts real poly PnL), and the wallet-vs-ledger reconciliation invariant are all enforced in `exec/risk.ts` + the main loop.

## Repository layout

```
packages/
  svx-bot/                          # the trading bot
    src/
      pricing/                      # SVI evaluator, arb-free checker,
                                    #   BS binary pricing, REST clients
        svi.ts, svi-arb.ts, bs.ts, predict.ts, polymarket.ts
      signal/                       # matching, spread computation, filters
      exec/                         # sizer, risk gate, PTB builders, keypair,
                                    #   polymarket / hyperliquid / deepbook-margin
                                    #   / iron-bank protocol clients
      strategy/
        convergence.ts              # expiry-convergence: deep-ITM BTC dailies, final hour
        vol-arb.ts                  # CUT 2026-07 (perps have no vega); ticker = RV sampler
        margin-lever.ts             # paper-mode three-protocol margin loop — OFF
                                    #   (Predict signal × deepbook_margin × iron_bank)
      ledger/store.ts               # SQLite, additive migrations
      ops/kill.ts                   # /tmp/svx-paused filesystem kill switch
      api/server.ts                 # read-only HTTP for the dashboard
      tunables.ts                   # all non-secret strategy knobs
      cli.ts                        # `svx` CLI (start, pause, resume, status, report)
      index.ts                      # main scheduler — poly-arb loop + sub-tickers
    tests/                          # 150+ tests: math vectors + integration suites
  svx-dashboard/                    # Next.js 14 read-only viewer (app router)
    app/
      page.tsx, overview/, signals/, positions/, poly-arb/, vol-arb/,
      margin-lever/, wallets/, surface/, about/
    components/                     # PageIntro, OperatorBanner, StatRow,
                                    #   SurfaceArbPanel, SviHistoryChart,
                                    #   EdgeCaptureChart, CalibrationChart, …
    lib/                            # api client, network context, polling hook
    ws-resources.json               # Walrus Sites routing + cache headers
  svx-shared/                       # shared types, constants, pinned addresses
scripts/                            # operator scripts (setup-manager, backtest)
docs/
  strategy-spec.md
  math-validation.md
  risk-controls.md
  operations-runbook.md
  mainnet-runbook.md
  demo-script.md
  deploy-coolify.md
```

## Track-required notes

- **Predict integration.** Composes with `predict::create_manager`, `predict::mint`, `predict::redeem`, `predict::redeem_permissionless`, and `predict_manager::*` on the testnet `predict-testnet-4-16` deployment. Package + object IDs pinned in [packages/svx-shared/src/addresses.ts](packages/svx-shared/src/addresses.ts).
- **Polymarket integration.** Live on Polygon mainnet — submits Yes/No outcome buys via the [Polymarket CLOB v2 SDK](https://github.com/Polymarket/clob-client), polls gamma for UMA resolution, redeems winning shares via the NegRiskAdapter / ConditionalTokens contracts. Wallet operations are documented in [docs/mainnet-runbook.md](docs/mainnet-runbook.md).
- **Hyperliquid integration.** Live on Hyperliquid mainnet via the [HL Node SDK](https://github.com/nktkas/hyperliquid) — a 2s ticker samples the BTC perp mid continuously (the realized-vol feed for the convergence strategy) and the close/cleanup machinery manages any legacy hedge legs. New hedge opens are disabled post-audit (`hlHedgeEnabled=false`); funding + fees tracked in the ledger and surfaced on the dashboard.
- **DeepBook Margin + Iron Bank composition.** The Margin-Lever strategy constructs real PTBs against `deepbook_margin::*` and `iron_bank::*` (Sui mainnet). Currently paper-mode: PTBs are built and ledgered, never signed. Flipping to live is a tunables change + USDsui collateral funding step.
- **Submission category.** Bot/keeper. Not a vault, not a consumer app, not a tokenized share product. Single-operator architecture — no users, no pooled funds, no securities-law exposure.
- **Mainnet-day-one claim.** Polymarket + Hyperliquid legs are mainnet today. The Sui Predict leg flips with a single config change documented in [docs/mainnet-runbook.md](docs/mainnet-runbook.md) once Predict ships on Sui mainnet.

## On-chain references

| Resource | Network | Identifier |
|---|---|---|
| Predict package | Sui testnet | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` (`predict-testnet-4-16`) |
| Predict shared object | Sui testnet | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` |
| dUSDC type | Sui testnet | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` |
| Operator's PredictManager | Sui testnet | `0x02a1c838ee9ccca772076b7c5be0a54093c47632cac27fb676bd1db5d5b30f03` |
| Walrus Site object | Sui mainnet | `0x0a3fb7e6abe7a3287cc042186ac3f24638296400dad0e01bbab2cb2775b67565` |
| SuiNS name | Sui mainnet | `econmartin` → resolves to the Walrus Site object above |

The operator's testnet address is pinned in [packages/svx-shared/src/addresses.ts](packages/svx-shared/src/addresses.ts) so anyone can verify mints, redeems, and PredictManager state directly on [Suiscan](https://suiscan.xyz/testnet).

## License

Apache-2.0.
