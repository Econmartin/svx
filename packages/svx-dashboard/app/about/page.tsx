import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Workflow, ShieldCheck, GitBranch, Target, Trophy, Code2, Wrench } from 'lucide-react';

export default function AboutPage() {
  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-3">
          About SVX
          <Badge variant="outline">Sui Overflow 2026</Badge>
        </h1>
        <p className="text-muted text-sm mt-2 leading-relaxed">
          SVX is a fully-automated cross-venue volatility arbitrage bot for the
          DeepBook Predict track. It captures pricing disagreements between
          Predict's continuous SVI surface and Polymarket's discrete-strike
          order book, then delta-hedges the residual exposure on Hyperliquid.
          Three venues, one bot, pure-vol PnL.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Venue
          name="DeepBook Predict"
          subtitle="Pricing brain"
          body="SVI-parameterized vol surface gives the continuous fair probability for every BTC strike. On testnet we also execute against the surface directly with dUSDC; on mainnet (pending Sui mainnet) we use Predict only as our quote engine."
          tone="accent"
        />
        <Venue
          name="Polymarket"
          subtitle="Real-money execution"
          body="Live on Polygon mainnet. The bot buys Yes/No outcome shares when Predict's fair value disagrees with Polymarket's book by > threshold (default 3pp). Auto-redeems winning shares via the NegRiskAdapter once UMA settles."
          tone="loss"
        />
        <Venue
          name="Hyperliquid"
          subtitle="Delta hedge"
          body="Every Polymarket fill triggers a delta-sized BTC perp on Hyperliquid — short when we bought Yes, long when we bought No. Closes on settlement. Strips directional BTC exposure from the strategy."
          tone="warn"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-4 w-4 text-accent" /> How it works
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
              title="Delta-sized HL hedge"
              body={
                <>
                  Compute <code className="code">|Δ| = φ(d₂) / (S · √w)</code> at the matched strike + Poly expiry. Open
                  a BTC perp of size <code className="code">|Δ| × shares</code> on the opposite side. Risk gates: per-trade cap,
                  total exposure cap, daily HL-loss limit.
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
              (separate dUSDC / pUSD / HL stacks), staleness checks, book-depth
              floor, consecutive-loss circuit breaker, filesystem kill switch.
              Auto-pauses on breach; resume is explicit operator action.
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
                  built="Every Polymarket fill triggers a binary-delta-sized BTC perp on the opposite side. PnL becomes pure-vol edge instead of directional bet."
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
                  → bridge into HL via app.hyperliquid.xyz Portfolio → Deposit (geofenced — VPN
                  needed for the bridge step only).
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
            <Code2 className="h-4 w-4 text-accent" /> Repo layout
          </CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs font-mono leading-relaxed text-muted overflow-x-auto">
{`packages/
  svx-bot/                     Trading bot (TS, Node 18+)
    src/
      tunables.ts              All strategy knobs as plain TS constants
      config.ts                Env-driven gates + zod validation
      index.ts                 Main loop + vol-arb fast ticker
      pricing/{svi,bs,...}     Math: SVI eval, BS binary, IV inversion
      signal/{match,spread,filter}  Cross-venue spread + filters
      exec/{ptb,risk,sizer,polymarket-client,hyperliquid-client}
      ledger/store.ts          SQLite + additive migrations
      strategy/vol-arb.ts      Standalone HL vol-divergence strategy
      api/server.ts            Read-only HTTP for dashboard
    scripts/                   Operator scripts (setup, force-*, redeem)
    tests/                     Vitest, 146 tests

  svx-dashboard/               Next.js 14 (app router)
    app/{,signals,positions,vol-arb,wallets,surface,about}/
    components/{HealthPanel,PnlChart,...}
    lib/{api,network-context,usePolling}

  svx-shared/                  Types + addresses + constants

docs/                          Runbooks, strategy spec, math validation`}
          </pre>
        </CardContent>
      </Card>

      <footer className="text-xs text-muted font-mono flex items-center gap-4">
        <a
          className="inline-flex items-center gap-1.5 hover:text-accent"
          href="https://github.com/Econmartin/svx"
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          github.com/Econmartin/svx
        </a>
        <a
          className="inline-flex items-center gap-1.5 hover:text-accent"
          href="https://docs.sui.io/onchain-finance/deepbook-predict/"
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          DeepBook Predict docs
        </a>
      </footer>
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
      <CardHeader className="pb-1">
        <div className="text-xs uppercase tracking-wider text-muted">{subtitle}</div>
        <div className="text-base font-semibold">{name}</div>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted leading-relaxed">{body}</p>
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
