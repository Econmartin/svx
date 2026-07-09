'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useApiClient, useNetwork } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import { formatUsdc, formatPct } from '@/lib/api';
import { Hero } from '@/components/landing/Hero';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowRight,
  ArrowSquareOut,
  ChartLineUp,
  Cube,
  GitFork,
  Lightning,
  Pulse,
  ShieldCheck,
  Terminal,
} from '@phosphor-icons/react';

export default function LandingPage() {
  const client = useApiClient();
  const { network } = useNetwork();
  const fetchStatus = useCallback(() => client.status(), [client]);
  const { data: status } = usePolling(fetchStatus, 15_000);

  const isMainnet = network === 'mainnet';
  const combinedPnl = isMainnet
    ? status?.realizedCombinedPnlUsdc ??
      ((status?.realizedPolyPnlUsdc ?? 0) + (status?.realizedHlPnlUsdc ?? 0))
    : status?.realizedPnlUsdc ?? 0;
  const pnl24h = isMainnet
    ? status?.realizedCombinedPnl24hUsdc ?? 0
    : status?.realizedPnl24hUsdc ?? 0;
  const tradesLast24h = status?.tradesLast24h;
  const signalsLast24h = status?.signalsLast24h;

  return (
    <div className="space-y-10 -mt-4 sm:-mt-2">
      <Hero
        network={network}
        combinedPnl={combinedPnl}
        pnl24h={pnl24h}
        tradesLast24h={tradesLast24h}
        signalsLast24h={signalsLast24h}
        paused={!!status?.paused}
        liveOnSelectedNetwork={
          isMainnet ? !!status?.polyExecutionEnabled : !!status?.liveTradingEnabled
        }
      />

      <section aria-label="What it is" className="space-y-3">
        <h2 className="text-[20px] font-semibold tracking-tight flex items-center gap-2">
          <Pulse className="h-5 w-5 text-accent" />
          What SVX is
        </h2>
        <p className="text-fg/85 leading-relaxed max-w-3xl">
          A single-operator, fully-automated cross-venue volatility-arbitrage
          bot for the Sui Overflow DeepBook Predict track. It uses Predict's
          SVI surface as a pricing brain, takes the opposing side on
          Polymarket when the implied probabilities disagree, and samples
          realized vol from Hyperliquid's BTC perp to gate the
          expiry-convergence strategy. The delta-hedge leg was built,
          exercised on mainnet, and disabled after the 2026-07 audit (it
          sized delta at the oracle expiry). Three venues, one bot.
        </p>
        <p className="text-muted text-sm max-w-3xl">
          The dashboard you're on is a read-only window onto the operator's
          live bot. There is no signup, no wallet-connect, no deposit — the
          single-operator architecture is intentional and is what keeps SVX
          out of securities-law territory until the post-audit vault phase.
        </p>
      </section>

      <section aria-label="Three pillars" className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Pillar
            icon={<Cube className="h-5 w-5 text-accent" />}
            title="Pricing brain"
            kicker="DeepBook Predict (testnet)"
            body="SVI-parameterised vol surface gives the fair probability for every BTC strike, continuously. The bot back-solves IV, reprices at any expiry, and uses it as the source of truth for every signal."
          />
          <Pillar
            icon={<Lightning className="h-5 w-5 text-warn" />}
            title="Real-money execution"
            kicker="Polymarket (Polygon mainnet)"
            body="When Predict and Polymarket disagree by more than the spread threshold, SVX buys the cheap side via the Polymarket CLOB. Auto-redeems winning shares on settlement."
          />
          <Pillar
            icon={<ShieldCheck className="h-5 w-5 text-loss" />}
            title="Realized-vol engine"
            kicker="Hyperliquid perps (mainnet)"
            body="A 2s BTC perp mid ticker feeds trailing realized vol into the convergence strategy's sigma gate. The delta-hedge leg was built and exercised, then disabled after the 2026-07 audit found it mis-sized at the oracle expiry."
          />
        </div>
      </section>

      <section aria-label="Quick links" className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <DeepLinkCard
            href="/overview"
            icon={<ChartLineUp className="h-5 w-5 text-accent" />}
            title="Live overview"
            body="Cumulative PnL, open positions, health panel, recent signals — the operator's dashboard."
          />
          <DeepLinkCard
            href="/about"
            icon={<Cube className="h-5 w-5 text-accent" />}
            title="How it works"
            body="Full breakdown: SVI math, signal pipeline, risk gates, two-network architecture, judging-criteria mapping."
          />
        </div>
      </section>

      <section
        aria-label="Run your own"
        className="space-y-4 rounded-2xl border border-border bg-surface/40 p-6 md:p-8"
      >
        <div className="flex flex-wrap items-center gap-3">
          <GitFork className="h-5 w-5 text-accent" />
          <h2 className="text-[20px] font-semibold tracking-tight">
            Run your own SVX
          </h2>
          <Badge variant="outline" className="text-[10px]">single-operator · MIT</Badge>
        </div>
        <p className="text-fg/85 leading-relaxed max-w-3xl">
          The whole stack is open source. One{' '}
          <code className="code">git clone</code> and one Docker Compose up
          stands up a copy that trades <em>your</em> wallet — not anybody
          else's. The more independent SVX instances run, the tighter
          Predict's surface stays calibrated against external venues. That's
          exactly the "live stress test of the SVI feeder" the spec calls for.
        </p>
        <ol className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <SetupStep
            n={1}
            title="Clone + install"
            body={
              <>
                <code className="code">
                  git clone github.com/Econmartin/svx &amp;&amp; pnpm install
                </code>
              </>
            }
          />
          <SetupStep
            n={2}
            title="Generate operator wallets"
            body={
              <>
                One keypair per venue:{' '}
                <code className="code">setup-manager</code> (Sui),{' '}
                <code className="code">generate-poly-wallet</code> (Polygon),{' '}
                <code className="code">generate-hl-wallet</code> (HL).
              </>
            }
          />
          <SetupStep
            n={3}
            title="Fund + tune"
            body={
              <>
                Faucet dUSDC, bridge pUSD + HL USDC. Edit thresholds in{' '}
                <code className="code">tunables.ts</code>. No env-var roulette.
              </>
            }
          />
          <SetupStep
            n={4}
            title="docker compose up"
            body={
              <>
                Spins the bot + dashboard. Trades fire automatically inside
                your configured risk gates.
              </>
            }
          />
        </ol>
        <div className="flex flex-wrap gap-2 pt-1">
          <a
            href="https://github.com/Econmartin/svx"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 h-9 rounded-md bg-accent text-bg font-semibold text-sm px-4 hover:bg-accent/90 transition-colors no-underline"
          >
            <Terminal className="h-4 w-4" />
            View on GitHub
            <ArrowSquareOut className="h-3.5 w-3.5" />
          </a>
          <Link
            href="/about"
            className="inline-flex items-center gap-2 h-9 rounded-md border border-border-strong bg-surface-elevated/60 text-fg font-semibold text-sm px-4 hover:bg-surface-elevated transition-colors no-underline"
          >
            Full walkthrough
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="text-xs text-muted font-mono flex flex-wrap items-center gap-4 pt-2">
        <span>SVX — Sui Overflow 2026</span>
        <span aria-hidden>·</span>
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

function Pillar({
  icon,
  title,
  kicker,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  kicker: string;
  body: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-1.5 space-y-1">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-[15px]">{title}</CardTitle>
        </div>
        <div className="text-[11px] uppercase tracking-wider text-muted font-medium">
          {kicker}
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted leading-relaxed">{body}</p>
      </CardContent>
    </Card>
  );
}

function DeepLinkCard({
  href,
  icon,
  title,
  body,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-xl border border-border bg-surface/40 hover:bg-surface/70 hover:border-border-strong p-5 transition-colors no-underline"
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">{icon}</div>
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold tracking-tight text-fg">
              {title}
            </h3>
            <ArrowRight className="h-4 w-4 text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-transform" />
          </div>
          <p className="text-sm text-muted leading-relaxed">{body}</p>
        </div>
      </div>
    </Link>
  );
}

function SetupStep({
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
      <span
        aria-hidden
        className="flex-shrink-0 w-6 h-6 rounded-full bg-surface-elevated text-accent text-xs font-mono flex items-center justify-center"
      >
        {n}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-fg">{title}</div>
        <div className="text-muted text-[13px] leading-relaxed mt-0.5">
          {body}
        </div>
      </div>
    </li>
  );
}
