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
          SVX is all three — <Big>Predict&apos;s first independent trading desk, external auditor,
          and infrastructure monitor</Big>. Live today.
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
        <p className="text-2xl leading-relaxed max-w-4xl">
          Across <Big>{n.calibN} settled oracles</Big>
          <LiveDot on={n.live} /> — no model of ours in the loop — Predict&apos;s favorites quoted
          at an average of <Big>{n.calibQuoted}</Big> actually won <Big>{n.calibRealized}</Big> of
          the time.
        </p>
        <p className="text-2xl leading-relaxed max-w-4xl">
          The surface is systematically <Big>underconfident below ninety cents</Big> — and
          DeepBook&apos;s own public pre-deployment audit tracks the same finding as open items
          P-2 and O-1.
        </p>
        <p className="text-xl text-muted max-w-4xl">
          We found it from the outside with live trading. Their auditors found it from the
          inside. Same conclusion.
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
          <div className="rounded-xl border border-border p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">
              Predict (testnet)
            </div>
            The pricing brain. We solve implied vol from the on-chain surface and mint live —
            settled and redeemed on-chain. Range ladders + LP supply: built and simulated,
            gated only by the frozen feed.
          </div>
          <div className="rounded-xl border border-border p-5">
            <div className="text-warn text-sm uppercase tracking-wider mb-2">
              Polymarket (real money)
            </div>
            <Big>{n.polyFills} settled fills</Big>
            <LiveDot on={n.live} /> on Polygon mainnet at a <Big>{n.polyWinRate} win rate</Big>,
            reconciled against the wallet continuously — trading pauses on unexplained drift.
          </div>
          <div className="rounded-xl border border-border p-5">
            <div className="text-muted text-sm uppercase tracking-wider mb-2">Hyperliquid</div>
            Realized-volatility feed. The delta hedge we built here was mis-sized — measured,
            post-mortemed, shut off.
          </div>
        </div>
        <p className="text-2xl max-w-4xl leading-relaxed">
          Honest ledger: real-money net is <Big>minus seven dollars</Big> — plus six from the
          strategies, minus thirteen from the hedge experiment we killed.{' '}
          <span className="text-muted">Showing you the minus thirteen is the point.</span>
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
          Mainnet day one is a config flip — proven three ways
        </h2>
        <ol className="space-y-5 text-2xl max-w-5xl list-none">
          <li>
            <Big>1.</Big> Every primitive we use — mint, permissionless redeem, ranges, LP supply
            — is confirmed in the audited, mainnet-bound package. Binaries we have executed
            <Big> end to end on testnet</Big>; ranges and LP supply are built against the same
            package and validated in simulation.
          </li>
          <li>
            <Big>2.</Big> The strategy questions are pre-answered by simulation, as the track
            requires: range ladders won at <Big>half-sigma widths (+10 percent</Big>, archived
            hundred-oracle replay); the LP-plus-insurance vault does <Big>not</Big> — and we
            published that NO with its numbers.
          </li>
          <li>
            <Big>3.</Big> The production migration already happened to us. Sui&apos;s RPC shutoff
            broke Predict&apos;s own feed — frozen since July 12, their fix merged upstream and
            awaiting redeploy. Our bot hit the same shutoff, <Big>we migrated within the hour</Big>,
            reported the outage — and you just saw the kill switch refusing signals live.
          </li>
        </ol>
        <p className="text-xl text-muted max-w-4xl">
          Mainnet also opens what testnet can&apos;t: real Predict economics, the three-protocol
          margin loop (already built and simulated), multi-asset when they list Ethereum.
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
    tag: 'Target users · product-market fit',
    body: () => (
      <div className="space-y-8">
        <h2 className="text-4xl font-semibold tracking-tight">Three users, in adoption order</h2>
        <div className="space-y-6 text-2xl max-w-5xl">
          <p>
            <Big>Today — the protocol team.</Big> Our calibration feed and infrastructure
            monitoring are the analytics the brief asked for. We are already, in practice,
            Predict&apos;s external test desk.
          </p>
          <p>
            <Big>At mainnet — operators.</Big> Open source with a runbook. Every additional SVX
            instance is an independent arbitrageur pulling the surface toward truth — how
            Predict&apos;s pricing becomes trustworthy enough for size.
          </p>
          <p>
            <Big>Later — LPs.</Big> Once audited, the vault phase wraps the validated strategies
            in tokenized shares.
          </p>
        </div>
        <p className="text-xl text-muted max-w-4xl">
          Why they adopt: quants go where there is measurable edge — and we published the
          measurement.
        </p>
      </div>
    ),
  },
  {
    kind: 'slide',
    tag: 'Monetization · roadmap',
    body: () => (
      <div className="space-y-8">
        <h2 className="text-4xl font-semibold tracking-tight">Sustainability in three phases</h2>
        <div className="grid grid-cols-3 gap-6 max-w-5xl text-xl">
          <div className="rounded-xl border border-border p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">Phase 1 — now</div>
            The bot trades its own balance. The strategies fund the operation.
          </div>
          <div className="rounded-xl border border-border p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">
              Phase 2 — mainnet week one
            </div>
            Calibration feed + settled-redeem keeper as operator services — permissionless
            redeem is in the package; we run it as a paid service. Revenue from day one.
          </div>
          <div className="rounded-xl border border-border p-5">
            <div className="text-accent text-sm uppercase tracking-wider mb-2">
              Phase 3 — post-audit
            </div>
            The tokenized vault: LPs deposit, validated strategies run, on-chain economics anyone
            can audit.
          </div>
        </div>
        <p className="text-xl text-muted max-w-4xl">
          Deliberately no token and no pooled funds until audit and legal sign-off — a compliance
          choice, not a gap.
        </p>
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
            Predict is the <Big>only vol-surface-priced prediction protocol anywhere</Big> — and
            it exists because of Sui.
          </li>
          <li>
            <Big>Sub-second finality</Big> makes sub-hour option cycles real.
          </li>
          <li>
            The <Big>object model</Big> gives us a manager account we mint, settle, and redeem
            against programmatically.
          </li>
          <li>
            <Big>Programmable transaction blocks</Big> open an entire range ladder — or the full
            three-protocol margin loop — atomically, in one transaction.
          </li>
        </ul>
        <div className="pt-6 border-t border-border max-w-5xl">
          <p className="text-3xl leading-relaxed">
            SVX: Predict&apos;s first independent trading desk, first external auditor, and first
            infrastructure monitor. <Big>Live today. Mainnet on day one.</Big>
          </p>
          <p className="text-xl text-muted mt-4 font-mono">
            svx.econmartin.xyz — everything verifiable now
          </p>
        </div>
      </div>
    ),
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

  // Slide step: full-screen overlay above everything.
  return (
    <div
      className="fixed inset-0 z-[60] bg-bg text-fg flex flex-col cursor-pointer select-none"
      onClick={(e) => {
        const x = e.clientX / window.innerWidth;
        if (x < 0.33) go(step - 1);
        else go(step + 1);
      }}
    >
      <div className="flex items-center justify-between px-10 pt-6 text-sm text-muted">
        <span className="uppercase tracking-widest">{s.tag}</span>
        <span className="font-mono">
          {step + 1} / {STEPS.length}
        </span>
      </div>
      <div className="flex-1 flex items-center px-10 md:px-20 overflow-y-auto">
        <div className="w-full py-8">{s.body(n)}</div>
      </div>
      <div className="px-10 pb-6 flex items-center justify-between text-xs text-muted">
        <span>arrow keys or click to advance · Esc exits presenter mode</span>
        <span className="font-mono">svx.econmartin.xyz</span>
      </div>
    </div>
  );
}
