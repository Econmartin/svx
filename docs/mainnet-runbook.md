# SVX mainnet runbook

Two sections:

1. **Live Polymarket bot** (current state) — top-up, kill-switch, log triage,
   and recovery procedures for the bot that's already running on Polygon
   mainnet via the `bot-mainnet` Coolify service.
2. **Predict on Sui mainnet** (future) — what to flip when DeepBook Predict
   ships on Sui mainnet and the second leg becomes available.

---

## Part 1 — Live Polymarket bot (running today)

The `bot-mainnet` service is live on Polygon mainnet. It buys Yes/No outcome
shares on Polymarket strike markets (`Bitcoin above $X on <date>?`) whenever
the spread vs. Predict's surface exceeds threshold. UMA resolves markets a
few hours after expiry; the settlement-poll loop then auto-redeems winning
shares back to pUSD.

Operator wallet (Polygon mainnet): `0x55ef692226443D341Da27A145d8f350b877F54D4`.

### Quick reference

| Action | Command / location |
|---|---|
| Pause new orders | Coolify → `bot-mainnet` env → `MAINNET_POLY_EXECUTION_ENABLED=false` → save → restart |
| Resume orders | Set the same back to `true` → save |
| Hard pause (everything) | `MAINNET_PAPER_TRADING=true` (already true today; Predict leg paused by default) |
| Wallet balance | `/mainnet` dashboard, or `pnpm --filter svx-bot verify-poly-wallet` (pUSD) / `verify-hl-wallet` (HL USDC) |
| Open positions | `/mainnet` dashboard "Open Polymarket positions" table |
| Closed positions + PnL | `/mainnet` dashboard "Closed Polymarket positions" table |
| Bot logs | Coolify → `bot-mainnet` → Logs tab; filter on `svx.poly.` |
| Polygonscan | `https://polygonscan.com/address/0x55ef692226443D341Da27A145d8f350b877F54D4` |

### 1.1 Top up pUSD (collateral)

Polymarket trades use pUSD as collateral. Refill when the dashboard shows
`pUSD < $5` or when fill failures spike.

```text
Kraken → withdraw USDC on Polygon network (NOT mainnet, NOT Arbitrum)
       → arrives as USDC.e at the operator wallet
       → wrap to pUSD via the Collateral Onramp (one tx)
```

From the repo worktree:

```bash
# 1. Dry-run first to verify balances + planned tx without sending
pnpm --filter svx-bot wrap-usdce-to-pusd -- --amount=10
# 2. Submit
pnpm --filter svx-bot wrap-usdce-to-pusd -- --amount=10 --confirm
# 3. Verify
pnpm --filter svx-bot verify-poly-wallet
```

The bot picks up the new balance within `POLY_BALANCE_REFRESH_MS` (60s).

### 1.2 Top up POL (gas)

Polygon gas is paid in POL (formerly MATIC). Kraken withdraws POL on Polygon
directly — no wrap step.

Threshold: keep ≥ 0.5 POL (covers ~30 trades + redeems at current gas prices).
At our trade volume `0.5 POL ≈ $1` lasts weeks.

Steps:
1. Kraken → buy POL → withdraw on Polygon → operator wallet.
2. No script needed; the bot reads `getGasBalance` every loop.

### 1.3 Kill switch

The bot has two pause mechanisms, layered:

| Mechanism | Effect | How to flip |
|---|---|---|
| Per-leg flag | Stops Polymarket order submission only | Coolify env `MAINNET_POLY_EXECUTION_ENABLED=false` |
| Paper mode | Stops both Predict & Poly order submission | `MAINNET_PAPER_TRADING=true` (default today) |
| Daily-loss auto-pause | Bot self-pauses for 24h after limit breach | Operator: `pnpm --filter svx-bot resume` (after investigating) |
| Manual filesystem flag | Hard pause from inside the container | `touch /tmp/svx-paused` inside `bot-mainnet` |

**Open positions are unaffected by any of these.** They settle on UMA's
schedule and auto-redeem regardless of the kill-switch state. Only NEW
orders are blocked.

### 1.4 Reading the bot logs

All log lines are single-line JSON. Key prefixes to grep:

| Prefix | What it means |
|---|---|
| `svx.poly.exec_enabled` | Bot started with Polymarket execution on |
| `svx.poly.read_only` | Wallet loaded but execution flag off (paper mode for Poly) |
| `svx.poly.submit` | About to send a market-buy order |
| `svx.poly.filled` | Order filled — `orderId`, `shares`, `price`, `costUsdc` |
| `svx.poly.fill_failed` | Order rejected/empty fill; usually book depth too thin |
| `svx.poly.thin_book` | Skipped pre-submit because best ask had < `polyMinBookDepthShares` |
| `svx.poly.risk_blocked` | Risk gate said no — `reason` field tells you which gate |
| `svx.poly.balance_refresh_failed` | Polygon RPC blip — usually transient |
| `svx.poly.settled` | Settlement-poll loop matched a UMA resolution; PnL recorded |
| `svx.poly.redeem.success` | CTF redeem tx confirmed; pUSD credited |
| `svx.poly.redeem.failed` | Redeem tx reverted — see "Stuck redeem" below |

A healthy loop iteration emits one `svx.loop.start`, ≤ ~5 `svx.poly.submit`
(rarely), and a `svx.signal.live_executed` per fired trade.

### 1.4.5 Polymarket Deposit Wallet (POLY_1271) setup — one-time

**Context (May 2026 Polymarket rollout):** New polymarket.com signups get a
"Deposit Wallet" — a smart-contract wallet that verifies signatures via
EIP-1271. The CLOB only accepts orders signed against the Deposit Wallet
address, not the EOA. Direct EOA orders get rejected with:

```
"error": "maker address not allowed, please use the deposit wallet flow"
```

If you see `svx.poly.maker_not_allowed` in the logs, the bot auto-paused
itself for this reason. Fix:

#### Step 1 — Deploy the Deposit Wallet via polymarket.com

Open https://polymarket.com → **Log in** → connect the operator EOA
(Brave Wallet / Rabby / MetaMask with the operator key imported). On
first login the UI deploys a smart-contract Deposit Wallet for you.
Find its address:

- Profile page → "Wallet" tab usually shows it
- Or inspect page HTML: it appears under `proxyAddress` / `proxyWallet` /
  `baseAddress` (all the same value)
- Polymarket misleadingly labels this as "Builder address — API use only,
  do not send funds". That label is wrong for our purposes — this IS the
  trading proxy and we DO send funds there.

Note: place one tiny manual trade via the UI (e.g. $5 on any market) to
ensure the wallet is fully active.

#### Step 2 — Move pUSD from EOA → Deposit Wallet

```bash
cd /Users/martinswdev/Repos/SVX/.claude/worktrees/sad-haslett-1430f3
pnpm --filter svx-bot send-pusd-to-proxy -- --to=0x<dw> --amount=10
pnpm --filter svx-bot send-pusd-to-proxy -- --to=0x<dw> --amount=10 --confirm
```

#### Step 3 — Re-derive the L2 API key against the Deposit Wallet

This is the step that catches everyone. The standard `setup-poly-wallet`
script (and the SDK's `createOrDeriveApiKey()`) bind the API key to the
EOA — but for POLY_1271 the API key MUST be bound to the Deposit Wallet
address. The TS SDK has a known bug
(https://github.com/Polymarket/clob-client-v2/issues/67) so we work
around it with a dedicated script:

```bash
# Update local .env first:
#   POLY_PRIVATE_KEY=0x<eoa>
#   POLY_FUNDER_ADDRESS=0x<dw>
#   POLY_NETWORK=polygon
pnpm --filter svx-bot derive-poly-api-key-1271
```

This signs the L1 auth payload via the EOA + sends the DW address as the
`POLY_ADDRESS` header, so the CLOB binds the resulting API key to the
Deposit Wallet. Output prints `apiKey`/`secret`/`passphrase` and persists
to `data/poly-operator.polygon.json`.

#### Step 4 — Update Coolify env (bot-mainnet service)

```
MAINNET_POLY_SIGNATURE_TYPE=POLY_1271
MAINNET_POLY_FUNDER_ADDRESS=0x<dw_address>
MAINNET_POLY_API_KEY=<new from step 3>
MAINNET_POLY_API_SECRET=<new from step 3>
MAINNET_POLY_API_PASSPHRASE=<new from step 3>
```

Save → service restarts. Expected log lines on boot:
```
svx.poly_client.constructed  funder: 0x<dw>  signatureType: POLY_1271
```

#### Step 5 — Resume

```bash
pnpm --filter svx-bot resume   # clears the auto-pause
```

Next signal should fire cleanly. Watch for `svx.poly.filled` (not
`maker_not_allowed`).

#### What about POLY_GNOSIS_SAFE?

Pre-May-2026 accounts created via the old polymarket.com flow have a
Gnosis Safe proxy. Those still work with `POLY_SIGNATURE_TYPE=POLY_GNOSIS_SAFE`
and the standard `setup-poly-wallet` flow. The bot supports both — pick
based on when you created the account.

### 1.5 What to do when

#### 3+ `fill_failed` in a row

Most common cause: book depth thinned out faster than the loop cadence. Check
the Polymarket market page for the strikes we're trading and confirm there
are still active Yes/No quotes near our entry price.

Mitigations, in order:
1. Wait 5 min. Books often replenish.
2. Raise `MAINNET_POLY_MIN_BOOK_DEPTH_SHARES` in Coolify (default 20). At 50
   we only fire on liquid strikes; cuts trade frequency materially.
3. If persistent: pause via the kill switch and investigate the specific
   markets in the dashboard's signals feed.

#### pUSD balance hits zero

The bot will keep trying market-buys; each will fail with a CLOB error and
log `svx.poly.fill_failed`. No positions are lost; nothing is destabilized.

Two options:
1. Top up (procedure 1.1 above). Bot resumes within 60s.
2. Kill-switch off (1.3) until you can top up.

#### Daily loss limit triggered

`risk.checkPoly()` auto-pauses the ledger when 24h realized pUSD PnL ≤
`-MAINNET_DAILY_POLY_LOSS_LIMIT_USDC` (default $10). The dashboard's status
badge will show `paused: true` with the reason.

Investigate:
1. Open the dashboard's "Closed Polymarket positions" table. Sort by PnL ascending.
2. Cross-reference the worst losers with the `signals` feed at the time of
   execution — was the edge real but small? Was the book thin?
3. If you find a bug or operator error: fix, then `pnpm --filter svx-bot resume`.
4. If just a bad streak: wait 24h for the rolling window to clear, then
   resume.

#### Stuck unredeemed winning trade

Symptom: row in "Closed Polymarket positions" shows `won=Y` and
`Redeem=failed`.

Diagnosis: the CTF redeemPositions call reverted. Common causes:
- We tried the NegRiskAdapter path on a non-NegRisk market (or vice versa).
- The market is technically resolved on gamma but UMA dispute window is open.

Recovery (manual):
```bash
# Inspect the trade row to get the conditionId + shares
sqlite3 ./data/svx.sqlite \
  "SELECT id, poly_condition_id, poly_filled_shares, poly_outcome,
          poly_settlement_outcome, poly_payout_usdc
   FROM trades WHERE poly_redeem_status = 'failed';"

# Open the conditionId on https://polymarket.com to verify resolution state.
# Once UMA has fully resolved, call redeemPositions manually via polygonscan:
#   1. Go to https://polygonscan.com/address/0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296 (NegRiskAdapter)
#   2. Write Contract → redeemPositions(bytes32 conditionId, uint256[] amounts)
#   3. Connect the operator wallet; submit.
# Then clear the failed marker so the row reflects reality:
sqlite3 ./data/svx.sqlite \
  "UPDATE trades SET poly_redeem_status = 'success',
                     poly_redeem_tx_hash = '<tx hash>'
   WHERE id = '<trade id>';"
```

### 1.6 Hyperliquid delta hedge (Part 2)

The HL leg sits *inside* the same `bot-mainnet` service — no separate
container, no separate cron. When `MAINNET_HL_EXECUTION_ENABLED=true` and a
Polymarket fill lands, the bot:

1. Computes the binary delta (∂N(d2)/∂S) at the snapshot's spot/strike/IV.
2. Sizes a BTC perp hedge: `hedgeBtc = |Δ| × filledShares`.
3. Picks the side: `polyOutcome === 'yes'` → SHORT BTC, `'no'` → LONG BTC.
4. Submits an IOC limit ±2% from mid (HL has no native market order).
5. Persists the leg onto the same trade row as `hl_*` columns.

On settlement, the same poll loop that detects UMA resolution closes the HL
position with a reduce-only IOC and records the realized PnL.

#### 1.6.1 One-time funding (operator does this)

| Step | What | Notes |
|---|---|---|
| 1 | Generate an HL keypair | `pnpm --filter svx-bot generate-hl-wallet` — prints the address + privkey ONCE |
| 2 | Add `MAINNET_HL_PRIVATE_KEY=0x...` to Coolify | Don't commit. Never log. |
| 3 | Buy ~$20 USDC on Kraken | More if you plan to scale up trade sizes |
| 4 | Withdraw to Arbitrum (NOT Polygon) | Use the operator's HL address |
| 5 | Open https://app.hyperliquid.xyz Portfolio → Deposit | Use the in-app bridge widget |
| 6 | Bridge USDC into HL | One-time, takes ~30s |
| 7 | Sign once on https://app.hyperliquid.xyz | Activates the master account |
| 8 | `pnpm --filter svx-bot setup-hl-account` | Verifies the account, persists `data/hl-operator.json` |
| 9 | `pnpm --filter svx-bot force-hl-trade -- --size=0.0001 --side=short --confirm --round-trip` | Round-trip test (~$8 BTC notional) |
| 10 | Set `MAINNET_HL_EXECUTION_ENABLED=true` in Coolify | Bot starts hedging on the next Polymarket fill |

#### 1.6.2 HL operations

| Action | Command |
|---|---|
| Pause hedging only | `MAINNET_HL_EXECUTION_ENABLED=false` (Polymarket still fires) |
| Check balance | `pnpm --filter svx-bot verify-hl-wallet` |
| Manual trade | `pnpm --filter svx-bot force-hl-trade -- --dry-run` (defaults to safe) |
| Strict mode | `MAINNET_HL_REQUIRED_FOR_POLY=true` — refuses naked Poly when HL is unreachable |

#### 1.6.3 Failure modes

| Symptom | Response |
|---|---|
| `svx.hl.open_failed` after Poly fill | Naked Poly position stays open. Log shows error. Manual unwind if needed. |
| `svx.hl.risk_blocked` | Hedge skipped (per-trade cap / exposure cap / daily-loss). Poly trade still ran (unless `HL_REQUIRED_FOR_POLY=true`). |
| `svx.hl.close_failed` on settlement | Open HL hedge remains. Retry next poll (5min) or close via `force-hl-trade`. |
| Daily HL loss limit | Bot auto-pauses everything until `pnpm --filter svx-bot resume` after investigation. |

### 1.7 Settlement cadence

The bot polls gamma every 5 minutes for resolution. UMA resolves markets
2–8 hours after expiry typically. Don't expect instant settlement — a trade
opened at 18:00 UTC for a 20:00 UTC market won't show as settled before
roughly 22:00 UTC at the earliest.

If a trade has been "open" for >24h after its expiry, that's worth
investigating. Open the conditionId on https://polymarket.com — if it shows
"Disputed" or "Pending UMA" the bot is doing the right thing; just wait.

---

## Part 2 — Predict on Sui mainnet (future)

This section is the original mainnet-runbook content, unchanged. It applies
when DeepBook Predict ships on Sui mainnet and the bot's Predict leg can
flip from paper to live. None of it is active today.

### Pre-flight

- [ ] DeepBook Predict mainnet has launched. Confirm by checking
      [docs.sui.io](https://docs.sui.io/onchain-finance/deepbook-predict/) for the
      mainnet package ID.
- [ ] Operator hardware wallet (Ledger or equivalent) generated and address
      funded with mainnet SUI for gas + USDC for trading.
- [ ] All risk controls tested at least once on testnet (see
      [risk-controls.md](risk-controls.md) "Tested" section).
- [ ] Backtest report from `scripts/backtest.ts` shows positive PnL on
      out-of-sample data.
- [ ] Alerting wired (Telegram or Discord webhook in `.env`).
- [ ] Operator on call for the first 24h after enabling live trading.

### Address swap

Update `packages/svx-shared/src/addresses.ts`:

```ts
const PREDICT_PACKAGE_ID_MAINNET = '0x...';   // from docs.sui.io
const PREDICT_OBJECT_ID_MAINNET  = '0x...';
const PREDICT_REGISTRY_ID_MAINNET = '0x...';
const USDC_TYPE_MAINNET = '0x...::usdc::USDC'; // mainnet USDC, NOT dUSDC
```

Update `.env`:

```bash
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
PREDICT_PACKAGE_ID=...           # mainnet
PREDICT_OBJECT_ID=...
DUSDC_TYPE=...                    # mainnet USDC
PAPER_TRADING=true                # KEEP TRUE for first iteration
```

Run a paper-mode iteration:

```bash
pnpm svx start --once
```

Verify the log shows `addressesPinned: true` and at least one `svx.loop.matches`
entry.

### Manager creation

```bash
pnpm tsx scripts/setup-manager.ts
```

This calls `predict::create_manager` and persists the new manager ID to
`./data/operator.json`. **Save this file in version-controlled secrets** —
losing it doesn't lose your money (the manager is tied to your address) but
losing it does break the bot's resumption.

### Capital ramp

Start small. Recommended schedule:

| Day  | Cost cap (USDC) | Daily loss limit (USDC) | Comment                   |
|------|-----------------|--------------------------|---------------------------|
| 1–3  | 50              | 200                       | Verify execution end-to-end |
| 4–7  | 200             | 500                       | If win-rate > 55% and PnL ≥ 0 |
| 8+   | target          | target                    | Scale gradually           |

Adjust `MAX_POSITION_DUSDC` and `DAILY_LOSS_LIMIT_DUSDC` in `.env` between
phases. Restart the bot to pick up changes.

### Going live

```bash
PAPER_TRADING=false pnpm svx start
```

Monitor:

- Telegram alerts for any `risk_blocked` or `tx_failed` events.
- Dashboard NAV trend and signal count.
- The first ~5 trades by hand. Confirm the on-chain effects match the local
  ledger via `https://suiscan.xyz/mainnet/object/<managerId>`.

### Failure modes specific to Sui mainnet

| Failure                          | Detection                              | Recovery                                                    |
|----------------------------------|----------------------------------------|-------------------------------------------------------------|
| RPC node lag / 5xx               | `predict.latestSvi` retries exhausted  | Bot pauses on staleness; rotate to backup RPC URL          |
| Fee spike (gas > 0.5 SUI)        | tx submission failure                  | Bot retries once with 50% more gas, then alerts            |
| MEV / sandwich                   | filled price worse than expected ask    | None at protocol level (trade size is small); cap helps     |
| Predict admin pause              | `trading_paused = true`                 | Bot will see `ETradingPaused` on submit; logs + alerts      |
| Polymarket gamma API change      | `gamma /events` schema mismatch        | Bot logs parse failures; manual fix in `pricing/polymarket.ts` |
| Operator key compromised         | unexplained tx in manager history      | `pnpm svx pause`; rotate keypair; audit recent trades       |

### Rollback

To stop trading immediately:

```bash
pnpm svx pause
```

To withdraw funds from the PredictManager back to the operator wallet:

```bash
# manual sui-cli call (no helper script — withdrawal is rare and high-stakes)
sui client call \
  --package $PREDICT_PACKAGE_ID \
  --module predict_manager \
  --function withdraw \
  --type-args $USDC_TYPE \
  --args $MANAGER_ID $AMOUNT_RAW
```

Any open binary positions stay open until they settle naturally — do NOT
attempt to cancel positions through code paths that don't exist on the
protocol.

### Audit trail

Everything the bot did is in two places:

1. `./data/svx.sqlite` — every signal, trade, settlement, NAV snapshot.
2. On-chain — every mint/redeem event under `${PREDICT_PACKAGE_ID}::predict::*`.

For a full reconciliation: query the on-chain event stream filtered by
manager_id and compare to the local `trades` table. Any mismatch is a bug.
