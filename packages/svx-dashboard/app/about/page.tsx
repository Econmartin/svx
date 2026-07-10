import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowSquareOut, FlowArrow, ShieldCheck, GitBranch, Target, Trophy, Code, Wrench, TreeStructure, WarningOctagon, Rocket } from '@phosphor-icons/react/dist/ssr';

export default function AboutPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
            About SVX
          </h1>
          <Badge variant="outline">Sui Overflow 2026</Badge>
        </div>
        <p className="text-muted-strong text-[14.5px] leading-relaxed">
          SVX is a fully-automated cross-venue trading bot for the DeepBook
          Predict track. Three live strategies share one risk stack:{' '}
          <strong>divergence-mint</strong> mints Predict's favorite on-chain
          when the venues disagree by ≥8pp (the Predict-native flagship — live
          with dUSDC on testnet, validated at 94% win rate across two disjoint
          data windows), <strong>poly-arb</strong> captures pricing
          disagreements between Predict's continuous SVI surface and
          Polymarket's discrete-strike order book with real money on Polygon
          mainnet, and <strong>expiry-convergence</strong> buys the
          deep-in-the-money side of BTC dailies in their final hour when
          realized vol says the strike is out of reach. Positions are small
          naked binaries bounded by hard per-trade clips — the earlier
          Hyperliquid delta hedge is disabled after the 2026-07 audit found it
          mis-sized (see Limitations below); Hyperliquid still supplies the
          live realized-vol feed.
        </p>
      </header>

      <Card className="border-accent/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-accent" /> Track minimum requirements — with evidence
          </CardTitle>
          <p className="text-xs text-muted mt-0.5">
            Each requirement from the brief, and where to verify it yourself in under a minute.
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 text-sm">
            <Requirement
              req="Integrate the DeepBook Predict contract on testnet"
              evidence={
                <>
                  The testnet bot mints live positions via{' '}
                  <code className="code">predict::mint</code> and claims payouts via{' '}
                  <code className="code">predict::redeem_permissionless</code> — every trade row
                  on <a className="underline decoration-border hover:text-accent" href="/divergence-mint">/divergence-mint</a> and{' '}
                  <a className="underline decoration-border hover:text-accent" href="/positions">/positions</a>{' '}
                  carries its Sui tx digest. The pricing brain reads the on-chain{' '}
                  <code className="code">OracleSVI</code> surface continuously (
                  <a className="underline decoration-border hover:text-accent" href="/surface">/surface</a>).
                </>
              }
            />
            <Requirement
              req="Work end to end — the entire flow will be tested"
              evidence={
                <>
                  Signal → risk gates → on-chain mint → settlement detection → permissionless
                  redeem, running unattended on a 15s loop. The same pipeline executes real money
                  on Polymarket (Polygon mainnet) with UMA settlement + CTF auto-redeem, and a
                  wallet-vs-ledger reconciliation invariant pauses trading on unexplained drift.
                  Watch it live on <a className="underline decoration-border hover:text-accent" href="/overview">/overview</a>.
                </>
              }
            />
            <Requirement
              req="Proper simulation results for strategy claims"
              evidence={
                <>
                  Every recorded signal is replayable server-side against recorded settlements:{' '}
                  <code className="code">GET /backtest?side=favored&dedupe=true&fee=0.02</code>{' '}
                  on either bot recomputes the divergence-mint validation from the deployed
                  ledger on demand, and <code className="code">GET /calibration</code> publishes
                  the SVI feeder's quoted-vs-realized calibration — the "live stress test of the
                  SVI feeder" the brief asks for. Method + caveats:{' '}
                  <code className="code">docs/backtest-report.md</code>.
                </>
              }
            />
          </div>
        </CardContent>
      </Card>

      {/* Stacked 3-card list. Earlier we tried an asymmetric hero-vs-stack
          grid to highlight Predict as the pricing brain, but at mid-width
          breakpoints it broke awkwardly and the user feedback was just
          "should be three on top of each other." Stacked reads cleaner,
          works at every width, and the green-tone left border on Predict
          still carries the hierarchy. */}
      <div className="space-y-3">
        <Venue
          name="DeepBook Predict"
          subtitle="Pricing brain"
          body="SVI-parameterized vol surface gives the continuous fair probability for every BTC strike. On testnet we also execute against the surface directly with dUSDC; on mainnet (pending Sui mainnet) we use Predict only as our quote engine."
          tone="accent"
        />
        <Venue
          name="Polymarket"
          subtitle="Real-money execution"
          body="Live on Polygon mainnet. Buys Yes/No outcome shares when Predict's fair value disagrees with Polymarket's book by > threshold. Auto-redeems winning shares via the NegRiskAdapter once UMA settles."
          tone="loss"
        />
        <Venue
          name="Hyperliquid"
          subtitle="Realized-vol feed"
          body="A 2s ticker samples the BTC perp mid continuously — that trailing realized vol drives the expiry-convergence sigma gate. The delta-hedge leg is DISABLED (2026-07 audit: hedge was sized at the wrong expiry and capped into irrelevance); close machinery remains for any legacy legs."
          tone="warn"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlowArrow className="h-4 w-4 text-accent" /> How it works
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm leading-relaxed">
            <Step
              n={1}
              title="Pull oracles + Polymarket books (every 15s)"
              body={
                <>
                  Predict gives <code className="code">w(k) = a + b · (ρ(k − m) + √((k − m)² + σ²))</code> for every
                  oracle; we extract IV at each Polymarket strike and reprice the binary at the
                  Polymarket expiry (flat-vol-across-expiries reprice — extends the trading window).
                </>
              }
            />
            <Step
              n={2}
              title="Compute spread, decide side"
              body={
                <>
                  If <code className="code">P_predict − P_poly_ask &gt; threshold</code> we buy <strong>Yes</strong> on
                  Poly (cheap). The opposite spread side buys <strong>No</strong>. Default threshold is 3 percentage
                  points.
                </>
              }
            />
            <Step
              n={3}
              title="Risk-gate → execute Polymarket leg"
              body={
                <>
                  Per-trade pUSD cap, open-position count cap, daily-loss limit, book-depth floor, and a manual kill
                  switch. Submit market-buy via the Polymarket CLOB.
                </>
              }
            />
            <Step
              n={4}
              title="Expiry-convergence walker (every 60s)"
              body={
                <>
                  For BTC dailies in their final 5–90 minutes: if spot sits ≥{' '}
                  <code className="code">minSigma × safetyMult</code> trailing sigmas from the strike
                  (RV from the always-on HL sampler, ×2 fat-tail margin), buy the in-the-money side at
                  90–97¢ and hold to resolution. Gates: strict question parser + strike sanity band,
                  volume floor, RV warm-up, crowd-disagreement standdown, tight −15% stop.
                </>
              }
            />
            <Step
              n={5}
              title="Settlement + auto-redeem"
              body={
                <>
                  Every 5 min the bot polls Polymarket gamma for UMA resolution. On settlement: mark PnL, call CTF
                  redeem (NegRiskAdapter / ConditionalTokens), close the HL hedge with a reduce-only IOC. Combined PnL
                  lands on the dashboard.
                </>
              }
            />
          </ol>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-win" /> Safety posture
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed space-y-2">
            <p>
              Single-operator. No users, no pooled funds, no tokenized shares,
              no on-chain Move package shipped by SVX itself — we compose with
              existing protocols only.
            </p>
            <p>
              Every risk gate is mandatory: per-trade caps, daily loss limits
              (separate dUSDC / pUSD / HL stacks, keyed on <em>settlement</em>{' '}
              time so old positions can't dodge them), staleness checks,
              book-depth floor, a consecutive-loss circuit breaker that counts
              real-money PnL, and a filesystem kill switch. Auto-pauses on
              breach; resume is explicit operator action — redeploys never
              clear a pause.
            </p>
            <p>
              Post-incident hardening (2026-07): a <strong>wallet-vs-ledger
              reconciliation invariant</strong> compares the pUSD balance to the
              ledger-implied expectation every cycle and pauses trading on
              &gt;$5 of unexplained drift — two consecutive breaches are
              required before pausing, so settlement latency doesn't trip
              false positives, but a silent booking bug still surfaces in
              minutes, not weeks. Failed redeems retry with backoff; stranded
              winnings are totalled on <code className="code">/status</code>.
              A <code className="code">GET /backtest</code> endpoint lets the
              deployed bot replay its own recorded signal stream server-side
              (<code className="code">side=predict|flip|favored</code>) to
              check strategy variants against actual history.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-accent" /> Edge sources
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm leading-relaxed space-y-2">
            <p>
              <strong>Polymarket stickiness:</strong> their books update in human
              time; SVI moves faster. Most early edge is Predict re-pricing while
              Polymarket lags.
            </p>
            <p>
              <strong>Cross-expiry repricing:</strong> Predict's IV is expiry-invariant
              under flat-vol, so we can compare to any Polymarket expiry (not just
              ±1h).
            </p>
            <p className="text-muted">
              Edge decays as more bots run this systematically. Built into the spec.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-l-4 border-l-accent">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-4 w-4 text-accent" /> Hackathon spec — Idea #7, verbatim
          </CardTitle>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            From the DeepBook Predict problem statement: <em>"the single most
            realistic mainnet-day-one strategy — and it doubles as live stress
            test of the SVI feeder."</em>
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted border-b border-border">
                  <th className="py-2 pr-3 font-medium">Spec requirement</th>
                  <th className="py-2 font-medium">What SVX built</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <SpecRow
                  req="Back-solves Predict's implied vol from OracleSVI"
                  built="SVI evaluator + Newton/bisection IV inversion, validated against Python reference vectors. 36 math tests pass."
                />
                <SpecRow
                  req="Compares against Polymarket BTC option smile at matching expiry"
                  built="Cross-expiry SVI reprice in signal/spread.ts — flat-vol assumption lets us compare to any Polymarket expiry, not just ±1h."
                />
                <SpecRow
                  req="Trades the spread when it exceeds a threshold"
                  built="Live on Polygon mainnet via POLY_1271 Deposit Wallet flow. Default spread threshold 3pp; tunable in tunables.ts."
                />
                <SpecRow
                  req="Stretch: delta-hedge the binary on Hyperliquid perps"
                  built="Built and exercised on mainnet, then disabled by the 2026-07 audit — the hedge was sized at the oracle expiry instead of the Polymarket expiry, and a correct ATM hedge exceeds the per-trade cap. HL infra now feeds realized vol to the convergence strategy instead."
                  stretch
                />
                <SpecRow
                  req="Handle stale SVI updates gracefully"
                  built="maxSviStalenessSec gate. Stale oracle → signal filtered with reason svi_stale, visible on /signals."
                />
                <SpecRow
                  req="Kill switch on feeder lag"
                  built="Filesystem flag (/tmp/svx-paused), ledger-persisted pause, and three independent daily-loss circuit breakers (dUSDC / pUSD / HL)."
                />
                <SpecRow
                  req="Minimum requirement: works end-to-end"
                  built="Predict mint (testnet), Polymarket fill + auto-redeem (mainnet), HL perp hedge + close (mainnet). All four legs settle on-chain."
                />
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TreeStructure className="h-4 w-4 text-accent" /> Why two networks?
          </CardTitle>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            The dashboard shows a <strong>testnet</strong> bot and a <strong>mainnet</strong> bot
            side-by-side. They're not redundant — each demonstrates a piece the other can't.
          </p>
        </CardHeader>
        <CardContent className="space-y-4 text-sm leading-relaxed">
          <div>
            <div className="font-medium flex items-center gap-2">
              <Badge variant="testnet" className="text-[10px]">testnet bot</Badge>
              Full Predict integration — the on-chain proof
            </div>
            <p className="text-muted mt-1.5">
              DeepBook Predict has no mainnet deployment yet — testnet is the <em>only</em> place
              the protocol lives today. The testnet bot mints binary positions with{' '}
              <code className="code">predict::mint</code>, settles via{' '}
              <code className="code">predict::redeem_permissionless</code>, and reads the SVI
              surface from the live oracle feed. It exists to prove the entire Predict integration
              path works end-to-end on real Move calls, with real (faucet) dUSDC. That's the
              minimum-requirement bar from the spec: <em>"Work end-to-end if you are building a
              product, we will test the entire flow."</em>
            </p>
          </div>
          <div>
            <div className="font-medium flex items-center gap-2">
              <Badge variant="mainnet" className="text-[10px]">mainnet bot</Badge>
              Real-money cross-venue arb — the strategy proof
            </div>
            <p className="text-muted mt-1.5">
              The mainnet bot uses Predict (testnet) as its <strong>pricing brain</strong> — the
              SVI surface drives every signal — while executing the resulting trades on{' '}
              <strong>Polymarket (Polygon mainnet)</strong>, with{' '}
              <strong>Hyperliquid (mainnet)</strong> supplying the realized-vol feed (the delta
              hedge is disabled post-audit). PnL on this bot is real money. This is what
              <em> "mainnet-day-one"</em> actually means: the cross-venue logic, the SVI-driven
              spread detection, the order submission, and the settlement reconciliation are
              all <strong>live today</strong> against real liquidity. The only
              piece waiting on Predict's Sui-mainnet launch is the on-chain Sui mint — that's a
              single config flip (<code className="code">MAINNET_PAPER_TRADING=false</code>), not
              a code change.
            </p>
          </div>
          <div className="rounded border border-border-strong bg-surface-elevated/40 p-3 text-xs">
            <strong className="text-fg">Why this matters for judging:</strong> shipping a
            mainnet-only project would mean either (a) faking the Predict leg, or (b) waiting for
            Predict mainnet and missing the deadline. The testnet/mainnet split lets us run the
            full Predict integration in production today AND have a real-money signal-execution
            loop running in parallel. The day Predict ships mainnet, the bot is already trading.
          </div>
        </CardContent>
      </Card>

      <Card className="border-l-4 border-l-accent">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-accent" /> What SVX becomes on Predict mainnet
          </CardTitle>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            Phase 1 today → Phases 2–4 on Predict mainnet-day-one. The
            single-operator architecture exists so each subsequent phase
            is additive — never a rewrite. No promises beyond the
            time-scale words below; no signup, no pooled funds, no
            tokenised shares today.
          </p>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm leading-relaxed">
            <Step
              n={1}
              title="Single-operator bot — live today"
              body={
                <>
                  Trades the operator's own dUSDC + pUSD + HL margin. No users,
                  no pooled funds, no tokenised shares. Proves the end-to-end
                  strategy works under real liquidity.
                </>
              }
            />
            <Step
              n={2}
              title="Public SVI calibration feeder (Predict mainnet, week 1)"
              body={
                <>
                  The bot already back-solves Predict's IV from the SVI surface
                  and compares it to Polymarket's implied vol every 15s. We
                  publish that comparison as a free read-only feed — other
                  Predict strategies, vaults, and risk dashboards can subscribe
                  to <em>"is the SVI surface currently consistent with external
                  venues, by how much, in which direction."</em> Zero trust,
                  just data.
                </>
              }
            />
            <Step
              n={3}
              title="Open-source template (Predict mainnet, month 1)"
              body={
                <>
                  One operator can clone the repo and stand up their own SVX in
                  &lt;30 min (Quickstart + Mainnet runbook are already there for
                  this reason). The more independent SVX instances run, the
                  tighter Predict's surface stays calibrated against external
                  venues. This is exactly the <em>"live stress test of the SVI
                  feeder"</em> the spec asks for, run by many parties.
                </>
              }
            />
            <Step
              n={4}
              title="Tokenised cross-venue arb vault (post-audit)"
              body={
                <>
                  A future Move package wraps the bot in a vault: LPs deposit
                  dUSDC, receive a transferable share token (composable with
                  <code className="code">deepbook_margin</code> /
                  <code className="code">iron_bank</code> / structured products),
                  and the bot trades on the vault's behalf. Combined PnL
                  distributed pro-rata. <strong>This phase requires a Move
                  audit + legal review</strong> (security-token classification
                  depends on jurisdiction). Deliberately out of scope for the
                  hackathon — the single-operator architecture exists so this
                  is an additive evolution, not a rewrite.
                </>
              }
            />
          </ol>
          <p className="text-xs text-muted mt-4 leading-relaxed">
            Phases 2–4 are commitments to <em>direction</em>, not dates beyond
            the time-scale words above. They drop out the moment they would
            require pooling user funds before audit and legal sign-off.
          </p>
        </CardContent>
      </Card>

      <Card className="border-l-4 border-l-warn">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <WarningOctagon className="h-4 w-4 text-warn" /> Limitations &amp; honest tradeoffs
          </CardTitle>
          <p className="text-xs text-muted mt-1">
            Where we knowingly cut scope or accepted a structural constraint. Worth saying out
            loud rather than papering over.
          </p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm leading-relaxed">
            <Limitation
              title="Vol-arb was cut — a perp cannot harvest an IV−RV spread"
              body={
                <>
                  Classical vol-arb captures vol mispricing via <strong>gamma</strong>{' '}
                  (long/short options). Perps are linear — they only profit on direction. The
                  audit reconciled the strategy to the cent against HL's records: $29.12 in fees,
                  −$1.80 of direction PnL over 5,219 fills. It is now hard-disabled in code (the
                  env var is deliberately ignored); its 2s ticker survives as the realized-vol
                  sampler feeding the convergence strategy.
                </>
              }
            />
            <Limitation
              title="Poly positions are naked binaries — the delta hedge is off"
              body={
                <>
                  The audit found the hedge sized delta at the 15-minute Predict oracle's expiry
                  instead of the Polymarket market's (~5× oversize via 1/√T), and a correctly
                  sized at-the-money hedge exceeds the per-trade HL cap anyway. Rather than claim
                  "delta-neutral by construction" while shipping something else, the hedge is
                  disabled and the risk shape is stated honestly: each position risks at most its
                  $4 clip, bounded further by the position cap, stop-losses, and daily limits.
                </>
              }
            />
            <Limitation
              title="Predict positions can't exit before settlement"
              body={
                <>
                  The protocol exposes <code className="code">mint</code> and{' '}
                  <code className="code">redeem_permissionless</code> only — no{' '}
                  <code className="code">burn</code> or secondary market. Once minted, a position
                  is locked until the oracle settles. We compensate by adding mid-life exit on
                  the Polymarket leg (sells back when mark P&amp;L crosses +20% of cost), so we
                  capture the spread the moment the markets converge instead of waiting hours
                  for UMA. The Predict leg still rides to expiry — that's a protocol property,
                  not a bot bug.
                </>
              }
            />
            <Limitation
              title="Cross-expiry reprice assumes flat-vol"
              body={
                <>
                  Predict oracles have short expiries (sub-hour); Polymarket markets are typically
                  end-of-day or end-of-week. To compare them we treat Predict's IV as
                  expiry-invariant (flat-vol assumption) and reprice the binary at the Polymarket
                  expiry. This is exact under the assumption and approximate when the term
                  structure has slope. Accepted as a simplification — adding a full term-structure
                  model is future work.
                </>
              }
            />
            <Limitation
              title="POLY_1271 Deposit-Wallet setup is manual"
              body={
                <>
                  Polymarket's May 2026 rollout requires a smart-contract Deposit Wallet for new
                  accounts. The bot supports POLY_1271 mode (the only mode that works for new
                  signups), but deploying the DW + re-deriving the L2 API key against it is a
                  one-time manual step at polymarket.com. Documented in the runbook; not
                  automatable today.
                </>
              }
            />
            <Limitation
              title="No Move package shipped by SVX"
              body={
                <>
                  Deliberate — every line of Move ships an audit surface. SVX composes with{' '}
                  <code className="code">predict::*</code> and{' '}
                  <code className="code">predict_manager::*</code> via Sui RPC only, no custom
                  contracts. Trade-off: we can't ship tokenized vault shares or pool-with-others
                  primitives. For the hackathon-bot category that's the right call; for a
                  full-vault product it'd be a future iteration with proper audit.
                </>
              }
            />
            <Limitation
              title="Edge decays as more bots run this"
              body={
                <>
                  Cross-venue convergence trades have finite edge by construction — every
                  additional bot tightens the spread. The spec acknowledges this. Once Predict
                  has full mainnet deployment, the bot's per-trade PnL will compress as other
                  arbs enter. Building this strategy now is about being one of the first feeders
                  helping calibrate Predict's surface against external venues, not about long-term
                  cash-printing.
                </>
              }
            />
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-warn" /> Judging criteria mapping
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed">
          <Criterion
            weight="50%"
            label="Real-world application"
            body="Cross-venue vol-arb is the canonical mainnet-day-one liquidity bridge between Predict and the existing options/binaries ecosystem. The Polymarket leg runs on real money today; only the Predict side needs Sui mainnet to flip from paper to live (one config change)."
          />
          <Criterion
            weight="20%"
            label="Product & UX"
            body="Network-aware dashboard (single SPA covers testnet + mainnet), per-page intro cards, on-chain truth surfaced separately from ledger state for drift detection. Wallet + balance flows are explicit so an operator never wonders which address holds what."
          />
          <Criterion
            weight="20%"
            label="Technical implementation"
            body="Pure-math pricing stack with reference-vector tests, additive SQLite migrations (no destructive ALTERs), separate fast (2s) ticker for vol-arb decoupled from the 15s poly-arb loop, idempotent backfills on schema migrations. End-to-end TypeScript, Sui Move PTB construction inline."
          />
          <Criterion
            weight="10%"
            label="Presentation & vision"
            body="Single tunables.ts file holds all non-secret knobs — no env-var roulette, no Coolify panel hunt. Every dashboard page explains itself. The repo is one git clone away from another operator running their own instance."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-accent" /> Fork &amp; run your own
          </CardTitle>
          <p className="text-xs text-muted mt-1">
            Walkthrough for a fresh operator wanting to clone the repo and stand up their own instance.
          </p>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3 text-sm leading-relaxed">
            <Step
              n={1}
              title="Clone + install"
              body={
                <>
                  <code className="code">git clone https://github.com/Econmartin/svx &amp;&amp; pnpm install</code>.
                  Monorepo: <code className="code">svx-bot</code>, <code className="code">svx-dashboard</code>,{' '}
                  <code className="code">svx-shared</code>. Node 18+, pnpm 8+.
                </>
              }
            />
            <Step
              n={2}
              title="Generate operator wallets (one per venue)"
              body={
                <>
                  <code className="code">pnpm --filter svx-bot setup-manager</code> for Sui;{' '}
                  <code className="code">generate-poly-wallet</code> for Polygon;{' '}
                  <code className="code">generate-hl-wallet</code> for Hyperliquid. Each prints
                  the keypair <strong>once</strong> — copy the private keys into your env.
                </>
              }
            />
            <Step
              n={3}
              title="(Mainnet only) Polymarket Deposit Wallet setup"
              body={
                <>
                  Log in to polymarket.com with the EOA, complete one tiny manual trade to deploy
                  the Deposit Wallet (POLY_1271 mode), then run{' '}
                  <code className="code">pnpm --filter svx-bot derive-poly-api-key-1271</code> to
                  re-derive the L2 API key against the DW. See runbook §1.4.5.
                </>
              }
            />
            <Step
              n={4}
              title="Fund the wallets"
              body={
                <>
                  Testnet dUSDC from the Mysten faucet (form linked in the spec). Mainnet pUSD:
                  Kraken USDC → Polygon → wrap via{' '}
                  <code className="code">wrap-usdce-to-pusd</code> →{' '}
                  <code className="code">send-pusd-to-proxy</code>. HL USDC: Kraken USDC → Arbitrum
                  → bridge into HL via app.hyperliquid.xyz Portfolio → Deposit.
                </>
              }
            />
            <Step
              n={5}
              title="Boot the stack (Docker Compose)"
              body={
                <>
                  <code className="code">docker compose up -d</code>. The compose file wires three
                  services: <code className="code">bot</code> (testnet),{' '}
                  <code className="code">bot-mainnet</code>, and{' '}
                  <code className="code">dashboard</code>. Coolify handles secrets + routing in
                  production; locally just set env vars in a <code className="code">.env</code> at
                  the workspace root.
                </>
              }
            />
            <Step
              n={6}
              title="Tune the strategy"
              body={
                <>
                  Open <code className="code">packages/svx-bot/src/tunables.ts</code>. All
                  non-secret knobs — thresholds, position caps, daily loss limits, intervals — live
                  there as plain TS constants. Edit, redeploy, done. No env-var roulette.
                </>
              }
            />
            <Step
              n={7}
              title="Verify end-to-end"
              body={
                <>
                  <code className="code">force-mint --quantity 0.1 --direction up</code> (Sui),{' '}
                  <code className="code">force-poly-trade --usdc 0.5</code> (Polygon),{' '}
                  <code className="code">force-hl-trade --size 0.0001 --side short --round-trip</code>{' '}
                  (HL). Each is a single-tx flush that proves the wallet, the API auth, and the bot's
                  parser are all wired correctly.
                </>
              }
            />
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code className="h-4 w-4 text-accent" /> Repo layout
          </CardTitle>
          <p className="text-xs text-muted mt-1">
            Three packages in a pnpm workspace; docs at the root.
          </p>
        </CardHeader>
        <CardContent>
          {/* Was a single <pre> with the path on the left and the description
              tab-aligned on the right — looked tidy at desktop width and
              collapsed to a horizontal scroll soup at narrow widths.
              Replaced with a two-column responsive list: path on top,
              description below at narrow widths; side-by-side from sm up. */}
          <dl className="divide-y divide-border/60 text-sm">
            <RepoNode path="packages/svx-bot/" body="Trading bot — TypeScript, Node 18+, runs both networks." />
            <RepoNode path="    src/tunables.ts" body="All strategy knobs as plain TS constants." indent />
            <RepoNode path="    src/config.ts" body="Env-driven gates + zod validation." indent />
            <RepoNode path="    src/index.ts" body="Main loop + IV-RV ticker + margin-lever ticker." indent />
            <RepoNode path="    src/pricing/{svi,svi-arb,bs,…}" body="SVI eval, arb-free checker, BS binary, IV inversion." indent />
            <RepoNode path="    src/signal/{match,spread,filter}" body="Cross-venue spread + filters." indent />
            <RepoNode path="    src/exec/{ptb,risk,sizer,polymarket-client,hyperliquid-client,deepbook-margin-client,iron-bank-client}" body="Order construction + risk gates for all four venues." indent />
            <RepoNode path="    src/ledger/store.ts" body="SQLite + additive migrations." indent />
            <RepoNode path="    src/strategy/convergence.ts" body="Expiry-convergence: deep-ITM BTC dailies in the final hour, sigma-gated." indent />
            <RepoNode path="    src/strategy/vol-arb.ts" body="CUT 2026-07 (perps have no vega) — ticker survives as the RV sampler." indent />
            <RepoNode path="    src/strategy/margin-lever.ts" body="Paper-mode Predict × deepbook_margin × iron_bank composition. Off by default." indent />
            <RepoNode path="    src/api/server.ts" body="Read-only HTTP for the dashboard." indent />
            <RepoNode path="    scripts/" body="Operator scripts (setup, force-*, redeem, generate-wallet)." indent />
            <RepoNode path="    tests/" body="Vitest — 150+ tests covering math vectors + integration paths." indent />
            <RepoNode path="packages/svx-dashboard/" body="This site. Next.js 14 (app router), static-exportable for Walrus." />
            <RepoNode path="    app/{,overview,signals,positions,poly-arb,vol-arb,margin-lever,wallets,surface,about}/" body="One route per page; network-aware via header toggle." indent />
            <RepoNode path="    components/" body="PageIntro, OperatorBanner, StatRow, SurfaceArbPanel, SviHistoryChart, charts." indent />
            <RepoNode path="    lib/" body="API client, network context, polling hook." indent />
            <RepoNode path="    ws-resources.json" body="Walrus Sites routing + cache headers." indent />
            <RepoNode path="packages/svx-shared/" body="Types + addresses + constants." />
            <RepoNode path="docs/" body="Runbooks, strategy spec, math validation, Coolify deploy notes." />
          </dl>
        </CardContent>
      </Card>

      <footer className="text-xs text-muted font-mono flex items-center gap-4">
        <a
          className="inline-flex items-center gap-1.5 hover:text-accent"
          href="https://github.com/Econmartin/svx"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowSquareOut className="h-3.5 w-3.5" />
          github.com/Econmartin/svx
        </a>
        <a
          className="inline-flex items-center gap-1.5 hover:text-accent"
          href="https://docs.sui.io/onchain-finance/deepbook-predict/"
          target="_blank"
          rel="noreferrer"
        >
          <ArrowSquareOut className="h-3.5 w-3.5" />
          DeepBook Predict docs
        </a>
      </footer>
    </div>
  );
}

function Requirement({ req, evidence }: { req: string; evidence: React.ReactNode }) {
  return (
    <div className="rounded border border-border bg-surface-elevated/30 p-3">
      <div className="flex items-start gap-2">
        <span aria-hidden className="text-accent font-mono text-xs mt-0.5">✓</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-fg">{req}</div>
          <p className="text-muted text-[13px] leading-relaxed mt-1">{evidence}</p>
        </div>
      </div>
    </div>
  );
}

function Venue({
  name,
  subtitle,
  body,
  tone,
}: {
  name: string;
  subtitle: string;
  body: string;
  tone: 'accent' | 'loss' | 'warn';
}) {
  const accentCls =
    tone === 'accent'
      ? 'border-l-accent'
      : tone === 'loss'
        ? 'border-l-loss'
        : 'border-l-warn';
  return (
    <Card className={`border-l-4 ${accentCls}`}>
      <CardHeader className="pb-1.5 flex flex-row items-baseline gap-3 space-y-0">
        <div className="text-base font-semibold tracking-tight">{name}</div>
        <div className="text-[11px] text-muted uppercase tracking-wider font-medium">
          {subtitle}
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted leading-relaxed">{body}</p>
      </CardContent>
    </Card>
  );
}

function SpecRow({
  req,
  built,
  stretch,
}: {
  req: string;
  built: string;
  stretch?: boolean;
}) {
  return (
    <tr className="align-top">
      <td className="py-2.5 pr-3 text-sm">
        <div className="flex items-start gap-2">
          {stretch && <Badge variant="warn" className="text-[10px] mt-0.5">stretch</Badge>}
          <span>{req}</span>
        </div>
      </td>
      <td className="py-2.5 text-sm text-muted">{built}</td>
    </tr>
  );
}

function Limitation({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex-shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full bg-warn/70" />
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-muted mt-0.5">{body}</div>
      </div>
    </li>
  );
}

function Criterion({
  weight,
  label,
  body,
}: {
  weight: string;
  label: string;
  body: string;
}) {
  return (
    <div className="flex gap-3">
      <Badge variant="outline" className="font-mono text-[10px] h-fit mt-0.5 flex-shrink-0">
        {weight}
      </Badge>
      <div className="flex-1">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-muted text-sm mt-0.5">{body}</div>
      </div>
    </div>
  );
}

function RepoNode({
  path,
  body,
  indent,
}: {
  path: string;
  body: string;
  /** Nested entry — left padding only kicks in at sm+ so the path stays
   *  readable on narrow viewports without artificial whitespace eating
   *  the line. */
  indent?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-4 gap-y-0.5 py-1.5 ${
        indent ? 'sm:pl-4' : ''
      }`}
    >
      <code className="font-mono text-[12px] text-fg/85 whitespace-pre-wrap break-all">
        {path.trimStart()}
      </code>
      <span className="text-[12.5px] text-muted leading-snug">{body}</span>
    </div>
  );
}

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex-shrink-0 w-6 h-6 rounded-full bg-surface-elevated text-accent text-xs font-mono flex items-center justify-center">
        {n}
      </span>
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-muted mt-0.5">{body}</div>
      </div>
    </li>
  );
}
