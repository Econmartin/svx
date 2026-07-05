# Risk controls

Every control listed here is implemented and tested. None are toggleable in
production: the only way to bypass them is to edit the source code and
redeploy.

## 2026-07 audit hardening (pre-relaunch)

The four-agent audit of 2026-07-03 found several rails that would not have
caught the *next* silent failure. All fixed and regression-tested
(`tests/audit-fixes.test.ts`):

| Fix | Before | After |
|---|---|---|
| Daily poly loss window | keyed on trade **open** time — losses on positions older than 24h (incl. every 14-day abandonment) never counted | keys on `poly_settled_at_ms` (settlement time), matching the HL gate |
| Circuit breaker | `null < 0` is false in JS → any NULL-pnl row (convergence, vol-arb) truncated the streak; only counted the paper Predict leg | skips NULL-pnl rows in SQL, counts `COALESCE(poly_pnl, predict_pnl)` (real money first), and is consulted by `checkPoly` |
| Boot behaviour | `autoResumeOnBoot=true` cleared daily-loss pauses, breaker trips, AND the manual kill flag on every redeploy | `false`; boot never removes `/tmp/svx-paused` — only `svx resume` does. Re-entry cooldowns are rebuilt from the ledger at boot |
| Invisible positions | a `submitted`-status fill (SDK response shape hid the numbers) was excluded from every lifecycle query — funded position invisible to caps/settlement/stops forever | `submitted`/`partial` rows are visible everywhere; unknown fills are recorded with conservative estimates + a loud error |
| Reconciliation | none — a ledger that lied +$122 vs −$120 had no independent check | wallet-vs-ledger invariant every balance refresh; drift > $5 pauses the bot. `svx rebaseline` acknowledges deposits/withdrawals |
| Redeems | one failure parked winnings forever behind a warn; absent `negRisk` flag guessed `false` (wrong contract → guaranteed revert) | retry with 30-min backoff up to 5 attempts; never guess negRisk (re-fetch instead); stranded total on `/status`; Safe-mode manual claims marked `pending`, not `failed` |
| Manual-claim blindness (found 2026-07-05) | in POLY_1271/Safe/Proxy modes the bot can never submit `redeemPositions` itself — the EOA can sign order messages on the smart wallet's behalf, but can't be `msg.sender` for an on-chain redeem — so the ONLY redemption path is the operator clicking "Claim" on polymarket.com; the ledger had no way to observe that, so `/status` kept reporting real, already-claimed money as unredeemed (and it silently fed the reconciliation drift alarm) | hourly + boot-time on-chain balance check (`reconcileExternallyRedeemedPositions`): for every row still marked unredeemed, read the funder's actual ERC1155 balance for that outcome token; balance=0 with no early-exit sale on record means it was claimed outside the bot — mark it redeemed (`external-claim` sentinel) so the ledger matches reality |
| HL hedge | sized at the 15-min oracle expiry (~5× oversize), then capped into irrelevance; booked account-lifetime funding per closed leg | hedge opens disabled (`hlHedgeEnabled=false`); TTM fixed to poly expiry for any future re-enable; funding uses `sinceOpen` |
| Cross-strategy | poly-arb and convergence could buy opposite sides of one market | opposite-token guard on `conditionId` in both entry paths |
| Convergence inputs | regex matched "Bitcoin dominance above 60"; no volume floor; raw 1h trailing RV at face value | `$`/`k`-anchored parser + non-price exclusions, strike band 0.5–2× spot, volume floor, 15-min RV warm-up, 2× sigma safety multiplier, −15% strategy-specific stop |

## Filter chain (per signal)

Order matters — cheap checks first. First failure short-circuits.

| # | Check                          | Code path                                      |
|---|--------------------------------|------------------------------------------------|
| 1 | SVI staleness > 300s           | `signal/filter.ts:applyFilters`                |
| 2 | Polymarket book one-sided      | `signal/filter.ts:applyFilters`                |
| 3 | Polymarket bid-ask > 5 vol pts | `signal/filter.ts:applyFilters`                |
| 4 | Polymarket 24h volume floor    | `signal/filter.ts:applyFilters`                |
| 5 | Expiry mismatch                | `signal/filter.ts:applyFilters`                |
| 6 | Market already past end time   | `signal/filter.ts:applyFilters`                |
| 7 | Oracle settled                 | `signal/filter.ts:applyFilters`                |

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
pnpm svx pause        # touches /tmp/svx-paused
pnpm svx resume       # removes /tmp/svx-paused, clears in-DB pause flag,
                      #   bumps the circuit-breaker watermark
pnpm svx rebaseline   # acknowledge a pUSD deposit/withdrawal to the
                      #   reconciliation invariant
```

The bot checks the filesystem flag at the start of every risk-gate call. Both
the filesystem flag and the in-DB pause survive restarts — **no automated
path removes either** (`autoResumeOnBoot=false`; even when flipped to true,
the boot path never touches the manual flag).

## Reconciliation

Two independent layers:

1. **Settlement reconciliation** (every loop): Predict oracles settle
   matching ledger trades; every 5 min the gamma poll (with the load-bearing
   `closed: true` param) settles Polymarket legs, books PnL, and queues
   redeems.
2. **Wallet-vs-ledger invariant** (every poly balance refresh, ~60s): if the
   ledger is truthful, `wallet − (Σ settled PnL − Σ open cost − Σ unredeemed
   payouts)` is a constant baseline. Drift beyond
   `reconcileDriftThresholdUsdc` (default $5) pauses the bot with an error —
   this is the control that catches a silent booking bug regardless of which
   query is broken. The baseline is stored in the ledger's `meta` table;
   operator funding events are acknowledged with `svx rebaseline`. Current
   drift is surfaced on `/status` (`polyReconcile`).

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
