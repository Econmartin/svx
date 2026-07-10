'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { useApiClient, useNetwork } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import { formatUsdc, formatPct, type CalibrationReport } from '@/lib/api';
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
  const fetchCalibration = useCallback(
    () => client.calibration(0.08).catch(() => null as CalibrationReport | null),
    [client],
  );
  const { data: calibration } = usePolling(fetchCalibration, 60_000);

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

      <section aria-label="The build, in order" className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-[20px] font-semibold tracking-tight flex items-center gap-2">
            <ChartLineUp className="h-5 w-5 text-accent" />
            The build, in order — and what each step proved
          </h2>
          <p className="text-muted text-sm max-w-3xl">
            This is the demo path. Every claim below links to a live page where you can verify
            it yourself; nothing is a slide.
          </p>
        </div>

        <ol className="space-y-3">
          <JourneyStep
            n={1}
            href="/surface"
            badge={{ label: 'LIVE', variant: 'live' }}
            title="Build the pricing brain"
            body="Back-solve Predict's implied vol from the on-chain SVI surface, reprice every strike at any expiry, and run an arbitrage-free checker (butterfly violations) on the live surface. The /surface page streams it in real time."
          />
          <JourneyStep
            n={2}
            href="/poly-arb"
            badge={{ label: 'LIVE · REAL MONEY', variant: 'warn' }}
            title="Trade the surface against Polymarket — with real money"
            body="When Predict and Polymarket disagree, buy the cheap side on the Polygon-mainnet CLOB. Real fills, UMA settlement detection, on-chain auto-redeem, and a wallet-vs-ledger reconciliation invariant that pauses trading on unexplained cent-level drift."
          />
          <JourneyStep
            n={3}
            href="/vol-arb"
            badge={{ label: 'CUT — POST-MORTEM', variant: 'outline' }}
            title="Kill what real money disproved"
            body="The IV−RV perp strategy paid $29.12 in fees for −$1.80 of direction PnL over 5,219 fills (a perp has no vega) — reconciled to the cent and hard-disabled in code. The delta hedge and the margin-lever signal got the same treatment: measured, documented, switched off. The post-mortems live on their pages."
          />
          <JourneyStep
            n={4}
            href="/divergence-mint"
            badge={{ label: 'THE FINDING', variant: 'outline' }}
            title="Measure the SVI feeder itself"
            body="The brief calls this bot 'a live stress test of the SVI feeder' — so we ran the test. Against every recorded oracle settlement, Predict's favorite is well-calibrated above 90¢ but systematically UNDERCONFIDENT below it — and the gap concentrates exactly where Polymarket disagrees:"
            extra={<CalibrationExhibit report={calibration ?? null} />}
          />
          <JourneyStep
            n={5}
            href="/divergence-mint"
            badge={{ label: 'LIVE ON TESTNET · MAINNET-DAY-ONE', variant: 'live' }}
            title="Ship the strategy that finding implies"
            body="Divergence-mint: when the venues disagree by ≥8pp, mint Predict's favorite via predict::mint and redeem permissionlessly at settlement. 94% win rate / +11.9% ROI on May data, 93.5% / +11.5% on July data — two disjoint windows, reproducible from this bot's own ledger via GET /backtest. Live with dUSDC on testnet now; Predict Sui-mainnet launch day is an address swap and one config flip."
          />
        </ol>
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

function JourneyStep({
  n,
  href,
  badge,
  title,
  body,
  extra,
}: {
  n: number;
  href: string;
  badge: { label: string; variant: 'live' | 'warn' | 'outline' };
  title: string;
  body: string;
  extra?: React.ReactNode;
}) {
  return (
    <li className="rounded-xl border border-border bg-surface/40 p-5">
      <div className="flex items-start gap-4">
        <span
          aria-hidden
          className="flex-shrink-0 w-7 h-7 rounded-full bg-surface-elevated text-accent text-sm font-mono flex items-center justify-center mt-0.5"
        >
          {n}
        </span>
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={href}
              className="group inline-flex items-center gap-1.5 no-underline"
            >
              <h3 className="text-[15px] font-semibold tracking-tight text-fg group-hover:text-accent transition-colors">
                {title}
              </h3>
              <ArrowRight className="h-4 w-4 text-muted group-hover:text-accent group-hover:translate-x-0.5 transition-transform" />
            </Link>
            <Badge variant={badge.variant} className="text-[10px]">
              {badge.label}
            </Badge>
          </div>
          <p className="text-sm text-muted leading-relaxed max-w-3xl">{body}</p>
          {extra}
        </div>
      </div>
    </li>
  );
}

/**
 * Live quoted-vs-realized table for Predict's favorite — recomputed by the
 * bot from its own ledger on every load (GET /calibration). Renders nothing
 * until the endpoint responds so the landing page never blocks on it.
 */
function CalibrationExhibit({ report }: { report: CalibrationReport | null }) {
  if (!report || report.all.n === 0) return null;
  const rows = report.all.buckets.filter((b) => b.n > 0);
  const div = report.divergent;
  return (
    <div className="mt-2 space-y-2">
      <div className="overflow-x-auto">
        <table className="text-xs font-mono tabular-nums border-separate border-spacing-x-4 border-spacing-y-0.5">
          <thead>
            <tr className="text-muted uppercase tracking-wider text-[10px]">
              <th className="text-left font-medium">Quoted band</th>
              <th className="text-right font-medium">n</th>
              <th className="text-right font-medium">Avg quoted</th>
              <th className="text-right font-medium">Realized</th>
              <th className="text-right font-medium">Gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.lo}>
                <td>{Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}¢</td>
                <td className="text-right">{b.n}</td>
                <td className="text-right">{b.avg_quoted != null ? `${(b.avg_quoted * 100).toFixed(1)}¢` : '—'}</td>
                <td className="text-right">{b.realized != null ? `${(b.realized * 100).toFixed(1)}%` : '—'}</td>
                <td
                  className={`text-right ${
                    b.gap_pp != null && b.gap_pp > 0.02
                      ? 'text-win'
                      : b.gap_pp != null && b.gap_pp < -0.02
                        ? 'text-loss'
                        : 'text-muted'
                  }`}
                >
                  {b.gap_pp != null
                    ? `${b.gap_pp >= 0 ? '+' : ''}${(b.gap_pp * 100).toFixed(1)}pp`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted leading-relaxed max-w-3xl">
        {div.n > 0 && div.avg_quoted != null && div.realized != null && (
          <>
            At ≥{Math.round(report.divergence_threshold * 100)}pp divergence from Polymarket the
            gap widens: quoted {(div.avg_quoted * 100).toFixed(0)}¢ avg, realized{' '}
            {(div.realized * 100).toFixed(0)}% ({div.wins}/{div.n}).{' '}
          </>
        )}
        {report.all.n.toLocaleString()} deduped settled observations,{' '}
        {report.data_window.firstTsIso?.slice(0, 10)} → {report.data_window.lastTsIso?.slice(0, 10)}.
        Verify: <code className="code">GET /calibration</code> on either bot.
      </p>
    </div>
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
