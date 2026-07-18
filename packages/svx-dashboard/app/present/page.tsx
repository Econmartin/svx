'use client';

/**
 * /present — the 5-minute demo-day deck, as part of the live site.
 *
 * Seven full-screen slides in the judging brief's required order:
 * problem/solution/value → technical → path to production → users/PMF →
 * monetization/roadmap → why Sui → close. Arrow keys, space, or click to
 * advance; Escape returns to the first slide.
 *
 * Deliberately simple: mostly static text the presenter can stand behind,
 * plus a few numbers fetched live from the running bots (marked with a
 * green dot). Every live fetch has a documented fallback value so a dead
 * network can never blank a slide mid-talk.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, apiMainnet } from '@/lib/api';

/** Live numbers with safe fallbacks (the documented values). */
interface LiveNumbers {
  live: boolean;
  calibQuoted: string; // avg quoted favorite price, sub-90c bands
  calibRealized: string; // realized win rate for those bands
  calibN: string;
  backtestWin: string;
  backtestRoi: string;
  polyFills: string;
  polyWinRate: string;
}

const FALLBACK: LiveNumbers = {
  live: false,
  calibQuoted: '87 cents',
  calibRealized: '98 percent',
  calibN: '46',
  backtestWin: '94 percent',
  backtestRoi: '+12 percent',
  polyFills: '386',
  polyWinRate: '82 percent',
};

function useLiveNumbers(): LiveNumbers {
  const [n, setN] = useState<LiveNumbers>(FALLBACK);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [calib, bt, closedPoly] = await Promise.all([
          api.calibration(0.08),
          api.backtest({ threshold: 0.08, side: 'favored', dedupe: true, fee: 0.02 }),
          apiMainnet.enabled ? apiMainnet.positionsClosedPoly(5000) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const settledPoly = closedPoly.filter(
          (t) => t.polySettled && t.polyPnlUsdc != null && t.polyCostUsdc,
        );
        const polyWins = settledPoly.filter((t) => (t.polyPnlUsdc ?? 0) > 0).length;
        setN({
          live: true,
          calibQuoted:
            calib.all.avg_quoted != null
              ? `${Math.round(calib.all.avg_quoted * 100)} cents`
              : FALLBACK.calibQuoted,
          calibRealized:
            calib.all.realized != null
              ? `${(calib.all.realized * 100).toFixed(0)} percent`
              : FALLBACK.calibRealized,
          calibN: String(calib.all.n || FALLBACK.calibN),
          backtestWin:
            bt.win_rate != null ? `${(bt.win_rate * 100).toFixed(0)} percent` : FALLBACK.backtestWin,
          backtestRoi:
            bt.roi != null
              ? `${bt.roi >= 0 ? '+' : ''}${(bt.roi * 100).toFixed(0)} percent`
              : FALLBACK.backtestRoi,
          polyFills: settledPoly.length ? String(settledPoly.length) : FALLBACK.polyFills,
          polyWinRate: settledPoly.length
            ? `${Math.round((polyWins / settledPoly.length) * 100)} percent`
            : FALLBACK.polyWinRate,
        });
      } catch {
        /* keep fallbacks — the slide must never blank */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return n;
}

function Big({ children }: { children: React.ReactNode }) {
  return <span className="text-accent font-semibold">{children}</span>;
}

function LiveDot({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ml-2 align-middle ${on ? 'bg-accent' : 'bg-muted/40'}`}
      title={on ? 'fetched live from the running bot' : 'documented value (live fetch unavailable)'}
    />
  );
}

export default function PresentPage() {
  const n = useLiveNumbers();
  const [i, setI] = useState(0);

  const slides: Array<{ tag: string; body: React.ReactNode }> = [
    // ── 1. Problem / Solution / Value ──
    {
      tag: 'Problem · Solution · Value',
      body: (
        <div className="space-y-8">
          <h1 className="text-5xl font-semibold tracking-tight leading-tight">
            SVX <span className="text-muted font-normal">— Surface Volatility Executor</span>
          </h1>
          <p className="text-2xl leading-relaxed max-w-4xl">
            A protocol can price every strike off a live volatility surface.
            <br />
            But a protocol is not yet a <Big>market</Big>.
          </p>
          <div className="grid grid-cols-3 gap-6 max-w-4xl text-xl">
            <div className="rounded-xl border border-border p-5">
              <div className="text-muted text-sm uppercase tracking-wider mb-2">Markets need</div>
              professional participants who trade mispricings away
            </div>
            <div className="rounded-xl border border-border p-5">
              <div className="text-muted text-sm uppercase tracking-wider mb-2">Markets need</div>
              independent verification that prices are honest
            </div>
            <div className="rounded-xl border border-border p-5">
              <div className="text-muted text-sm uppercase tracking-wider mb-2">Markets need</div>
              tooling that survives real production conditions
            </div>
          </div>
          <p className="text-2xl max-w-4xl">
            SVX is all three — <Big>Predict&apos;s first independent trading desk, external
            auditor, and infrastructure monitor</Big>. Live today.
          </p>
        </div>
      ),
    },
    // ── 1b. The proof (value) ──
    {
      tag: 'The proof',
      body: (
        <div className="space-y-8">
          <h2 className="text-4xl font-semibold tracking-tight">
            We measured the surface against reality
          </h2>
          <p className="text-2xl leading-relaxed max-w-4xl">
            Across <Big>{n.calibN} settled oracles</Big>
            <LiveDot on={n.live} /> — no model of ours in the loop — Predict&apos;s favorites
            quoted at an average of <Big>{n.calibQuoted}</Big> actually won{' '}
            <Big>{n.calibRealized}</Big> of the time.
          </p>
          <p className="text-2xl leading-relaxed max-w-4xl">
            The surface is systematically <Big>underconfident below ninety cents</Big> — and
            DeepBook&apos;s own public pre-deployment audit tracks the same finding as open items
            P-2 and O-1.
          </p>
          <p className="text-xl text-muted max-w-4xl">
            We found it from the outside with live trading. Their auditors found it from the
            inside. Same conclusion — that is what an independent market participant is for.
          </p>
          <p className="text-sm text-muted font-mono">
            verify: svx-testnet.econmartin.xyz/calibration
          </p>
        </div>
      ),
    },
    // ── 2. Technical implementation ──
    {
      tag: 'Technical implementation',
      body: (
        <div className="space-y-8">
          <h2 className="text-4xl font-semibold tracking-tight">Three venues, one risk stack</h2>
          <div className="grid grid-cols-3 gap-6 max-w-5xl text-xl">
            <div className="rounded-xl border border-border p-5">
              <div className="text-accent text-sm uppercase tracking-wider mb-2">
                Predict (testnet)
              </div>
              The pricing brain. We solve implied vol from the on-chain surface and mint live —
              binaries <em>and</em> range ladders, settled and redeemed on-chain.
            </div>
            <div className="rounded-xl border border-border p-5">
              <div className="text-warn text-sm uppercase tracking-wider mb-2">
                Polymarket (real money)
              </div>
              <Big>{n.polyFills} settled fills</Big>
              <LiveDot on={n.live} /> on Polygon mainnet at a{' '}
              <Big>{n.polyWinRate} win rate</Big>, every cent reconciled against the wallet.
            </div>
            <div className="rounded-xl border border-border p-5">
              <div className="text-muted text-sm uppercase tracking-wider mb-2">Hyperliquid</div>
              Realized-volatility feed. The delta hedge we built here was mis-sized — we measured
              it, published the post-mortem, and shut it off.
            </div>
          </div>
          <p className="text-2xl max-w-4xl leading-relaxed">
            Honest ledger: real-money net is <Big>minus seven dollars</Big> — plus six from the
            strategies, minus thirteen from the hedge experiment we killed.{' '}
            <span className="text-muted">We think showing you the minus thirteen is the point.</span>
          </p>
        </div>
      ),
    },
    // ── 3. Path to production ──
    {
      tag: 'Path to production',
      body: (
        <div className="space-y-7">
          <h2 className="text-4xl font-semibold tracking-tight">
            Mainnet day one is a config flip — proven three ways
          </h2>
          <ol className="space-y-5 text-2xl max-w-5xl list-none">
            <li>
              <Big>1.</Big> Every primitive we use — mint, permissionless redeem, ranges, LP
              supply — is confirmed in the audited, mainnet-bound package. We have already
              executed all of them on testnet.
            </li>
            <li>
              <Big>2.</Big> The strategy questions are pre-answered by simulation, as the track
              requires: range ladders work at <Big>half-sigma widths (+10 percent)</Big>; the
              LP-plus-insurance vault does <Big>not</Big> — and we published that NO with its
              numbers.
            </li>
            <li>
              <Big>3.</Big> The production migration already happened to us. Sui&apos;s RPC
              shutoff broke Predict&apos;s own indexer — the feed has been frozen since July 12.
              Our bot hit the same shutoff, <Big>we migrated within the hour</Big>, reported the
              outage to the team, and our feeder-lag kill switch has correctly refused
              forty-eight thousand signals a day since.
            </li>
          </ol>
          <p className="text-xl text-muted max-w-4xl">
            What mainnet opens: real economics on the Predict leg, the three-protocol margin loop
            becomes physically possible (today the protocols live on different networks — we have
            already built and simulated it), and multi-asset the day they list Ethereum.
          </p>
        </div>
      ),
    },
    // ── 4. Users & PMF ──
    {
      tag: 'Target users · product-market fit',
      body: (
        <div className="space-y-8">
          <h2 className="text-4xl font-semibold tracking-tight">Three users, in adoption order</h2>
          <div className="space-y-6 text-2xl max-w-5xl">
            <p>
              <Big>Today — the protocol team.</Big> Our calibration feed and infrastructure
              monitoring are the analytics the brief asked for. We are already, in practice,
              Predict&apos;s external test desk.
            </p>
            <p>
              <Big>At mainnet — operators.</Big> The whole stack is open source with a runbook.
              Every additional SVX instance is an independent arbitrageur pulling the surface
              toward truth — which is exactly how Predict&apos;s pricing becomes trustworthy
              enough for size.
            </p>
            <p>
              <Big>Later — LPs.</Big> Once audited, the vault phase wraps the validated
              strategies in tokenized shares.
            </p>
          </div>
          <p className="text-xl text-muted max-w-4xl">
            Why they adopt: quants go where there is measurable edge — and we published the
            measurement.
          </p>
        </div>
      ),
    },
    // ── 5. Monetization & roadmap ──
    {
      tag: 'Monetization · roadmap',
      body: (
        <div className="space-y-8">
          <h2 className="text-4xl font-semibold tracking-tight">
            Sustainability in three phases
          </h2>
          <div className="grid grid-cols-3 gap-6 max-w-5xl text-xl">
            <div className="rounded-xl border border-border p-5">
              <div className="text-accent text-sm uppercase tracking-wider mb-2">Phase 1 — now</div>
              The bot trades its own balance. The strategies fund the operation.
            </div>
            <div className="rounded-xl border border-border p-5">
              <div className="text-accent text-sm uppercase tracking-wider mb-2">
                Phase 2 — mainnet week one
              </div>
              Calibration feed + settled-redeem keeper as services. The keeper redeems other
              users&apos; winning positions for a tip — revenue from day one.
            </div>
            <div className="rounded-xl border border-border p-5">
              <div className="text-accent text-sm uppercase tracking-wider mb-2">
                Phase 3 — post-audit
              </div>
              The tokenized vault: LPs deposit, validated strategies run, on-chain economics
              anyone can audit.
            </div>
          </div>
          <p className="text-xl text-muted max-w-4xl">
            Deliberately no token and no pooled funds until audit and legal sign-off. That is a
            compliance choice, not a gap.
          </p>
        </div>
      ),
    },
    // ── 6. Why Sui + close ──
    {
      tag: 'Why Sui',
      body: (
        <div className="space-y-8">
          <h2 className="text-4xl font-semibold tracking-tight">This cannot be built elsewhere</h2>
          <ul className="space-y-5 text-2xl max-w-5xl list-none">
            <li>
              Predict is the <Big>only vol-surface-priced prediction protocol anywhere</Big> —
              and it exists because of Sui.
            </li>
            <li>
              <Big>Sub-second finality</Big> makes sub-hour option cycles real.
            </li>
            <li>
              The <Big>object model</Big> gives us a manager account we mint, settle, and redeem
              against programmatically.
            </li>
            <li>
              <Big>Programmable transaction blocks</Big> open an entire range ladder — or
              eventually the full three-protocol margin loop — atomically, in one transaction.
            </li>
          </ul>
          <div className="pt-6 border-t border-border max-w-5xl">
            <p className="text-3xl leading-relaxed">
              SVX: Predict&apos;s first independent trading desk, first external auditor, and
              first infrastructure monitor. <Big>Live today. Mainnet on day one.</Big>
            </p>
            <p className="text-xl text-muted mt-4 font-mono">svx.econmartin.xyz — everything verifiable now</p>
          </div>
        </div>
      ),
    },
  ];

  const next = useCallback(() => setI((v) => Math.min(v + 1, slides.length - 1)), [slides.length]);
  const prev = useCallback(() => setI((v) => Math.max(v - 1, 0)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') next();
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
      else if (e.key === 'Escape') setI(0);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev]);

  const slide = slides[i]!;

  return (
    <div
      className="fixed inset-0 z-50 bg-bg text-fg flex flex-col cursor-pointer select-none"
      onClick={(e) => {
        // click left third = back, elsewhere = forward
        const x = e.clientX / window.innerWidth;
        if (x < 0.33) prev();
        else next();
      }}
    >
      <div className="flex items-center justify-between px-10 pt-6 text-sm text-muted">
        <span className="uppercase tracking-widest">{slide.tag}</span>
        <span className="font-mono">
          {i + 1} / {slides.length}
        </span>
      </div>
      <div className="flex-1 flex items-center px-10 md:px-20">
        <div className="w-full">{slide.body}</div>
      </div>
      <div className="px-10 pb-6 flex items-center justify-between text-xs text-muted">
        <span>arrow keys or click to advance · Esc restarts</span>
        <Link
          href="/"
          onClick={(e) => e.stopPropagation()}
          className="hover:text-accent underline decoration-border"
        >
          exit to site
        </Link>
      </div>
    </div>
  );
}
