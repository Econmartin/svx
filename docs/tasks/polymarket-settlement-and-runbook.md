---
title: Polymarket settlement + Hyperliquid delta hedge
status: open
prerequisites:
  - PR #2 merged (Polymarket execution leg)
  - PR #3 merged (dashboard visibility + decoupled poly client)
  - Single-dashboard PR merged (collapses dashboard-mainnet)
---

# Task — Polymarket settlement + Hyperliquid delta hedge

You are picking up this task in a fresh worker session. Treat this doc as the
complete brief — read it end to end before writing code. Then read the files
linked at the bottom.

This is a TWO-PART brief. Part 1 is the prerequisite (must complete first).
Part 2 builds on it. Both are required for hackathon submission.

## TL;DR

The Polymarket execution leg shipped in PR #2 / #3 / single-dashboard. The bot
is **live on Polygon mainnet** with `MAX_POLY_POSITION_USDC=2`, ~$5 of pUSD in
the wallet, and `POLY_EXECUTION_ENABLED=true`. Trades are firing.

**Part 1** — close the trade lifecycle:

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

**Part 2** — Hyperliquid delta hedge:

The hackathon brief explicitly lists Hyperliquid as the **stretch goal** for
Idea Bank #7 (the vol-arb bot we built):
> *"Stretch: delta-hedge the binary on Hyperliquid perps so the bot's PnL
> is pure vol edge."*

Hitting the stretch goal is a strong differentiator for placing well.
Architecturally: SVX is currently *naked-binary* on the Polymarket leg —
real $2 directional exposure to BTC per trade. With ~$2 caps that's
tolerable, but it bottlenecks scaling. Add a Hyperliquid perp hedge sized
to the binary's delta → variance drops ~10× → safe to put 5-10× more
capital to work for the same risk budget. Also lets us truthfully claim
"true cross-venue vol arb across three venues" in the demo.

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

================================================================================
# Part 1 — Polymarket settlement, auto-redeem, runbook + doc refresh
================================================================================

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

================================================================================
# Part 2 — Hyperliquid delta hedge
================================================================================

## Why this matters (read before coding)

The Polymarket execution that PR #2 shipped takes **naked binary positions**.
When the bot buys 5 shares of "BTC > $82k Yes" at $0.30, it has $1.50 of
directional exposure to BTC going up. Today that's bounded at $2 per trade
(the per-trade cap), so it's tolerable. But:

1. **Scaling is risk-bottlenecked.** The user wants to scale by reinvesting
   profits, not by adding new capital. Every doubling of trade size doubles
   directional variance. Without hedging, the daily-loss limit triggers way
   sooner than the alpha would justify.
2. **Hackathon framing.** The brief explicitly calls Hyperliquid hedging the
   stretch goal for Idea #7. Right now SVX is "directional bet informed by
   Predict-Polymarket disagreement." With the hedge it's "true cross-venue
   vol arb with delta-neutral execution." Same code, way bigger story.
3. **PnL stability.** Per-trade variance drops ~10×. The dashboard cumulative
   PnL chart turns from a binary staircase into a smooth-ish line — visually
   obvious value for judges.

The hedge does NOT generate new alpha. It transforms the return profile:

| Setup | Per-trade expected | Per-trade variance | Capital deployable per signal |
|---|---|---|---|
| Naked (today) | ~$0.25 (spread × shares) | ±$1.50 swing on outcome | Small (drawdown risk) |
| Delta-hedged | ~$0.20 (spread minus hedge cost) | ±$0.10 (residual gamma) | 5-10× more |

Per trade you make ~20% less. Per unit of capital × time, you make several
times more, because lower variance unlocks larger position sizing without
ruin risk.

## What to build

### 2.1 Funding setup (one-time, user does)

1. Buy ~$10 USDC on Kraken.
2. Withdraw on Arbitrum One network.
3. Open https://app.hyperliquid.xyz/bridge behind Ireland VPN. Connect a
   freshly-generated EVM wallet (run `generate-hl-wallet` first — see 2.2).
4. Bridge the USDC into Hyperliquid.
5. Sign once on https://app.hyperliquid.xyz to register the master account.
6. Run `pnpm --filter svx-bot setup-hl-account` to derive the L1 API
   credentials (Hyperliquid uses signature-derived API keys, similar to
   Polymarket but no bridge required after the initial bridge).
7. Add `MAINNET_HL_PRIVATE_KEY` + `MAINNET_HL_API_KEY` to Coolify.

### 2.2 Code components

```
packages/svx-bot/src/
  exec/
    hyperliquid-keypair.ts     # mirrors polymarket-keypair.ts
                               #   loadHlOperatorKey(cfg) → { account, walletClient, endpoints }
    hyperliquid-client.ts      # wrap the Hyperliquid TypeScript SDK
                               #   (verify which package is canonical as of build time —
                               #   options include the official @hyperliquid one or
                               #   community @nktkas/hyperliquid). Methods needed:
                               #     getBalance() → USDC on HL
                               #     openMarketPerp({asset, side, size}) → fillResult
                               #     closeMarketPerp({asset, oppositeSide, size})
                               #     getOpenPositions()
                               #     getFundingRate(asset)  // for cost tracking
  pricing/
    binary-delta.ts            # ∂P/∂S where P = N(d2). All primitives already
                               # exist in svi.ts + bs.ts; this is a thin wrapper.
                               # See math note in 2.3.
packages/svx-bot/scripts/
  generate-hl-wallet.ts        # mirror of generate-poly-wallet
  setup-hl-account.ts          # bootstrap API key after bridge funding
  verify-hl-wallet.ts
  force-hl-trade.ts            # bug-flush: open + close a tiny BTC perp
```

### 2.3 The math (binary delta)

For a digital option `P = N(d2)` with `d2 = -((k + w/2) / √w)`:

```
∂P/∂S = ∂N(d2)/∂d2 × ∂d2/∂S
      = φ(d2)     × (-1 / (S × √w))
      = -φ(d2) / (S × √w)
```

where `φ` is the standard normal pdf. The MAGNITUDE is what we want for hedge
sizing; the sign tells us which side of the perp to take:

```
hedgeBtcNotional = |delta| × shares      // BTC notional (not USD)
hedgeUsdNotional = hedgeBtcNotional × spot
hedgeSide        = polyOutcome === 'yes' ? 'short' : 'long'
                   // YES → long BTC delta → short BTC perp to neutralize
```

Implementation: add `binaryDeltaWrtSpot(spot, strike, ivAnnual, ttmYears)` to
`pricing/binary-delta.ts`, returning a number in [0, ~∞) (gamma blows up at
strike for very short expiries — clamp to a reasonable max).

### 2.4 Bot loop integration

After successful Polymarket fill (in the existing block in `index.ts`):

```ts
let hlLeg: { orderId, size, openPrice, side } | undefined;

if (hlExec && polyLeg.fillResult.status === 'filled') {
  const delta = binaryDeltaWrtSpot(
    spot, polySnap.strike, spread.predictIv, ttmYears
  );
  const hedgeBtc = polyLeg.fillResult.filledShares * delta;
  const hedgeSide = polyLeg.outcome === 'yes' ? 'short' : 'long';
  const hedgeUsd = hedgeBtc * spot;

  // Risk gate
  const hlRisk = risk.checkHl({
    notionalUsdc: hedgeUsd,
    openHlExposureUsdc: ledger.openHlExposureUsdc(),
  });
  if (!hlRisk.ok) {
    log.warn('svx.hl.risk_blocked', { reason: hlRisk.reason });
    // Critical decision: do we close the poly leg or accept naked?
    // Default: accept naked, alert via log. Operator can adjust.
    continue;
  }

  try {
    const hlResult = await hlExec.openMarketPerp({
      asset: 'BTC', side: hedgeSide, size: hedgeBtc
    });
    hlLeg = { orderId: hlResult.orderId, size: hedgeBtc,
              openPrice: hlResult.fillPrice, side: hedgeSide };
  } catch (e) {
    log.error('svx.hl.hedge_failed', { err: errMsg(e) });
    bot.pause('HL hedge failed mid-trade; manual unwind needed');
    return; // Skip persisting trade row to surface the issue
  }
}

// Persist on the trade row alongside poly fields
ledger.insertTrade({
  ...,
  hlOrderId: hlLeg?.orderId,
  hlSize: hlLeg?.size,
  hlOpenPrice: hlLeg?.openPrice,
  hlSide: hlLeg?.side,
  hlStatus: hlLeg ? 'open' : (cfg.hlExecutionEnabled ? 'failed' : null),
});
```

On settlement (in the new Part 1 settlement loop):
```ts
if (trade.hlOrderId && trade.hlStatus === 'open') {
  const closeResult = await hlExec.closeMarketPerp({
    asset: 'BTC',
    oppositeSide: trade.hlSide === 'short' ? 'long' : 'short',
    size: trade.hlSize,
  });
  trade.hlClosePrice = closeResult.fillPrice;
  trade.hlClosedAtMs = Date.now();
  trade.hlPnlUsdc =
    (trade.hlSide === 'short' ? trade.hlOpenPrice - closeResult.fillPrice
                              : closeResult.fillPrice - trade.hlOpenPrice)
    * trade.hlSize;
  trade.hlStatus = 'closed';
}
```

Combined PnL = `poly_pnl_usdc + hl_pnl_usdc`. Surface this on the dashboard.

### 2.5 Schema additions (additive migration)

```sql
ALTER TABLE trades ADD COLUMN hl_order_id TEXT;
ALTER TABLE trades ADD COLUMN hl_size REAL;          -- BTC notional
ALTER TABLE trades ADD COLUMN hl_open_price REAL;
ALTER TABLE trades ADD COLUMN hl_close_price REAL;
ALTER TABLE trades ADD COLUMN hl_side TEXT;          -- 'short' | 'long'
ALTER TABLE trades ADD COLUMN hl_status TEXT;        -- 'open' | 'closed' | 'failed'
ALTER TABLE trades ADD COLUMN hl_pnl_usdc REAL;
ALTER TABLE trades ADD COLUMN hl_funding_paid_usdc REAL;
ALTER TABLE trades ADD COLUMN hl_closed_at_ms INTEGER;
```

### 2.6 Risk gates

Add to `config.ts`:
- `hlExecutionEnabled` (default false — kill switch)
- `maxHlOpenUsdc` (default $10 — total HL exposure cap)
- `maxHlPerTradeUsdc` (default $2 — single-trade cap)
- `dailyHlLossLimitUsdc` (default $5 — auto-pause threshold)

Add `RiskGate.checkHl()`:
```ts
checkHl(input: { notionalUsdc: number, openHlExposureUsdc: number }) {
  if (this.isPaused().paused) return { ok: false, reason: 'paused' };
  if (input.notionalUsdc > this.cfg.maxHlPerTradeUsdc + 1e-6) return {...};
  if (input.openHlExposureUsdc + input.notionalUsdc > this.cfg.maxHlOpenUsdc) return {...};
  // Daily HL loss limit (uses Part 1's settlement loop to compute realized HL PnL)
  const hlPnl24h = this.ledger.realizedHlPnlSince(Date.now() - 24*3600_000);
  if (hlPnl24h <= -this.cfg.dailyHlLossLimitUsdc) {
    this.pause(...);
    return {...};
  }
  return { ok: true };
}
```

### 2.7 Funding rate hygiene

Hyperliquid charges hourly funding to perp holders. For our typical holding
period (few hours to ~24h), funding is small but real:

- 5-10% APR is normal for BTC perps
- $2 hedge held 24h at 8% APR = $2 × 0.08 / 365 = $0.0004
- Not material at current scale, but track it as `hl_funding_paid_usdc` on
  the trade row for analytics

Compute on settlement: `hlExec.getFundingPaid(orderId)` or query the HL
account history endpoint.

### 2.8 Dashboard updates (`/mainnet`)

Add to the StatRow (after Part 1's pUSD PnL stat):
- **HL exposure ($)** — current open hedge notional
- **HL PnL (24h / all-time)** — separate from pUSD
- **Combined PnL (24h / all-time)** — `poly_pnl + hl_pnl`

Add a new section "Open Hyperliquid hedges" — per-trade row showing:
- Linked Polymarket position (link via signal id)
- Side (short/long) + size (BTC) + open price
- Current mark price + unrealized PnL
- Funding paid since open

### 2.9 Failure modes worth designing for

| Scenario | Designed response |
|---|---|
| HL exchange down at trade time | Circuit-break: don't open new poly trades when HL is unreachable. Log `svx.hl.unreachable`. Operator can flip a flag to allow naked poly trades anyway. |
| HL fill fails after poly fills | 3 retries with exponential backoff. If all fail: bot.pause + alert. Manual unwind needed. |
| HL position liquidated | Use 1× leverage (no leverage) by default. Liquidation should be functionally impossible at 1×. |
| HL closed but Poly didn't | Should never happen if Part 1 settlement loop is correct, but: keep `hl_status` separate from `poly_status` so we can detect drift. |
| User runs out of HL margin | Risk gate refuses new HL legs; log + alert. Bot continues opening naked poly until operator tops up. |

## Part 2 acceptance criteria

1. **Setup script**: `setup-hl-account.ts` creates the HL API credentials and
   persists to `data/hl-operator.json`. Refuses without `HL_PRIVATE_KEY`.
2. **Force-trade**: `force-hl-trade.ts` opens + closes a $1 BTC perp with
   `--dry-run` default and `--confirm` to submit.
3. **Bot wiring**: when `MAINNET_HL_EXECUTION_ENABLED=true`, every
   successful Polymarket fill triggers a delta-sized HL hedge within 5s.
   Both legs recorded on the same trade row.
4. **Settlement**: HL perp closes within 5min of Polymarket settlement
   (Part 1's loop, extended). `hl_pnl_usdc` populated.
5. **Risk gates**: `MAX_HL_PER_TRADE_USDC`, `MAX_HL_OPEN_USDC`,
   `DAILY_HL_LOSS_LIMIT_USDC` all enforced.
6. **Dashboard**: `/mainnet` shows HL exposure stat, HL PnL stat, combined
   PnL stat, and open HL hedges section.
7. **Variance reduction demonstrable**: after ~10 closed hedged trades,
   per-trade PnL std-dev should be visibly smaller than per-trade PnL of
   the next-best 10 unhedged trades. Document this in the demo script.
8. **5+ new tests** for binary delta math, HL order construction, combined
   PnL computation. Existing 48+5 (from Part 1) stay green.
9. **Local stack still boots**: `docker compose up` clean (no new services
   needed — HL goes inside `bot-mainnet`).

## Part 2 — what NOT to do

- Do **not** add a separate HL bot service. HL execution belongs inside
  `bot-mainnet` so the trade lifecycle stays in one place.
- Do **not** use leverage > 1× by default. Add it as a config knob with
  big warning comments, but default to 1×.
- Do **not** dynamic-rebalance the hedge intra-trade in v1. Static hedge at
  trade open is good enough for sub-day expiries. Dynamic hedging is a
  follow-up task.
- Do **not** ship Part 2 before Part 1 is complete. Without settlement
  detection, you can't measure whether the hedge actually reduced variance,
  and you can't trigger the daily loss limit.
- Do **not** post HL trade alerts to chat platforms without explicit user
  authorization (consistent with the original brief's no-Slack/X rule).

## Part 2 — what to ask the user before starting

1. **Is the HL account already funded?** If not, walk through the bridge
   step (Kraken → Arbitrum → HL). $10 USDC on HL is enough for many hedges
   at current scale.
2. **HL leverage policy** — confirm default 1×. (If they want 2× they can
   bump it explicitly later, but never default to leveraged.)
3. **Kill-switch behavior** — when HL is unreachable, should the bot:
   (a) keep opening naked Polymarket positions (current behavior pre-Part-2)
   (b) refuse all new poly trades (recommended once Part 2 is live)
   (c) configurable via `HL_REQUIRED_FOR_POLY` env var
   Confirm the default before shipping.
4. **HL daily loss limit** — confirm `DAILY_HL_LOSS_LIMIT_USDC=5` is
   reasonable given current bankroll.

================================================================================

## Future work (out of scope here)

- **Multi-asset support** — extend the matching layer (and HL hedge) to
  ETH and SOL once Predict adds those underlyings. Math is unchanged.
- **Dynamic hedge rebalancing** — for longer expiries, delta drift becomes
  meaningful. Add a periodic loop that adjusts open HL positions when delta
  has drifted >X%.
- **Cross-venue inventory rebalancing** — when one side keeps winning, the
  other gets imbalanced. Periodic sweep to rebalance.
- **True 2-leg execution mode** for when Predict ships on Sui mainnet —
  the existing `if (action === 'live_executed' && live)` block already
  handles the Predict leg; needs notional-matching with the Poly leg. With
  the HL hedge in place, mismatched legs no longer cause directional risk.
- **Telegram/email alerting** for kill-switch events + daily-limit triggers
  (the brief explicitly forbids posting to chat platforms without user
  authorization, so this needs a yes from the user first).

Good luck. The user's framing for the demo, post-Part-2:

> "SVX captures pricing disagreements between Predict and Polymarket and
> hedges the residual on Hyperliquid. Three venues, one bot, pure-vol PnL.
> The strategy is delta-neutral by construction — we don't care which way
> BTC moves, we only care whether the spread we observed was real."
