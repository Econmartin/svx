---
title: Polymarket settlement, PnL, runbook + doc refresh
status: open
prerequisites:
  - PR #2 merged (Polymarket execution leg)
  - PR #3 merged (dashboard visibility + decoupled poly client)
  - Single-dashboard PR merged (collapses dashboard-mainnet)
---

# Task — Polymarket settlement, PnL tracking, operator runbook + doc refresh

You are picking up this task in a fresh worker session. Treat this doc as the
complete brief — read it end to end before writing code. Then read the files
linked at the bottom.

## TL;DR

The Polymarket execution leg shipped in PR #2 / #3 / single-dashboard. The bot
is **live on Polygon mainnet** with `MAX_POLY_POSITION_USDC=2`, ~$5 of pUSD in
the wallet, and `POLY_EXECUTION_ENABLED=true`. Trades are firing.

What's MISSING is the back end of the trade lifecycle:

1. **Settlement detection** — when a Polymarket market resolves via UMA
   (hours after expiry), we don't notice. Trade rows stay `settled=0` forever
   on the Poly side.
2. **Realized pUSD PnL** — without settlement, we can't compute what we made
   or lost. The `dailyPolyLossLimitUsdc` config has nothing to gate against.
3. **Auto-redeem** — Predict has an auto-redeem loop (commit `6ffeb64`). The
   Poly side has nothing equivalent — winnings sit unclaimed in the CTF
   exchange contract until manually swept.
4. **Operator runbook** — when pUSD runs dry, the bot just gets repeated
   fill failures with no alert. No documented top-up procedure.
5. **Stale docs** — `strategy-spec.md`, `demo-script.md`, `README.md` still
   call SVX a "1-leg directional bet" / list Polymarket execution as a v2
   stretch goal. It's neither anymore.

This task closes the Polymarket trade loop and updates the docs to match
reality.

## Context for the worker

- Repo: `/Users/martinswdev/Repos/SVX` (also at github.com/Econmartin/svx).
- Bot is deployed on Coolify as two services: `bot` (testnet Predict) and
  `bot-mainnet` (mainnet Polymarket). Single dashboard at the same URL serves
  both views (`/` and `/mainnet`).
- Operator wallet: `0x55ef692226443D341Da27A145d8f350b877F54D4` on Polygon
  mainnet. Funded from Kraken (USDC.e → wrapped to pUSD via the Collateral
  Onramp at `0x93070a847efEf7F70739046A929D47a521F5B8ee`).
- Live caps right now: `MAX_POLY_POSITION_USDC=2`, `MAX_OPEN_POLY_POSITIONS=5`,
  `DAILY_POLY_LOSS_LIMIT_USDC=10` (configured but inert until this task).
- The user is in a Polymarket-restricted jurisdiction; only the operator's
  *browser* needs Ireland-VPN. The Coolify outbound IP is German/Finnish (no
  VPN required for the bot).
- `addresses.ts` says Predict is testnet-only — when it goes mainnet (timeline
  unknown), the mainnet bot can flip to PAPER_TRADING=false and the existing
  Polymarket-first execution path becomes the true 2-leg arb. Don't refactor
  for that case yet; just don't paint into a corner.

## What's already in place (don't redo)

- `packages/svx-bot/src/exec/polymarket-client.ts`: ClobClient wrapper with
  `marketBuy`, `marketSell`, `getCollateralBalance`, `getGasBalance`,
  `getOrderBook`, `bootstrapApiKey`. Plus `loadPolyCreds()` and
  `tryCreatePolymarketExecClient()` factory.
- `packages/svx-bot/src/exec/polymarket-keypair.ts`: viem walletClient + chain
  endpoint derivation (amoy/polygon). `derivePolyEndpoints()` → `{ network,
  chainId, clobHost, rpcUrl }`.
- `packages/svx-bot/src/index.ts` main loop: when an executed signal lands and
  `polyExec` is loaded + `cfg.polyExecutionEnabled` is true, submits the Poly
  leg first; on success, records `polyOrderId`, `polyFilledShares`,
  `polyFillPrice`, `polyCostUsdc`, `polyTxHash`, `polyStatus='filled'` on the
  trade row.
- `packages/svx-bot/src/ledger/store.ts`: trade table has
  `poly_{network,token_id,condition_id,side,outcome,order_id,filled_shares,
  fill_price,cost_usdc,tx_hash,status}` columns + backwards-compat ALTER TABLE
  migrations. `countOpenPolyPositions()` and `openPolyExposureUsdc()` helpers.
- `packages/svx-bot/src/exec/risk.ts`: `checkPoly()` enforces per-trade pUSD
  cap + max concurrent positions.
- Scripts: `generate-poly-wallet`, `setup-poly-wallet`, `verify-poly-wallet`,
  `wrap-usdce-to-pusd` (with `--dry-run` / `--confirm`), `force-poly-trade`.
- Dashboard: `/mainnet` page polls `bot-mainnet` API (`apiMainnet`), shows
  pUSD/POL balance, wallet address with polygonscan link, open poly positions,
  signals feed.
- Tests: `tests/polymarket-exec.test.ts` covers `parsePolyFillResponse`,
  `checkPoly`, and the 2-leg side-selection logic.

## What to build

### Part 1 — Settlement + auto-redeem (the critical path)

#### 1a. Detect settlement

Polymarket markets resolve via UMA's optimistic oracle. Once resolved, the CTF
(Conditional Token Framework) contract knows the winning outcome and you can
redeem winning shares for pUSD 1:1.

Add a periodic settlement-poll loop in the bot — analogous to how the Predict
side reconciles `OracleSettled` events.

Approach:
- Pull all open Poly trades from the ledger (`settled=0 AND poly_status='filled'`).
- Group by `polyConditionId`.
- For each unique conditionId, query the CTF contract OR the Polymarket gamma
  API to check resolution status. Gamma is simpler:
    `GET https://gamma-api.polymarket.com/markets/{conditionId}` →
    `{closed: true, ...}` once UMA has resolved.
  The market object also exposes the winning outcome via `outcomes` /
  `outcomePrices` (one becomes `1.0`, the other `0.0`).
- For each settled market, compute payout per trade:
    payout = filledShares * (outcomeWon ? 1.0 : 0.0)  // 1 pUSD per winning share
    pnl    = payout - polyCostUsdc
- Write back: `settled=1`, `payout_usdc`, `pnl_usdc`, `settled_at_ms`,
  `settlement_price` (the underlying spot at expiry — pull from the Predict
  oracle for the same expiry, or from gamma's resolved-price field).

Cadence: every 5 minutes is plenty (UMA resolution takes hours).

#### 1b. Auto-redeem winnings

Winning shares aren't automatically converted to pUSD on resolution — you have
to call the CTF exchange contract to redeem them. (Mirror of the Predict
auto-redeem loop in `index.ts`.)

The Polymarket V2 CTF exchange address (Polygon mainnet) is in
`getContractConfig(137)` from the SDK — `exchange` + `exchangeV2` fields.
Verify which one is the right call target by reading recent successful redeem
transactions on polygonscan; copy the function selector + ABI from there.

Add a small `redeemPolyWinnings()` helper in `polymarket-client.ts` that:
- Takes a list of `{conditionId, outcome, shares}` tuples.
- Constructs + sends a single `redeemPositions` tx via viem `walletClient`.
- Returns the tx hash.

In the main loop:
- After settlement detection, find rows where `settled=1`, `payout_usdc>0`,
  `poly_tx_hash IS NOT NULL`, and a new `poly_redeem_tx_hash IS NULL` column.
- Submit redeem tx, mark with `poly_redeem_tx_hash`.

#### 1c. Daily Poly loss limit (now meaningful)

`risk.ts` `checkPoly()` currently has a comment saying daily PnL gate is
deferred. Wire it up now that we can compute realized pUSD PnL:

```ts
// In risk.ts checkPoly()
const polyPnl24h = this.ledger.realizedPolyPnlSince(Date.now() - 24*3600_000);
if (polyPnl24h <= -this.cfg.dailyPolyLossLimitUsdc) {
  this.pause(`daily poly loss limit hit: ${polyPnl24h.toFixed(2)} pUSD`);
  return { ok: false, reason: ... };
}
```

Add `LedgerStore.realizedPolyPnlSince(sinceMs)` mirroring the existing dUSDC
version. Sums `pnl_usdc` (now overloaded — see schema note below) over rows
with `poly_status='filled' AND settled=1 AND ts_ms >= ?`.

**Schema note:** the current `pnl_usdc` column was originally for Predict
PnL. With Polymarket positions arriving, we have ambiguity. Two options:
- (a) Add separate `poly_pnl_usdc` + `poly_payout_usdc` columns (cleaner,
      additive migration).
- (b) Treat `pnl_usdc` as "PnL for this trade row" — Predict-only when no
      poly leg, Poly-only when paper-mode bot with poly leg, sum of both
      when fully hedged. Simpler now, harder to disentangle later.

Recommend (a). Add the columns + ALTER TABLE migrations same as before.

### Part 2 — Dashboard updates

On `/mainnet`:
- Add a **Realized pUSD PnL (24h / all-time)** stat to the StatRow.
- Add a **Closed Polymarket positions** section below the open positions table:
  one row per settled trade with payout, PnL, redeem tx link.
- (Nice-to-have) Cumulative pUSD PnL chart, mirroring the Sui-side one on `/`.

On `/positions` (testnet view): unchanged.

### Part 3 — Operator runbook

Update `docs/mainnet-runbook.md` (or create it if it doesn't exist for the
mainnet bot specifically) with:

1. **How to top up pUSD** — step by step:
   a. Buy USDC on Kraken (any amount).
   b. Withdraw on Polygon network as USDC.e.
   c. From the worktree repo: `pnpm --filter svx-bot wrap-usdce-to-pusd --
      --amount=<N>` to dry-run, then add `--confirm` to submit.
   d. Verify with `pnpm --filter svx-bot verify-poly-wallet`.
2. **How to top up POL gas** — Kraken withdraws POL on Polygon directly. ~$1
   refills last weeks at our trade volume.
3. **How to flip the kill switch** — set `MAINNET_POLY_EXECUTION_ENABLED=false`
   in Coolify, save, container restarts in ~10s. Open positions are
   unaffected; only NEW orders are blocked. To pause Predict too, also set
   `MAINNET_PAPER_TRADING=true` (already true today).
4. **How to read the bot logs** — key log lines: `svx.poly.exec_enabled`,
   `svx.poly.submit`, `svx.poly.filled`, `svx.poly.fill_failed`,
   `svx.poly.thin_book`, `svx.poly.risk_blocked`, `svx.poly.balance_refresh_failed`.
5. **What to do when**:
   - 3+ `fill_failed` in a row → check Polymarket book depth on the strikes
     we're trading; check that pUSD balance > 0; consider raising
     `POLY_MIN_BOOK_DEPTH_SHARES` filter.
   - pUSD balance hits zero → bot will keep trying + failing; either top up
     (procedure above) or flip kill switch.
   - Daily loss limit triggered → bot auto-pauses; investigate via dashboard
     calibration page (when it ships, `analytics-page.md` brief), then
     manually un-pause via `pnpm --filter svx-bot resume`.
   - Stuck unredeemed winning trade → check the redeem tx hash on
     polygonscan; if reverted, manually call CTF redeem with the same args.

### Part 4 — Doc refresh

Update these to reflect that Polymarket execution is **live**, not a
stretch goal:

- `README.md`: change "1-leg directional bet" framing to "cross-venue
  hedged execution (Polymarket leg live on mainnet; Predict leg still
  paper pending Sui mainnet deployment of Predict)."
- `docs/strategy-spec.md`: update the "1-legged" caveat (currently in the
  TL;DR-ish header). Add a new section "Polymarket execution path" that
  describes the wallet + funding + outcome selection logic.
- `docs/demo-script.md`: rewrite the "What's next" stretch-goals list.
  Polymarket exec is no longer there; only Predict-mainnet + multi-asset +
  Hyperliquid hedge remain. Add a scene showing the `/mainnet` dashboard
  with a real fill.
- `docs/operations-runbook.md`: cross-link to the new mainnet-runbook.

## Architecture notes

- Settlement poll lives in the same loop iteration as oracle reads — adds
  one Promise.all-able batch of gamma fetches every 5 min. No new service.
- Auto-redeem is a separate Polygon tx per resolved market; batch by
  conditionId so we redeem all positions on a market in one tx.
- The CTF redeem requires owning the position tokens (ERC1155-style on the
  CTF contract). Our trades buy outcome tokens directly via the V2
  exchange, so we already hold them — no extra approval needed.

## What NOT to do

- Do **not** modify the existing Predict auto-redeem loop. Mirror its
  pattern but build a separate Poly version.
- Do **not** add a separate poll-only service — keep everything in the bot
  main loop.
- Do **not** persist the Polymarket API gamma response wholesale; just the
  fields we need.
- Do **not** post any of this to social/external channels (consistent with
  the original brief's no-Slack/X rule).

## Acceptance criteria

1. **Settlement detection**: trades resolve within 5 min of UMA marking the
   market closed. `settled=1`, `payout_usdc`, `pnl_usdc`, `settled_at_ms`,
   `settlement_price` populated.
2. **Auto-redeem**: winning trades have `poly_redeem_tx_hash` populated
   within ~10 min of detection. Tx visible on polygonscan, pUSD balance in
   the wallet increases by the payout amount.
3. **Daily Poly loss limit**: `risk.checkPoly()` blocks new orders when
   24h-rolling realized pUSD PnL ≤ -`dailyPolyLossLimitUsdc`. Bot
   auto-pauses (ledger pause state).
4. **Dashboard `/mainnet`**: shows realized pUSD PnL stat + closed Poly
   positions table.
5. **Runbook**: `docs/mainnet-runbook.md` covers top-up, kill switch, log
   triage, common failures.
6. **Docs**: README + strategy-spec + demo-script no longer call SVX a
   "1-leg directional bet" or list Polymarket exec as a stretch goal.
7. **Tests**: 5+ new for settlement detection, payout math, daily-limit
   gate. Existing 48 stay green.
8. **Local stack still boots**: `docker compose up` clean.

## Files to read first (in order)

1. `docs/tasks/polymarket-execution.md` — the brief that built v1 (now
   mostly done — read for context).
2. `packages/svx-bot/src/index.ts` — see the auto-redeem block for Predict
   (search `unredeemedWinningTrades`); mirror that pattern for Poly.
3. `packages/svx-bot/src/ledger/store.ts` — `unredeemedWinningTrades`,
   `markRedeemed`, `realizedPnlSince` — patterns to replicate.
4. `packages/svx-bot/src/exec/polymarket-client.ts` — extend with
   `redeemPolyWinnings`.
5. `packages/svx-bot/src/exec/risk.ts` — extend `checkPoly` with the
   daily-PnL gate.
6. `packages/svx-bot/src/pricing/polymarket.ts` — gamma client (read-only,
   already has `listBtcStrikeMarkets`); add a `getMarketResolution(condId)`
   helper.
7. `packages/svx-dashboard/app/mainnet/page.tsx` — extend the StatRow +
   add a closed-positions table.
8. `docs/mainnet-runbook.md` — current runbook, predates the mainnet bot
   (or doesn't exist yet — create it).

## What to ask the user before starting

1. **CTF redeem function selector** — verify on polygonscan with a recent
   successful redeem tx so we don't trust the SDK's defaults blindly. Worth
   confirming with the user that we're targeting the V2 exchange not V1.
2. **Daily loss limit value** — currently `DAILY_POLY_LOSS_LIMIT_USDC=10`.
   At `MAX_POLY_POSITION_USDC=2`, that's 5 fully-losing trades before pause.
   Reasonable, but confirm.
3. **Settlement poll cadence** — 5 min is the proposal. UMA resolution
   takes hours; faster polling adds gamma API load with no benefit. Confirm.

## Future work (out of scope here)

- Cross-venue inventory rebalancing (when one side keeps winning).
- Hyperliquid delta hedge for residual binary exposure.
- Multi-asset (ETH, SOL).
- True 2-leg execution mode for when Predict ships on Sui mainnet —
  the existing `if (action === 'live_executed' && live)` block already
  handles the Predict leg; just need a sanity test that both fire on the
  same signal once both networks are live.
- Telegram/email alerting for kill-switch events + daily-limit triggers
  (the brief explicitly forbids posting to chat platforms without user
  authorization, so this needs a yes from the user first).

Good luck.
