# Task — Equity-scaled position sizing

You are picking up this task in a fresh worker session. Read this end to end
before writing code.

## TL;DR

Right now `MAX_POSITION_DUSDC` is a fixed dollar amount the operator manually
edits in Coolify. As the bot wins, the operator has to manually raise it to
deploy the new capital; if it loses, they have to manually lower it. This is
crude — there should be a configurable rule that scales position size with
realized PnL automatically.

Build an opt-in equity-scaled sizer with two policies (operator picks one),
plus the existing fixed mode as the default.

## Context

- Repo: `/Users/martinswdev/Repos/SVX` (also at github.com/Econmartin/svx).
- Bot is running on Coolify, ~3 days into a 6-week hackathon window.
- Current sizer: `packages/svx-bot/src/exec/sizer.ts` — fixed-fraction with
  hard caps. `MAX_POSITION_DUSDC` (per-trade max) and `MAX_POSITION_PCT`
  (per-trade as fraction of NAV).
- Risk gate: `packages/svx-bot/src/exec/risk.ts` — daily loss limit,
  consecutive-loss circuit breaker, manual kill flag.

The operator wants the bot to "scale rather than repeat as it gains/loses."
Translation: turn $100 of accumulated PnL into a slightly bigger per-trade
size; turn $100 of accumulated drawdown into a slightly smaller one.

## What to build

### 1. New config: `SIZER_MODE`

Three modes (default `fixed`):

- `fixed` — current behavior. `MAX_POSITION_DUSDC` is the hard per-trade cap.
- `linear` — per-trade size = `base × (1 + scale_factor × (cum_pnl / starting_nav))`. Bounded by `min_position_dusdc` and `max_position_dusdc`.
- `step` — per-trade size = base + `floor(cum_pnl / step_pnl_threshold) × step_size_increment`. Bounded by min and max.

### 2. New env vars

```
SIZER_MODE=fixed|linear|step               # default fixed
SIZER_BASE_DUSDC=15                        # the starting per-trade cap
SIZER_MIN_DUSDC=5                          # never size smaller than this
SIZER_MAX_DUSDC=50                         # never size bigger than this
SIZER_LINEAR_SCALE=2.0                     # only linear mode
SIZER_STEP_PNL_THRESHOLD=50                # only step mode: every $50 of PnL
SIZER_STEP_INCREMENT=2                     # bumps size by $2
SIZER_BASELINE_NAV=                        # if unset, captured on first boot
```

### 3. Behavior

The "starting NAV" is captured on first boot (or whenever `data/sizer-baseline.json` doesn't exist). Persisted to `data/sizer-baseline.json` so it survives restarts. Cum PnL is `realizedPnlSince(0)` — all-time across the trades table.

`linear` math:
```
ratio = cumPnl / startingNav         // can be negative
multiplier = 1 + scale * ratio
sizeDusdc = clamp(base * multiplier, minDusdc, maxDusdc)
```

`step` math:
```
steps = floor(cumPnl / threshold)    // can be negative
sizeDusdc = clamp(base + steps * increment, minDusdc, maxDusdc)
```

Both modes log the effective per-trade cap each loop iteration so the
operator can see it changing.

### 4. Dashboard surface

Add a stat tile to the Overview page:

| Per-trade cap | $17 | mode=linear, +13% from base |

Show the current effective cap (after equity-scaling) plus the mode and how
far from the base.

### 5. Risk gate integration

The risk gate's per-trade cap check (`maxPositionDusdc * 2` hard limit) should
read the EFFECTIVE size (not the baseline `cfg.maxPositionDusdc`). Otherwise
the linear/step mode could push above the gate and get rejected at risk-check
time.

Cleanest pattern: introduce `getEffectivePositionDusdc(state, cfg, ledger)` that
returns the current effective cap. The sizer reads it; the risk gate reads it.

## What NOT to do

- Do **not** auto-execute trades or change strategy logic — sizing only.
- Do **not** modify the risk gate's other rails (daily loss limit, etc).
  Those are independent of sizing mode.
- Do **not** persist `data/sizer-baseline.json` to git — add to .gitignore
  if not already covered.
- Do **not** make `linear` or `step` the default — fixed is the safe default
  for a fresh operator.

## Acceptance criteria

1. New env vars work; defaults preserve current behavior (fixed @ $15).
2. `linear` mode at +$30 cum PnL with starting NAV $5k, scale 2.0, base $15:
   `multiplier = 1 + 2 * (30/5000) = 1.012`. Size = $15 × 1.012 = $15.18.
   That's a small bump from a small win — correct.
3. `step` mode at -$100 cum PnL with threshold $50, increment $2, base $15:
   `steps = -2`, size = $15 - $4 = $11. Correct downward step.
4. Both modes respect `min_position_dusdc` and `max_position_dusdc`.
5. Dashboard shows effective cap + mode. New stat tile appears.
6. Existing tests pass; new tests cover the sizer math (≥ 6 cases).
7. Bot logs the effective cap each iteration as part of `svx.loop.start`.

## Files to read first

1. `packages/svx-bot/src/exec/sizer.ts` — current sizer.
2. `packages/svx-bot/src/exec/risk.ts` — risk gate caps.
3. `packages/svx-bot/src/config.ts` — config schema + env parsing.
4. `packages/svx-bot/src/index.ts` — main loop, state shape, where the
   sizer is called.
5. `packages/svx-bot/src/ledger/store.ts` — `realizedPnlSince(0)` for cum PnL.
6. `packages/svx-dashboard/app/page.tsx` — where to add the stat tile.

## Stretch (only if v1 ships smoothly)

- **Quasi-Kelly mode**: use realized win rate × edge to compute a Kelly fraction.
  Requires ≥30 settled trades for a stable estimate; gracefully fall back to
  `fixed` until then.
- **Drawdown brake**: independent of mode, halve per-trade size whenever
  the bot is in >10% drawdown from peak equity.
- **Daily reset of base**: `step` mode resets `cum_pnl` reference daily so a
  big loss day doesn't permanently shrink position size.

Good luck. Default to safety: a wrong sizer breaks the bot quietly.
