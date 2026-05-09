# SVX mainnet runbook

Step-by-step procedure for flipping SVX from testnet to mainnet. Read all
the way through before executing — there are non-reversible steps.

## Pre-flight

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

## Address swap

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

## Manager creation

```bash
pnpm tsx scripts/setup-manager.ts
```

This calls `predict::create_manager` and persists the new manager ID to
`./data/operator.json`. **Save this file in version-controlled secrets** —
losing it doesn't lose your money (the manager is tied to your address) but
losing it does break the bot's resumption.

## Capital ramp

Start small. Recommended schedule:

| Day  | Cost cap (USDC) | Daily loss limit (USDC) | Comment                   |
|------|-----------------|--------------------------|---------------------------|
| 1–3  | 50              | 200                       | Verify execution end-to-end |
| 4–7  | 200             | 500                       | If win-rate > 55% and PnL ≥ 0 |
| 8+   | target          | target                    | Scale gradually           |

Adjust `MAX_POSITION_DUSDC` and `DAILY_LOSS_LIMIT_DUSDC` in `.env` between
phases. Restart the bot to pick up changes.

## Going live

```bash
PAPER_TRADING=false pnpm svx start
```

Monitor:

- Telegram alerts for any `risk_blocked` or `tx_failed` events.
- Dashboard NAV trend and signal count.
- The first ~5 trades by hand. Confirm the on-chain effects match the local
  ledger via `https://suiscan.xyz/mainnet/object/<managerId>`.

## Failure modes specific to mainnet

| Failure                          | Detection                              | Recovery                                                    |
|----------------------------------|----------------------------------------|-------------------------------------------------------------|
| RPC node lag / 5xx               | `predict.latestSvi` retries exhausted  | Bot pauses on staleness; rotate to backup RPC URL          |
| Fee spike (gas > 0.5 SUI)        | tx submission failure                  | Bot retries once with 50% more gas, then alerts            |
| MEV / sandwich                   | filled price worse than expected ask    | None at protocol level (trade size is small); cap helps     |
| Predict admin pause              | `trading_paused = true`                 | Bot will see `ETradingPaused` on submit; logs + alerts      |
| Polymarket gamma API change      | `gamma /events` schema mismatch        | Bot logs parse failures; manual fix in `pricing/polymarket.ts` |
| Operator key compromised         | unexplained tx in manager history      | `pnpm svx pause`; rotate keypair; audit recent trades       |

## Rollback

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

## Audit trail

Everything the bot did is in two places:

1. `./data/svx.sqlite` — every signal, trade, settlement, NAV snapshot.
2. On-chain — every mint/redeem event under `${PREDICT_PACKAGE_ID}::predict::*`.

For a full reconciliation: query the on-chain event stream filtered by
manager_id and compare to the local `trades` table. Any mismatch is a bug.
