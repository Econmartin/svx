import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ExternalLink, Workflow, ShieldCheck, GitBranch } from 'lucide-react';

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
