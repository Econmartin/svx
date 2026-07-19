'use client';

/**
 * Presenter — the demo-day flow as a site-wide overlay, interleaving
 * SLIDES with the LIVE PAGES themselves:
 *
 *   slide → slide → /surface → slide → /poly-arb (mainnet) → slide →
 *   /vaults → slide → slide → /divergence-mint → slide
 *
 * Entered ONLY by visiting /present (never via nav — casual visitors don't
 * see it). Arrow-Right/Left step through the sequence from anywhere;
 * Escape exits back to the normal site. On slide steps a full-screen
 * overlay covers the page; on page steps the overlay yields to the real
 * live page, navigates there automatically (auto-switching the network
 * toggle where the step needs it), and shows only a small corner chip with
 * the step counter and a "point at" note for the presenter.
 *
 * A few slide numbers fetch live from the running bots (green dot), each
 * with a documented fallback so a dead network can never blank the deck.
 */

import { useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, apiMainnet } from '@/lib/api';
import { useNetwork } from '@/lib/network-context';

const FLAG = 'svx-present-step';

// ── live numbers with safe fallbacks ────────────────────────────────────────

interface LiveNumbers {
  live: boolean;
  calibQuoted: string;
  calibRealized: string;
  calibN: string;
  polyFills: string;
  polyWinRate: string;
}

const FALLBACK: LiveNumbers = {
  live: false,
  calibQuoted: '86 cents',
  calibRealized: '100 percent',
  calibN: '24',
  polyFills: '388',
  polyWinRate: '81 percent',
};

function useLiveNumbers(active: boolean): LiveNumbers {
  const [n, setN] = useState<LiveNumbers>(FALLBACK);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    (async () => {
      try {
        const [calib, closedPoly] = await Promise.all([
          api.calibration(0.08),
          apiMainnet.enabled ? apiMainnet.positionsClosedPoly(5000) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const settled = closedPoly.filter(
          (t) => t.polySettled && t.polyPnlUsdc != null && t.polyCostUsdc,
        );
        const wins = settled.filter((t) => (t.polyPnlUsdc ?? 0) > 0).length;
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
          polyFills: settled.length ? String(settled.length) : FALLBACK.polyFills,
          polyWinRate: settled.length
            ? `${Math.round((wins / settled.length) * 100)} percent`
            : FALLBACK.polyWinRate,
        });
      } catch {
        /* keep fallbacks */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);
  return n;
}

// ── building blocks ─────────────────────────────────────────────────────────

function Big({ children }: { children: React.ReactNode }) {
  return <span className="text-accent font-semibold">{children}</span>;
}

function LiveDot({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ml-2 align-middle ${on ? 'bg-accent' : 'bg-muted/40'}`}
      title={on ? 'fetched live from the running bot' : 'documented value'}
    />
  );
}

type Step =
  | { kind: 'slide'; tag: string; body: (n: LiveNumbers) => React.ReactNode; network?: 'testnet' | 'mainnet' }
  | { kind: 'page'; href: string; note: string; network?: 'testnet' | 'mainnet' };

const STEPS: Step[] = [
  {
    kind: 'slide',
    tag: 'Problem · Solution · Value',
    network: 'testnet',
    body: () => (
      <div className="space-y-8">
        <h1 className="text-5xl font-semibold tracking-tight leading-tight">
          SVX <span className="text-muted font-normal">· Surface Volatility Executor</span>
        </h1>
        <p className="text-2xl leading-relaxed max-w-4xl">
          A trading bot for prediction markets, built on DeepBook Predict. A market needs three
          things a protocol cannot ship for itself:
        </p>
        <div className="grid grid-cols-3 gap-6 max-w-4xl text-xl">
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">1 · Traders</div>
            who trade mispricings away
          </div>
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">2 · Verification</div>
            that the prices are honest
          </div>
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">3 · Operations</div>
            that survive real outages
          </div>
        </div>
        <p className="text-2xl max-w-4xl">
          SVX is all three: <Big>one of the first outside desks on Predict</Big>. Live today.
        </p>
      </div>
    ),
  },
  {
    kind: 'slide',
    tag: 'The proof',
    body: (n) => (
      <div className="space-y-8">
        <h2 className="text-4xl font-semibold tracking-tight">
          We measured the surface against reality
        </h2>
        <p className="text-3xl leading-relaxed max-w-4xl">
          <Big>{n.calibN} settled oracles</Big>
          <LiveDot on={n.live} />: favorites quoted at <Big>{n.calibQuoted}</Big> won{' '}
          <Big>{n.calibRealized}</Big> of the time.
        </p>
        <p className="text-2xl leading-relaxed max-w-4xl text-muted">
          Predict prices its favorites too low. DeepBook&apos;s own audit tracks the same
          finding (P-2, O-1).
        </p>
        <p className="text-sm text-muted font-mono">next: the live bot, mid-outage →</p>
      </div>
    ),
  },
  {
    kind: 'page',
    href: '/overview',
    network: 'testnet',
    note: 'Point at: oracle STALE + last-update age; Signals 24h = 0; bankroll + realized PnL; the LIVE indicator. This is the kill switch working.',
  },
  {
    kind: 'slide',
    tag: 'Technical implementation',
    body: (n) => (
      <div className="space-y-8">
        <h2 className="text-4xl font-semibold tracking-tight">Three venues, one risk stack</h2>
        <div className="grid grid-cols-3 gap-6 max-w-5xl text-xl">
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">
              Predict (testnet)
            </div>
            The pricing brain. Mint, settle, redeem, live on-chain.
          </div>
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-warn text-sm uppercase tracking-wider mb-2">
              Polymarket (real money)
            </div>
            <Big>{n.polyFills} settled fills</Big>
            <LiveDot on={n.live} /> at a <Big>{n.polyWinRate} win rate</Big>,
            wallet-reconciled.
          </div>
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-muted text-sm uppercase tracking-wider mb-2">Hyperliquid</div>
            Realized-volatility feed.
          </div>
        </div>
        <p className="text-2xl max-w-4xl leading-relaxed">
          Real-money net: <Big>minus seven dollars</Big>. Plus six from what we kept, minus
          thirteen from what we killed.
        </p>
        <p className="text-sm text-muted font-mono">next: the real-money side, live →</p>
      </div>
    ),
  },
  {
    kind: 'page',
    href: '/poly-arb',
    network: 'mainnet',
    note: 'MAINNET auto-selected. Point at: settled trade rows with real PnL; mention the wallet-vs-ledger reconciliation.',
  },
  {
    kind: 'page',
    href: '/vol-arb',
    network: 'mainnet',
    note: 'The failure story. Point at: "Execution CUT by the 2026-07 audit" banner; $29.12 fees for −$1.80 over 5,219 fills; the 2s RV ticker still feeding convergence.',
  },
  {
    kind: 'slide',
    tag: 'Path to production',
    network: 'testnet',
    body: () => (
      <div className="space-y-7">
        <h2 className="text-4xl font-semibold tracking-tight">
          Mainnet day one is a config flip, proven three ways
        </h2>
        <ol className="space-y-6 text-2xl max-w-5xl list-none">
          <li>
            <Big>1.</Big> Every primitive is in the audited mainnet package. Binaries executed{' '}
            <Big>end to end on testnet</Big>.
          </li>
          <li>
            <Big>2.</Big> Vault ideas answered by simulation: ladders <Big>yes (+10%)</Big>,
            insurance <Big>no</Big>. Both published.
          </li>
          <li>
            <Big>3.</Big> Sui&apos;s RPC shutoff hit us and them. <Big>We migrated within the
            hour</Big>; their fix is merged.
          </li>
        </ol>
        <p className="text-xl text-muted max-w-4xl">
          Mainnet adds: real economics, the margin loop, multi-asset.
        </p>
        <p className="text-sm text-muted font-mono">next: the Predict-native strategy, live →</p>
      </div>
    ),
  },
  {
    kind: 'page',
    href: '/divergence-mint',
    network: 'testnet',
    note: 'Point at: both strategy bands (mint + harvest); the live replay card with its backtest label; result cards. (Tx digests are on /wallets if asked.)',
  },
  {
    kind: 'slide',
    tag: 'Who can use it',
    body: () => (
      <div className="space-y-8">
        <h2 className="text-4xl font-semibold tracking-tight">Who can use it</h2>
        <div className="space-y-6 text-2xl max-w-5xl">
          <p>
            <Big>The Predict and Sui teams.</Big> An independent bot exercising their protocol
            daily, reporting what it finds.
          </p>
          <p>
            <Big>Independent operators.</Big> Open source with a runbook. More operators,
            tighter prices.
          </p>
        </div>
        <p className="text-xl text-muted max-w-4xl">
          Today: one operator. The edge is published; that attracts the next one.
        </p>
      </div>
    ),
  },
  {
    kind: 'slide',
    tag: 'Monetization · roadmap',
    body: () => (
      <div className="space-y-8">
        <h2 className="text-4xl font-semibold tracking-tight">How it pays for itself</h2>
        <div className="grid grid-cols-3 gap-6 max-w-5xl text-xl">
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">Now</div>
            Trades its own balance, small on purpose. Winners fund the operation.
          </div>
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">Next</div>
            Scale positions, deeper analytics, more strategy checks.
          </div>
          <div className="rounded-xl border border-border/70 bg-white/[0.03] p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">
              Deliberately not
            </div>
            No token, no deposits, no pooled funds without audit and legal sign-off.
          </div>
        </div>
        <p className="text-sm text-muted font-mono">next: why Sui →</p>
      </div>
    ),
  },
  {
    kind: 'slide',
    tag: 'Why Sui',
    body: () => (
      <div className="space-y-8">
        <h2 className="text-4xl font-semibold tracking-tight">This cannot be built elsewhere</h2>
        <ul className="space-y-5 text-2xl max-w-5xl list-none">
          <li>
            The <Big>only prediction protocol we know of priced from a live vol surface</Big>.
          </li>
          <li>
            <Big>Sub-second finality</Big> makes sub-hour markets real.
          </li>
          <li>
            <Big>Objects</Big> we mint, settle, and redeem against in code.
          </li>
          <li>
            <Big>One atomic transaction</Big> opens an entire ladder of bets.
          </li>
        </ul>
        <div className="pt-6 border-t border-border max-w-5xl">
          <p className="text-3xl leading-relaxed">
            SVX: one of the first outside desks on Predict.{' '}
            <Big>Live today. Mainnet on day one.</Big>
          </p>
          <p className="text-xl text-muted mt-4 font-mono">svx.econmartin.xyz</p>
          <p className="text-sm text-muted font-mono mt-6">next: the live site →</p>
        </div>
      </div>
    ),
  },
  {
    kind: 'page',
    href: '/',
    network: 'testnet',
    note: 'The close: the live homepage. Leave it on screen for Q&A. Esc exits presenter mode.',
  },
];

// ── the presenter ───────────────────────────────────────────────────────────

export function Presenter() {
  const pathname = usePathname();
  const router = useRouter();
  const { setNetwork } = useNetwork();
  const [step, setStep] = useState<number | null>(null);

  // Activate when /present is visited; resume from sessionStorage otherwise.
  useEffect(() => {
    if (pathname === '/present') {
      const stored = Number(sessionStorage.getItem(FLAG));
      const s = Number.isFinite(stored) && sessionStorage.getItem(FLAG) !== null ? stored : 0;
      sessionStorage.setItem(FLAG, String(s));
      setStep(s);
    } else if (sessionStorage.getItem(FLAG) !== null) {
      setStep(Number(sessionStorage.getItem(FLAG)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const active = step !== null;
  const n = useLiveNumbers(active);

  const go = useCallback(
    (target: number) => {
      const clamped = Math.max(0, Math.min(target, STEPS.length - 1));
      sessionStorage.setItem(FLAG, String(clamped));
      setStep(clamped);
      const s = STEPS[clamped]!;
      if (s.network) setNetwork(s.network);
      if (s.kind === 'page' && pathname !== s.href) router.push(s.href);
    },
    [pathname, router, setNetwork],
  );

  const exit = useCallback(() => {
    sessionStorage.removeItem(FLAG);
    setStep(null);
    if (pathname === '/present') router.push('/');
  }, [pathname, router]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        go((step ?? 0) + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        go((step ?? 0) - 1);
      } else if (e.key === 'Escape') {
        exit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, step, go, exit]);

  if (!active || step === null) return null;
  const s = STEPS[step]!;

  // Page step: yield to the live page; show only the corner chip.
  if (s.kind === 'page') {
    return (
      <div className="fixed bottom-4 right-4 z-[60] max-w-sm rounded-xl border border-accent/40 bg-bg/95 backdrop-blur px-4 py-3 shadow-lg text-sm">
        <div className="flex items-center justify-between gap-4 mb-1">
          <span className="font-mono text-accent">
            {step + 1} / {STEPS.length} · live page
          </span>
          <span className="text-muted text-xs">← → to move · Esc exits</span>
        </div>
        <p className="text-muted leading-snug">{s.note}</p>
      </div>
    );
  }

  // Slide step: full-screen overlay above everything, styled to match the
  // landing hero (same charcoal gradient, accent glows, and masked grid).
  return (
    <div
      className="fixed inset-0 z-[60] text-fg flex flex-col cursor-pointer select-none"
      style={{ background: 'linear-gradient(180deg, #0a1311 0%, #050807 90%)' }}
      onClick={(e) => {
        const x = e.clientX / window.innerWidth;
        if (x < 0.33) go(step - 1);
        else go(step + 1);
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 90% 60% at 80% 10%, rgba(30, 255, 138, 0.18), transparent 70%), radial-gradient(ellipse 110% 70% at 0% 100%, rgba(30, 255, 138, 0.08), transparent 60%)',
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-70"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse 85% 80% at 60% 40%, black 30%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 85% 80% at 60% 40%, black 30%, transparent 100%)',
        }}
      />
      <div className="relative flex items-center justify-between px-10 pt-6">
        <span className="rounded-full border border-accent/40 bg-accent/10 text-accent px-3.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em]">
          {s.tag}
        </span>
        <span className="font-mono text-sm text-white/50">
          {step + 1} / {STEPS.length}
        </span>
      </div>
      <div className="relative flex-1 flex items-center px-10 md:px-20 overflow-y-auto">
        <div className="w-full py-8">{s.body(n)}</div>
      </div>
      <div className="relative px-10 pb-4 flex items-center justify-between text-xs text-white/40">
        <span>arrow keys or click to advance · Esc exits presenter mode</span>
        <span className="font-mono">svx.econmartin.xyz</span>
      </div>
      <div className="relative h-0.5 bg-white/10">
        <div
          className="h-full bg-accent transition-all duration-300"
          style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
        />
      </div>
    </div>
  );
}
