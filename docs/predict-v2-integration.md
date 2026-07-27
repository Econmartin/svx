# DeepBook Predict V2 — integration notes (testnet cutover, 2026-07-26)

Working notes for the SVX migration off the retired V1 deployment. Source of
truth: branch `predict-testnet-6-24` (+ `at/DBU-655-svi-roll-down`, deployed
2026-07-27) of MystenLabs/deepbookv3. The V2 testnet is redeployed frequently
with non-upgrade-safe changes (DBU-640), so **all ids below are examples —
resolve at runtime, never hardcode.**

## Deployments (as of 2026-07-27; WILL change)

| thing | id |
|---|---|
| predict package | `0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e` |
| propbook package (feeds) | `0x8eb2adde1c91f8b7c9ba5e9b0a32bfb804510c342939c5f77458fd8143f9755b` |
| account package | `0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b` |
| dUSDC package | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a` |
| BTC SVI oracle lane (propbook) | `0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69` |

Runtime resolution: `GET /markets` rows carry `package`, `expiry_market_id`,
`pool_vault_id`, `propbook_underlying_id`, `expiry`, `tick_size`, fee/probability
bounds. Singleton shared objects (ProtocolConfig, OracleRegistry, feeds,
AccumulatorRoot, AccountRegistry) resolve by TYPE via GraphQL `objects(filter:
{type})` against the current package ids.

## API (predict-server.testnet.mystenlabs.com — V2)

Old `/oracles*` routes are gone. Confirmed live: `/status`, `/config`,
`/markets`, `/markets/:id/state`, `/markets/:id/orders`. Full route table from
`crates/predict-server` (6-24 branch) additionally: `/managers`,
`/managers/:id/{orders,state,positions,staking,lp-requests}`,
`/vaults/:id/{state,supply-requests,withdraw-requests,supply-fills,
withdraw-fills,flushes,profit,cash-rebalances,cash-receipts,flows}`,
`/markets/:id/{open-interest,activity,liquidation-stats}`,
`/builder-codes/:id/fees`.

`/markets/:id/state` = `{ market (config row), reference_tick (spot, tick,
source_timestamp_ms), mint_paused, settlement (settlement_price, settled_at_ms) }`.

A separate **oracle-server** exists in the branch
(`/oracles/:propbook_oracle_id/block-scholes`, `/oracle-sources`,
`/oracle-bindings`, `/underlyings/:id/binding`, plus Pyth Pro endpoints from
PR #1161) — public hostname not yet discovered; SVI is available on-chain
regardless (below).

## SVI surface (V2)

No SVI on predict-server. The surface lives in propbook oracle lanes, one lane
per (source, expiry). Read via GraphQL events (fresh every ~1s when quiet,
sub-second when moving):

```
events(filter: {module: "<propbook_pkg>::oracle_lane"})
→ ObservationRecorded<OracleRead<RawSVI>> {
    propbook_oracle_id,
    observation: {
      source_timestamp_ms,   # market-data time (per-update; replay anchor)
      update_timestamp_ms,   # chain write time
      value: { bs_source_id, expiry_ms,
               svi: { a, b, sigma,            # a UNSIGNED here, BUT:
                      rho: {magnitude, is_negative},
                      m:   {magnitude, is_negative} } } } }
```

**Signed `a` (DBU-548):** the wire format supports negative `a`
(`svi_a_magnitude`, `svi_a_is_negative` in the signed-oracle batch). Observed
events currently emit plain `a`, but the parser MUST accept both `a: number`
and `a: {magnitude, is_negative}` shapes. Same defensive shape-handling for
b/sigma.

**Roll-down (DBU-655, deployed 2026-07-27):** Block Scholes retransmits
unchanged SVI every second with a fresh envelope timestamp; the contract now
anchors parameter age to `source_timestamp_ms` and rolls unchanged parameters
down to expiry. Consequences for us: (1) staleness = source_timestamp age, not
update_timestamp age — feed-alive and data-moved are separate signals; (2) the
near-expiry stale-surface mispricing that part of our V1 edge fed on is
actively fixed — re-validate before enabling.

## Mint/redeem flow (exec layer)

One-time: `account_registry::new(registry, ctx) → AccountWrapper` (keep the
object; fund via `account::deposit<dUSDC>`).

Per mint, one PTB:
1. `account::generate_auth(ctx) → Auth`
2. `expiry_market::load_live_pricer(market, config, propbook_registry, pyth,
   bs_spot, bs_forward, bs_svi, clock) → Pricer` (PTB-local snapshot)
3. `expiry_market::mint_exact_quantity(market, wrapper, auth, config, pricer,
   lower_tick, higher_tick, quantity, leverage, max_cost, max_probability,
   root, clock, ctx) → order id (u256)`
   - `max_cost` / `max_probability`: pass real caps (u64::MAX = uncapped);
     PR #1163/#1164 make an all-in cost cap required on budget mints.
   - Ranges are native: every order is (lower_tick, higher_tick]; a binary is
     a one-sided range with the far bound at the pos-inf tick.

Redeem: `redeem_live` (pre-expiry), `redeem_settled` (own),
`redeem_settled_permissionless(market, account_registry, wrapper, config,
order_id, close_quantity, root, clock)` — permissionless, no protocol tip.

## Economics that change strategy math

- **Inventory skew (PR #1156):** quotes skew against trades increasing pool
  net exposure — one-sided favored buying gets progressively worse prices.
- **Cost caps (PR #1163/4), slippage protection (PR #1158), deviation guards
  (#1157), certified pricing error (#1159):** the mispricing-harvest surface
  is being deliberately tightened.
- **Leverage/admission**: markets carry `max_admission_leverage`,
  `liquidation_ltv` — positions can be leveraged and LIQUIDATED. V1 had no
  liquidation. Risk model must treat leverage=1 as the safe default.
- Fees: `base_fee`/`min_fee` + `expiry_fee_window_ms` ramp near expiry.
- Entry probability clamps: `min/max_entry_probability` (1%–99%).

## Migration decisions

1. All ids runtime-resolved; `PREDICT_V2=true` env gates the new client so the
   old code path can be deleted once stable.
2. Strategies stay in OBSERVE/PAPER on V2 until calibration re-accrues:
   V1-measured edge (86¢→100%) does not carry over — roll-down + skew target
   exactly those mispricings.
3. The 4 open V1 positions (~74 dUSDC) are stranded on the retired package;
   ask Mysten whether the old deployment gets a settlement pass. Not blocking.
4. dUSDC package differs from V1's — old coins are not V2 collateral; the bot
   needs V2 dUSDC (faucet/mint path TBD).
