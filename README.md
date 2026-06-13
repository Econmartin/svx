# SVX

**A fully-automated cross-venue volatility-arbitrage bot for [DeepBook Predict](https://docs.sui.io/onchain-finance/deepbook-predict/).**

SVX prices every BTC binary on Predict's continuous SVI surface, compares to Polymarket's discrete-strike order books, and executes the side that's mispriced. Built for the Sui Overflow 2026 DeepBook Predict track.

Execution is live on Polymarket (Polygon mainnet) and ready to flip on Predict the moment Predict ships on Sui mainnet. The bot detects UMA settlement, auto-redeems winning shares back to pUSD, and tracks realized PnL end-to-end.

## Why this project

The DeepBook Predict problem statement explicitly names cross-venue vol-arb between Predict and Polymarket as *"the single most realistic mainnet-day-one strategy — and it doubles as live stress test of the SVI feeder."* SVX is that bot.

- **Single-operator, no users, no pooled funds.** It trades its own balance. No collective investment scheme, no tokenized shares, no securities-law exposure.
- **Math-grade pricing.** Raw SVI evaluator + Black-Scholes binary pricing + Newton/bisection IV inversion, validated against Python `math.erf`-based reference vectors.
- **Live on mainnet (Polymarket leg).** Trades on the Polygon mainnet Polymarket CLOB through the operator's own wallet, with auto-redeem of winning shares once UMA resolves. Predict leg stays paper until Sui mainnet ships — that's a single config change.
- **Delta-neutral by construction (Hyperliquid hedge).** Every Polymarket fill opens a delta-sized BTC perp hedge on Hyperliquid. The hedge closes on the same poll loop that detects settlement. Three venues, one bot, pure-vol PnL.

## Why two networks?

The dashboard shows a **testnet** bot and a **mainnet** bot side-by-side. They're not redundant — each demonstrates a piece the other can't.

- **Testnet bot.** DeepBook Predict has no Sui mainnet deployment yet — testnet is the only place the protocol exists today. The testnet bot mints, settles, and redeems via real Move calls with faucet dUSDC. It's the on-chain proof that the entire Predict integration works end-to-end (the spec's minimum requirement: *"Work end-to-end if you are building a product, we will test the entire flow."*).
- **Mainnet bot.** Uses testnet Predict as the **pricing brain** — reads the SVI surface live — while executing trades on **Polymarket (Polygon mainnet)** and hedging on **Hyperliquid (mainnet)**. The PnL on this bot is real money. The day Predict ships on Sui mainnet, `MAINNET_PAPER_TRADING=false` flips the Sui-mint leg from paper to live; no code change.

This is what "mainnet-day-one" concretely means: the cross-venue spread logic, SVI-driven signal generation, order submission, settlement reconciliation, and delta-hedge are all running against real liquidity today.

## Limitations & honest tradeoffs

A few things we knowingly cut or accepted as structural constraints — better to say them out loud than paper over:

- **Vol-arb on perps isn't classical vol-arb.** True vol-arb captures vol mispricing via gamma (options). Perps are linear, so the standalone Hyperliquid vol-arb strategy is more accurately "directional perp triggered by IV-RV divergence." The Polymarket leg DOES capture vol edge (binaries have curvature); the standalone HL strategy needs directional conviction.
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
   │  pricing/{svi,bs,predict,polymarket}                       │
   │  signal/{match,spread,filter}                              │
   │  exec/{sizer,risk,ptb,keypair}                             │
   │  ledger/{store}     ops/{kill}     api/{server}            │
   └────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │           SVX DASHBOARD (Next.js, read-only)               │
   │   Overview · Signals · Positions · Surface · About         │
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
pnpm svx resume             # clear the kill flag
pnpm svx status             # current bot state from the local ledger
pnpm svx report             # PnL summary

pnpm tsx scripts/backtest.ts --threshold 0.04 --out data/backtest.csv
```

Manual kill switch is a filesystem flag (`/tmp/svx-paused`); the bot checks it every loop iteration. Daily-loss limit, position-count cap, SVI staleness, and consecutive-loss circuit breaker are all enforced in `exec/risk.ts`.

## Repository layout

```
packages/
  svx-bot/           # the trading bot
    src/
      pricing/       # SVI evaluator, BS binary pricing, REST clients
      signal/        # matching, spread computation, data filters
      exec/          # sizer, risk gate, PTB builders, keypair loader
      ledger/        # SQLite store
      ops/           # kill switch
      api/           # read-only HTTP for the dashboard
      cli.ts         # `svx` CLI
      index.ts       # main scheduler loop
    tests/           # math vectors + integration tests
  svx-dashboard/     # Next.js read-only viewer
  svx-shared/        # shared types, constants, addresses
scripts/
  setup-manager.ts   # one-time PredictManager creation (gated on dUSDC)
  backtest.ts        # historical replay
docs/
  strategy-spec.md
  math-validation.md
  risk-controls.md
  operations-runbook.md
  mainnet-runbook.md
  demo-script.md
```

## Track-required notes

- **Predict integration.** Composes with `predict::create_manager`, `predict::mint`, `predict::redeem`, `predict::redeem_permissionless` on the testnet `predict-testnet-4-16` deployment. Package + object IDs pinned in [packages/svx-shared/src/addresses.ts](packages/svx-shared/src/addresses.ts).
- **Polymarket integration.** Live on Polygon mainnet — submits Yes/No outcome buys via the [Polymarket CLOB v2 SDK](https://github.com/Polymarket/clob-client), polls gamma for UMA resolution, redeems winning shares via the NegRiskAdapter / ConditionalTokens contracts. Wallet operations are documented in [docs/mainnet-runbook.md](docs/mainnet-runbook.md).
- **Submission category.** Bot/keeper. Not a vault, not a consumer app, not a tokenized share product.
- **Mainnet-day-one claim.** Polymarket leg is mainnet today. The Sui leg flips with a single config change documented in [docs/mainnet-runbook.md](docs/mainnet-runbook.md) once Predict ships on Sui mainnet.

## License

Apache-2.0.
