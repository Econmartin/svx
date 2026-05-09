export default function AboutPage() {
  return (
    <article className="prose prose-invert max-w-3xl space-y-4 text-[15px] leading-relaxed">
      <h1 className="text-2xl font-semibold">About SVX</h1>

      <p>
        SVX is a fully-automated cross-venue volatility arbitrage bot built for
        the DeepBook Predict track of Sui Overflow 2026. It exploits
        mispricings between DeepBook Predict&apos;s SVI-driven binary surface
        and the Polymarket BTC binary order book.
      </p>

      <h2 className="text-lg font-semibold mt-6">How it works</h2>
      <ol className="list-decimal pl-6 space-y-1.5 marker:text-muted">
        <li>
          Every loop iteration (default 15s), the bot pulls the active Predict
          BTC oracles and the live Polymarket strike markets via the public
          REST APIs.
        </li>
        <li>
          For each oracle it evaluates the SVI total-variance curve at the
          Polymarket strike: <code>w(k) = a + b · (ρ(k − m) + √((k − m)² + σ²))</code>,
          giving the probability <code>P(spot &gt; K)</code> via Black-Scholes
          binary pricing.
        </li>
        <li>
          It compares to Polymarket&apos;s order-book best bid/ask for the
          matching &ldquo;Yes&rdquo; outcome. Where the two disagree by more
          than the configured threshold (default 3 percentage points), there is
          a trade.
        </li>
        <li>
          Sized by fixed-fraction with hard caps. Every trade is gated through
          a risk module: per-trade size, daily loss limit, SVI staleness,
          Polymarket book sanity, position-count cap, consecutive-loss circuit
          breaker, and a manual kill switch backed by a filesystem flag.
        </li>
      </ol>

      <h2 className="text-lg font-semibold mt-6">Edge sources (and decay)</h2>
      <ul className="list-disc pl-6 space-y-1.5 marker:text-muted">
        <li>
          <strong>Polymarket-side stickiness.</strong> Polymarket order books
          update in human time; SVI updates faster. Most of the early edge is
          Predict&apos;s surface moving and Polymarket lagging.
        </li>
        <li>
          <strong>Oracle latency.</strong> If the Block Scholes feed lags spot,
          our IV inputs are wrong. Stale-data kill switch handles this.
        </li>
        <li>
          <strong>Slippage.</strong> Polymarket fills at order-book best ask,
          not mid. We always quote against the ask in live signals — paper
          PnL evaporates if you don&apos;t.
        </li>
        <li>
          <strong>Edge decay.</strong> Once SVX (or anyone else) starts trading
          this systematically on mainnet, spreads compress. That&apos;s
          expected and built into the strategy spec.
        </li>
      </ul>

      <h2 className="text-lg font-semibold mt-6">Safety posture</h2>
      <p>
        SVX is a single-operator trading bot. There are no users, no pooled
        funds, and no tokenized shares. The protocol is pre-mainnet; the bot
        runs paper-trading by default until an operator explicitly enables
        live execution and pins the operator-owned <code>PredictManager</code>{' '}
        ID. All risk controls are mandatory; there is no override.
      </p>

      <p className="text-muted text-sm mt-4">
        Source:{' '}
        <a
          className="underline hover:text-accent"
          href="https://github.com/MartinSWDev/SVX"
          target="_blank"
          rel="noreferrer"
        >
          github.com/MartinSWDev/SVX
        </a>
      </p>
    </article>
  );
}
