# SVX — agent handoff summary

Snapshot for a fresh agent to pick up the work. Repo: `Econmartin/svx`,
working branch `claude/sad-haslett-1430f3`. Demo target ~3 weeks out.

## What SVX is

A multi-strategy automated trading bot for the Sui Overflow 2026 DeepBook
Predict track. Three strategies running in parallel, single TypeScript
monorepo, dashboard at `/`.

| Strategy | Status | Where it trades | Sized |
|---|---|---|---|
| **poly-arb** (cross-venue Predict↔Polymarket + HL hedge) | LIVE, capital-bound | Polymarket (Polygon) + Hyperliquid | $2/trade poly, ≤$2/trade HL hedge |
| **vol-arb** (Predict IV vs HL realized vol, directional perp) | LIVE, signal-quiet | Hyperliquid only | $11/trade (HL min) |
| **predict-testnet** (Predict-only on Sui testnet) | LIVE | Sui testnet via PredictManager | $15/trade dUSDC |

## Architecture

```
packages/
  svx-bot/          TypeScript bot, single process
    src/
      pricing/      SVI evaluator, BS binary, polymarket gamma+CLOB, binary-delta
      signal/       match, spread (cross-expiry reprice), filter
      strategy/     vol-arb signal + sizing
      exec/         polymarket-client, hyperliquid-client, risk gate, sui keypair
      ledger/       SQLite, additive schema migrations
      api/          read-only HTTP for dashboard
      index.ts      main scheduler (15s loop)
    scripts/        wallet setup, force trades, validate signals, derive API keys
    tests/          vitest, 130 tests passing
  svx-dashboard/    Next.js 14, shadcn-style primitives (built inline)
    app/
      page.tsx              Overview (network-aware)
      signals/page.tsx      Calibration scatter + filters
      positions/page.tsx    Open/Closed tabs, PnL histogram
      wallets/page.tsx      Truth-from-chain per wallet + drift detector
      vol-arb/page.tsx      Vol-arb strategy view (IV vs RV chart, decisions)
      surface/page.tsx      SVI smile + math expansion
      about/page.tsx        Architecture story
    components/
      ui/                   Card, Button, Badge, Tabs, Table, ToggleGroup (inline)
      HealthPanel, PnlChart, StatRow, NetworkToggle, StatusBadge
    lib/
      api.ts                Two clients (testnet + mainnet)
      network-context.tsx   Persisted toggle, useApiClient hook
  svx-shared/       Types, addresses, constants
```

Deployed via Coolify as 3 services: `bot` (testnet), `bot-mainnet`, `dashboard`.
Single dashboard polls both bots via `NEXT_PUBLIC_SVX_API` + `NEXT_PUBLIC_SVX_API_MAINNET`.

## Operator wallets

| Chain | Address | Holds | Source |
|---|---|---|---|
| Sui testnet | derived from `SUI_PRIVATE_KEY_BECH32` | dUSDC + PredictManager dUSDC | `data/operator.json` |
| Polygon (signer EOA) | `0x55ef692226443D341Da27A145d8f350b877F54D4` | POL gas only | `POLY_PRIVATE_KEY` env |
| Polygon (Polymarket Safe / Deposit Wallet, funder) | `0xF5769eBC11bf8a8A9Ff32f4B6eC35EED744CFe2e` | pUSD + outcome shares | deployed by polymarket.com UI, signs via EIP-1271 |
| Hyperliquid | `0xB109608675da45c972d16D6c161a66AeFC96dfE5` | ~$18 USDC margin | bridged from Arbitrum via app.hyperliquid.xyz/bridge |

EOA + DW are SAME key, different addresses. EOA signs, DW is funder. POLY_GNOSIS_SAFE
mode does NOT work for new accounts — must be POLY_1271.

## Open issues (triage order)

### P0 — Testnet expiry filter still rejecting 100% of signals

**Symptom:** `/signals` on testnet shows 100% filter_reason=expiry_mismatch.

**Cause:** Coolify either (a) didn't redeploy the `bot` service after commit
`9400a20` (docker-compose default bump), or (b) has an explicit
`EXPIRY_TOLERANCE_SEC` env var still set to `3600`.

**Fix:**
1. Coolify → `bot` service → check env panel for `EXPIRY_TOLERANCE_SEC`.
   Delete it or set to `1209600`.
2. Redeploy the `bot` service.
3. Verify `svx.boot` log line shows `"expiryToleranceSec":1209600`.

### P1 — Polymarket capital-bound

**Symptom:** Bot executes Polymarket signals correctly, but only has 2 open
positions and ~$1 pUSD left in the Safe. Settlements take 24-48h.

**Fix (when more activity wanted):**
```bash
# 1. Withdraw USDC.e from Kraken to the EOA address
# 2. Wrap to pUSD via Polymarket onramp:
pnpm --filter svx-bot wrap-usdce-to-pusd -- --amount=20 --confirm
# 3. Move pUSD from EOA → Safe:
pnpm --filter svx-bot send-pusd-to-proxy -- \
  --to=0xF5769eBC11bf8a8A9Ff32f4B6eC35EED744CFe2e \
  --amount=20 --confirm
# Bot picks up the new balance within 60s.
```

### P2 — HL vol-arb hasn't traded for 2 days

**Likely cause:** market is flat, IV-RV spread inside threshold or P(↑) ≈ 50%.

**Diagnostic:** open `/vol-arb` dashboard, check recent decisions feed. If all
"hold" with `spread_below_open_thresh` or `bias_below_thresh`, signal genuinely
isn't firing.

**Fix if desired (loosens gates significantly):**
```
MAINNET_VOL_ARB_OPEN_THRESHOLD=0.02      # was 0.05
MAINNET_VOL_ARB_DIRECTION_BIAS=0.005     # was 0.03 (or 0.01)
```

## Configuration reference

All env vars `MAINNET_*` prefixed for the mainnet bot. Defaults in `docker-compose.yml`.

| Env var | Default | What |
|---|---|---|
| `MAINNET_POLY_SIGNATURE_TYPE` | EOA | **must be `POLY_1271`** for current Poly account |
| `MAINNET_POLY_FUNDER_ADDRESS` | (empty) | **must be `0xF5769eBC11bf8a8A9Ff32f4B6eC35EED744CFe2e`** |
| `MAINNET_POLY_EXECUTION_ENABLED` | false | true to fire orders |
| `MAINNET_MAX_POLY_POSITION_USDC` | 2 | per-trade pUSD cap |
| `MAINNET_HL_EXECUTION_ENABLED` | false | true to fire perps |
| `MAINNET_MAX_HL_PER_TRADE_USDC` | 2 | per-trade USD-notional cap |
| `MAINNET_VOL_ARB_ENABLED` | false | true to fire vol-arb perps |
| `MAINNET_MAX_VOL_ARB_PER_TRADE_USDC` | 11 | must be ≥10 (HL minimum) |
| `MAINNET_MAX_VOL_ARB_OPEN_USDC` | 22 | total open vol-arb exposure cap |
| `MAINNET_DAILY_VOL_ARB_LOSS_LIMIT_USDC` | 10 | auto-pause threshold |
| `MAINNET_VOL_ARB_TIME_STOP_MINUTES` | 60 | max position hold time |
| `MAINNET_EXPIRY_TOLERANCE_SEC` | 1209600 | 14d, sanity cap on cross-expiry reprice |

## Recent learnings / gotchas

1. **Polymarket Deposit Wallet rollout (May 4 2026)** — all new polymarket.com
   accounts get EIP-1271 smart-contract wallets, NOT Gnosis Safes. Must use
   `POLY_1271` signature mode in the SDK.

2. **JS SDK 1.0.6 has a partial bug** — `createApiKey()` doesn't pass the
   `address` arg to `createL1Headers`, so API keys always bind to the EOA.
   BUT this doesn't matter: once the DW proxy is deployed on-chain (one
   manual trade via the UI does it), the CLOB accepts orders regardless of
   which address the API key is bound to. Workaround script
   `derive-poly-api-key-1271.ts` was built but turns out not needed.

3. **HL price rules** — orders rejected as "tick size" violation if our price
   doesn't satisfy BOTH (a) `≤(6 - szDecimals)` decimals AND (b) `≤5` sig
   figs. For BTC at $78k, rule (b) forces integer prices. Fixed by
   `formatPriceForHl` in `hyperliquid-client.ts`.

4. **HL fill-status parser** — initially compared HL's reported `totalSz`
   against the RAW requested size, but HL rounds via `szDecimals` before
   matching. Now passes the formatted size + has 1bp tolerance. Tested in
   `tests/hl-hedge.test.ts`.

5. **Cross-expiry reprice math** — Predict's SVI surface has one expiry per
   oracle; Polymarket has different expiries (daily/weekly). We extract IV
   from Predict's `w(k) / T_oracle`, then reprice the binary at the Poly
   expiry via `w_poly = σ² * T_poly`. Flat-vol-across-expiries assumption.
   Verified via `validate-signals` script: median IV drift = 0 across
   108k+ signals.

## Demo readiness

What works for the demo right now:
- ✅ Live testnet Predict trading (real mint/redeem, dUSDC PnL chart, ledger settlements)
- ✅ Live mainnet Polymarket fills (POLY_1271, Deposit Wallet, real on-chain trades)
- ✅ Live Hyperliquid vol-arb (when signal fires; ~20 closed trades to date)
- ✅ Dashboard with 6 routes, all polished
- ✅ Math validated against 108k signals (`validate-signals` reports "PERFECT")
- ✅ 130 unit tests
- ✅ Auto-pause + risk discipline visible in logs

Open polish:
- Testnet expiry filter fix (above)
- More Polymarket capital for more visible activity
- Possibly looser vol-arb gates to seed more demo trades

## Key files for a new agent to read first

1. `packages/svx-bot/src/index.ts` — main loop, strategy orchestration
2. `packages/svx-bot/src/strategy/vol-arb.ts` — vol-arb signal + sizing
3. `packages/svx-bot/src/exec/polymarket-client.ts` — order signing + redeem
4. `packages/svx-bot/src/exec/hyperliquid-client.ts` — HL order format + parse
5. `packages/svx-bot/src/exec/risk.ts` — all risk gates
6. `packages/svx-bot/src/signal/spread.ts` — cross-expiry reprice math
7. `packages/svx-dashboard/app/wallets/page.tsx` — truth-from-chain view
8. `docs/mainnet-runbook.md` — operator playbook
9. `docs/strategy-spec.md` — strategy definitions + math
10. `docker-compose.yml` — deployment env mappings

## Useful commands

```bash
# Run tests
pnpm --filter svx-bot test

# Typecheck
pnpm --filter svx-bot build

# Build dashboard
pnpm --filter svx-dashboard build

# Validate signal math against ledger
pnpm --filter svx-bot validate-signals

# Verify wallets
pnpm --filter svx-bot verify-poly-wallet
pnpm --filter svx-bot verify-hl-wallet

# Local force-trade for smoke testing
pnpm --filter svx-bot force-poly-trade -- --token-id=... --amount=5 --confirm
pnpm --filter svx-bot force-hl-trade -- --size=0.0001 --side=short --confirm --round-trip
```

## Git state

- Working branch: `claude/sad-haslett-1430f3`
- PR: open at https://github.com/Econmartin/svx (~30 commits, mostly squash-able)
- Last meaningful commits (newest first):
  - `9400a20` docker-compose EXPIRY_TOLERANCE_SEC bump 1h → 14d
  - `8f83510` HL parser tolerance fix (false "partial" results)
  - `cee1366` HL price formatter (5 sig figs + szDecimals)
  - `e60ed4d` Polymarket Deposit Wallet (POLY_1271) support
  - `2d9df2e` Poly fill response: BUY uses takingAmount=shares
  - earlier: vol-arb strategy, /wallets page, dashboard redesign, cross-expiry reprice

The branch is ready to merge — all green tests + clean builds. Just hasn't
been merged because we keep iterating on the live system.
