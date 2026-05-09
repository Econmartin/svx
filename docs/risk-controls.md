# Risk controls

Every control listed here is implemented and tested. None are toggleable in
production: the only way to bypass them is to edit the source code and
redeploy.

## Filter chain (per signal)

Order matters — cheap checks first. First failure short-circuits.

| # | Check                          | Code path                                      |
|---|--------------------------------|------------------------------------------------|
| 1 | SVI staleness > 300s           | `signal/filter.ts:applyFilters`                |
| 2 | Polymarket book one-sided      | `signal/filter.ts:applyFilters`                |
| 3 | Polymarket bid-ask > 5 vol pts | `signal/filter.ts:applyFilters`                |
| 4 | Polymarket 24h volume floor    | `signal/filter.ts:applyFilters`                |
| 5 | Expiry mismatch                | `signal/filter.ts:applyFilters`                |
| 6 | Oracle settled                 | `signal/filter.ts:applyFilters`                |

## Risk gate (per trade)

After a signal passes filters, we size it and submit it to the risk gate.

| # | Check                          | Behavior on fail                  |
|---|--------------------------------|-----------------------------------|
| 1 | Manual kill flag present       | reject signal                     |
| 2 | Pause state in ledger          | reject signal                     |
| 3 | Cost > 2× hard cap             | reject signal                     |
| 4 | Cost > NAV × maxPositionPct    | reject signal                     |
| 5 | Open position count ≥ cap      | reject signal                     |
| 6 | 24h PnL ≤ −dailyLossLimit      | reject + auto-pause for 24h        |
| 7 | Consecutive losses ≥ N         | reject + auto-pause for 1h         |

Implementation: [packages/svx-bot/src/exec/risk.ts](../packages/svx-bot/src/exec/risk.ts).

## Manual kill switch

```bash
pnpm svx pause      # touches /tmp/svx-paused
pnpm svx resume     # removes /tmp/svx-paused, clears in-DB pause flag
```

The bot checks the filesystem flag at the start of every risk-gate call. The
flag survives bot restart; the in-DB pause flag does too.

## Reconciliation

Every loop iteration the bot:

1. Pulls the full Predict oracle list (cached for 30s on subsequent calls).
2. For each `status='settled'` oracle with a `settlement_price`, settles all
   matching trades in the local ledger.
3. Records PnL and updates the NAV snapshot.

If reconciliation surfaces a discrepancy that persists for >15 minutes
(planned for Phase 4 hardening), the bot pauses and alerts.

## Tested

- All math vectors pass: `pnpm test` (29 tests).
- Each filter triggers at least once in real-conditions runs (verified in the
  signals page of the dashboard, where `filtered` rows include the reason).
- Each risk gate has a unit-testable path; manual kill switch verified by
  `pnpm svx pause` followed by `pnpm svx status` showing `paused: true`.

## NOT tested (explicitly)

- Daily-loss limit auto-pause has not been triggered in real-money trading
  (we have not yet placed live trades on testnet pending dUSDC). The code
  path is exercised by the `RiskGate.check` unit logic; an integration test
  that spoofs a loss in the ledger and checks the pause is a Phase 3
  follow-up.
- Tx submission failure modes (RPC timeout, gas estimation failure) — paths
  exist in `exec/submit.ts` (Phase 3 stretch) but have not been exercised
  end-to-end on testnet. Mitigation: live trading is gated on a manual
  `PAPER_TRADING=false` env var, and the operator must have first
  successfully called `setup-manager.ts`.
