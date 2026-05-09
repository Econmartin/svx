# SVX operations runbook

How to run, pause, debug, and recover. Aimed at someone who has never seen
the bot before.

## Starting the bot

### Paper mode (safe default)

```bash
pnpm svx start
```

The bot:
- Boots the read-only API on `http://127.0.0.1:4321`.
- Polls active Predict BTC oracles + Polymarket BTC strike markets every 15s.
- Logs every signal (incl. sub-threshold and filtered) to `./data/svx.sqlite`.
- Records SVI snapshots so the dashboard surface viewer has data.
- Does NOT submit any on-chain transactions.

### Live mode

Prereqs:
1. `data/operator.json` exists (created by `pnpm tsx scripts/setup-manager.ts`).
2. Operator address has dUSDC in their wallet (or already in the manager).
3. Operator address has SUI for gas.

```bash
PAPER_TRADING=false pnpm svx start
```

The risk gate refuses any cost > `MAX_POSITION_DUSDC` × 2 — adjust env vars
in `.env` before going live.

## Inspecting state

```bash
pnpm svx status     # ledger state, pause flag, recent counts
pnpm svx report     # PnL summary
```

Tail the structured JSON log:

```bash
tail -f logs/bot.log | jq
```

API surface (browser-friendly):
- `GET /status`
- `GET /signals?limit=200`
- `GET /positions/open`
- `GET /positions/closed?limit=500`
- `GET /surface/<oracleId>`
- `GET /oracles`

## Pausing

```bash
pnpm svx pause      # creates /tmp/svx-paused
pnpm svx resume     # clears it
```

The pause is also persisted to the ledger so it survives bot restart. Resume
clears both.

## Common failures and fixes

| Symptom                                    | Likely cause                          | Fix                                          |
|--------------------------------------------|----------------------------------------|----------------------------------------------|
| `svx.loop.no_matches` every iteration      | Predict expiry doesn't overlap Poly   | Wait for Predict to schedule the right expiry; this is normal mid-day |
| `svx.poly.snapshot_failed`                 | Polymarket CLOB rate-limit or down    | Bot retries with exponential backoff; check `clob.polymarket.com`    |
| `predict.latestSvi failed`                 | Predict server transient error        | Bot retries; check `predict-server.testnet.mystenlabs.com/status`    |
| `svx cannot submit tx: ... not pinned`     | Address swap needed                    | Update `packages/svx-shared/src/addresses.ts` with the new IDs       |
| `signed and executed: failure`             | Live tx reverted on chain             | Inspect the Move error code; re-check oracle status, manager balance |

## Recovering from a crash

The bot is stateless beyond `./data/svx.sqlite`. To recover:

```bash
ps aux | grep "src/cli.ts start" | grep -v grep | awk '{print $2}' | xargs -r kill
pnpm svx start
```

The bot reads the latest pause state, replays settlement reconciliation, and
resumes. No tx is replayed — every tx submission is idempotent at the
PredictManager level (positions are accumulated by mint, not resumed).

## Restarts and supervision

For demo / multi-day runs, supervise the bot with `pm2`:

```bash
pm2 start "pnpm svx start" --name svx --time
pm2 logs svx
```

For production-style ops, a `systemd` unit file is recommended (template in
[mainnet-runbook.md](mainnet-runbook.md)).
