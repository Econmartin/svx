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
