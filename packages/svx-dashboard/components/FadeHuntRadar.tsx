'use client';

/**
 * Fade-spike radar: one lane per live Predict window, showing BTC against
 * the window's strike over the last minute with the trigger band drawn in,
 * and the four entry conditions lighting up as they are met.
 *
 * Two feeds: the bot (strike, board price, far side and its all-in cost,
 * every ~4s) and Binance's public ticker, polled by the browser each second
 * so the trace moves smoothly. Binance is mapped onto the chain's scale with
 * the bot's latest basis (Binance mid / chain forward).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import type { FadeHuntMarket, FadeSpikeState, TradeRecord } from '@/lib/api';
import { cn } from '@/lib/cn';

const TRACE_MS = 60_000;
const BINANCE = 'https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT';

type Point = { t: number; v: number };

function useBinanceMid(): number | null {
  const [mid, setMid] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(BINANCE, { cache: 'no-store' });
        const j = (await r.json()) as { price?: string };
        const p = Number(j.price);
        if (alive && Number.isFinite(p) && p > 0) setMid(p);
      } catch {
        /* keep last value; the bot's forward is the fallback */
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return mid;
}

function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const usd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(0)}`;

export function FadeHuntRadar() {
  const client = useApiClient();
  const { data, error } = usePolling(
    useCallback(() => client.fadeSpikeState(), [client]),
    2_000,
  );
  const binance = useBinanceMid();
  const now = useNow();

  // Rolling BTC-vs-strike trace per market, kept client-side.
  const traces = useRef(new Map<string, Point[]>());
  const hunt = data?.hunt;
  useEffect(() => {
    if (!hunt) return;
    const t = Date.now();
    for (const m of hunt.markets) {
      const live =
        binance != null && hunt.basis ? binance / hunt.basis - m.reference : m.forwardVsRef;
      const arr = traces.current.get(m.marketId) ?? [];
      arr.push({ t, v: live });
      while (arr.length && arr[0]!.t < t - TRACE_MS - 5_000) arr.shift();
      traces.current.set(m.marketId, arr);
    }
    for (const id of [...traces.current.keys()]) {
      if (!hunt.markets.some((m) => m.marketId === id)) traces.current.delete(id);
    }
  }, [hunt, binance]);

  if (error && !data) {
    return (
      <div className="rounded-2xl border border-border bg-surface/75 px-6 py-5 text-[14px] text-muted shadow-card">
        Radar offline: couldn&apos;t reach the bot.
      </div>
    );
  }

  const markets = (hunt?.markets ?? []).filter((m) => m.expiryMs > now);
  const mode = !data
    ? { label: 'Connecting…', cls: 'bg-white/[0.06] text-muted' }
    : data.paused
      ? { label: 'Paused', cls: 'bg-loss/[0.12] text-loss' }
      : data.liveArmed
        ? { label: 'Live trading armed', cls: 'bg-win/[0.12] text-win' }
        : { label: 'Paper', cls: 'bg-white/[0.06] text-muted-strong' };

  return (
    <section className="rounded-2xl border border-border bg-surface/75 shadow-card backdrop-blur-xl">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
          </span>
          <h2 className="text-[17px] font-semibold tracking-[-0.018em]">Hunting</h2>
        </div>
        <span className={cn('rounded-full px-2.5 h-6 inline-flex items-center text-[12px] font-medium', mode.cls)}>
          {mode.label}
        </span>
        {hunt && now - hunt.updatedAtMs > 15_000 && (
          <span className="text-[12px] text-warn">data delayed {Math.round((now - hunt.updatedAtMs) / 1000)}s</span>
        )}
        <div className="ml-auto flex items-baseline gap-2 text-[13px] text-muted">
          BTC
          <span className="font-mono text-[17px] font-semibold text-fg">
            {binance != null
              ? `$${binance.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : hunt?.btcMid != null
                ? `$${hunt.btcMid.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : '—'}
          </span>
        </div>
      </div>
      {data?.paused && data.pauseReason && (
        <p className="px-6 -mt-2 pb-3 text-[12.5px] text-loss/90">{data.pauseReason}</p>
      )}

      <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
        {markets.map((m) => (
          <Lane
            key={m.marketId}
            m={m}
            now={now}
            trace={traces.current.get(m.marketId) ?? []}
            rule={data!.rule}
            mom30s={hunt?.mom30s ?? null}
            trade={data!.trades.find((t) => t.oracleId === m.marketId)}
            checks={(data!.evaluations ?? []).filter((e) => e.marketId === m.marketId)}
          />
        ))}
        {(hunt?.upcoming ?? [])
          .filter((u) => u.expiryMs > now && !markets.some((m) => m.marketId === u.marketId))
          .slice(0, 2)
          .map((u) => (
            <div key={u.marketId} className="flex items-center gap-3 px-6 py-3 text-[13px] text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-muted/50" />
              Next {u.cadenceSec === 60 ? '1-minute' : u.cadenceSec === 300 ? '5-minute' : ''} window
              {u.opensAtMs != null && u.opensAtMs > now ? (
                <>
                  {' '}opens in <span className="font-mono text-muted-strong">{fmtClock(u.opensAtMs - now)}</span>
                </>
              ) : (
                ' is opening — strike being set'
              )}
            </div>
          ))}
        {markets.length === 0 && (hunt?.upcoming ?? []).length === 0 && (
          <p className="px-6 py-6 text-[14px] text-muted">
            No window is open right now. Predict occasionally skips a window; the next one appears here
            automatically.
          </p>
        )}
      </div>
    </section>
  );
}

function Lane({
  m,
  now,
  trace,
  rule,
  mom30s,
  trade,
  checks,
}: {
  m: FadeHuntMarket;
  now: number;
  trace: Point[];
  rule: FadeSpikeState['rule'];
  mom30s: number | null;
  trade?: TradeRecord;
  checks: NonNullable<FadeSpikeState['evaluations']>;
}) {
  const ttm = m.expiryMs - now;
  const latest = trace.length ? trace[trace.length - 1]!.v : m.forwardVsRef;
  // "Spiking away": over the trace's last ~30s the distance from the strike
  // grew on the same side (falls back to the bot's Binance 30s momentum).
  const past = trace.find((p) => p.t >= now - 30_000);
  const spikingAway =
    past && now - past.t > 20_000
      ? Math.sign(latest) === Math.sign(latest - past.v) && Math.abs(latest) > Math.abs(past.v)
      : mom30s != null && mom30s !== 0 && Math.sign(mom30s) === Math.sign(latest);
  const tradeSlot = rule.tradeSlots?.[0] ?? 't50s';
  const [winLo, winHi] = rule.checkWindowsMs?.[tradeSlot] ?? [46_000, 57_999];
  const slotSec = tradeSlot.replace(/\D/g, '');
  const conds = [
    {
      label:
        ttm > winHi
          ? `Checks at ~${slotSec}s`
          : ttm >= winLo
            ? `${slotSec}s check window`
            : 'Check passed',
      ok: ttm <= winHi && ttm >= winLo,
    },
    { label: `${usd(latest)} vs strike`, ok: Math.abs(latest) >= rule.minMoveUsd },
    { label: 'Moving away', ok: spikingAway },
    (() => {
      // Mirrors the executor: price inside the band AND the smallest clip
      // that clears Predict's $1 minimum premium fits the per-trade cap.
      const inBand = m.farPrice >= rule.minFarPrice && m.farPrice <= rule.maxFarPrice;
      const clip =
        m.farPrice > 0 && m.farCost != null
          ? (Math.ceil((1.12 / m.farPrice) * 100) / 100) * m.farCost
          : null;
      const fits = clip != null && clip <= rule.maxCostUsd;
      return {
        label:
          `Far side ${(m.farPrice * 100).toFixed(1)}¢` +
          (inBand && clip != null && !fits ? ` · clip $${clip.toFixed(2)} > $${rule.maxCostUsd}` : ''),
        ok: inBand && fits,
      };
    })(),
  ];
  const armed = conds.every((c) => c.ok);
  const status = trade
    ? {
        label: `Bought ${trade.direction} @ ${(trade.costPrice * 100).toFixed(1)}¢ · ${trade.mode}`,
        cls: 'bg-accent text-bg',
      }
    : armed
      ? { label: 'Armed · buying at this check', cls: 'bg-accent/[0.16] text-accent animate-pulse' }
      : ttm > winHi
        ? { label: `Waiting for the ${slotSec}s check`, cls: 'bg-white/[0.05] text-muted' }
        : ttm >= winLo
          ? { label: 'Checking', cls: 'bg-white/[0.07] text-muted-strong' }
          : { label: 'Done for this window', cls: 'bg-white/[0.04] text-muted' };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[180px_1fr_300px] gap-x-6 gap-y-3 px-6 py-4 items-center">
      <div>
        <div className="text-[13px] text-muted">
          {m.cadenceSec === 60 ? '1-minute' : m.cadenceSec === 300 ? '5-minute' : 'Window'} · strike $
          {m.reference.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
        <div
          className={cn(
            'font-mono text-[28px] font-semibold tracking-[-0.025em] leading-tight',
            ttm <= rule.lastWindowMs ? 'text-fg' : 'text-muted-strong',
          )}
        >
          {fmtClock(ttm)}
        </div>
      </div>

      <Trace points={trace} now={now} band={rule.minMoveUsd} armed={armed} />

      <div className="space-y-2.5">
        <div className="flex flex-wrap gap-1.5">
          {conds.map((c) => (
            <span
              key={c.label}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 h-6 text-[12px] font-medium transition-colors duration-300',
                c.ok ? 'bg-accent/[0.14] text-accent' : 'bg-white/[0.05] text-muted',
              )}
            >
              <span
                className={cn('h-1.5 w-1.5 rounded-full', c.ok ? 'bg-accent' : 'bg-muted/50')}
              />
              {c.label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('rounded-full px-3 h-7 inline-flex items-center text-[12.5px] font-semibold', status.cls)}>
            {status.label}
          </span>
          {m.farCost != null && !trade && (
            <span className="text-[12px] text-muted">
              {m.farSide} costs {(m.farCost * 100).toFixed(1)}¢ all-in
            </span>
          )}
        </div>
        <div className="space-y-0.5 text-[12px] leading-snug">
          {[tradeSlot].map((slot) => {
            const c = checks.find((e) => e.slot === slot);
            const label = `${slotSec}s check`;
            return (
              <div key={slot} className="flex gap-1.5">
                <span className="text-muted/80 w-[68px] flex-shrink-0">{label}</span>
                <span
                  className={cn(
                    !c
                      ? 'text-muted/60'
                      : c.outcome === 'entered'
                        ? 'text-accent'
                        : c.outcome === 'not_filled'
                          ? 'text-warn'
                          : 'text-muted-strong',
                  )}
                >
                  {!c ? (ttm > winLo ? 'upcoming' : 'not run') : c.detail}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** BTC minus strike over the last minute, with the ±trigger band. */
function Trace({
  points,
  now,
  band,
  armed,
}: {
  points: Point[];
  now: number;
  band: number;
  armed: boolean;
}) {
  const W = 600;
  const H = 76;
  const pts = points.filter((p) => p.t >= now - TRACE_MS);
  const span = Math.max(band * 1.8, ...pts.map((p) => Math.abs(p.v) * 1.15), 10);
  const x = (t: number) => ((t - (now - TRACE_MS)) / TRACE_MS) * W;
  const y = (v: number) => H / 2 - (v / span) * (H / 2 - 4);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const outside = last != null && Math.abs(last.v) >= band;
  return (
    <div className="relative h-[76px] w-full">
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full overflow-visible"
      role="img"
      aria-label="BTC versus strike over the last minute"
    >
      {/* trigger zones beyond ±band */}
      <rect x={0} y={0} width={W} height={Math.max(0, y(band))} fill="rgba(30,255,138,0.05)" />
      <rect x={0} y={y(-band)} width={W} height={Math.max(0, H - y(-band))} fill="rgba(30,255,138,0.05)" />
      <line x1={0} x2={W} y1={y(band)} y2={y(band)} stroke="rgba(30,255,138,0.35)" strokeDasharray="4 5" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1={0} x2={W} y1={y(-band)} y2={y(-band)} stroke="rgba(30,255,138,0.35)" strokeDasharray="4 5" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {/* the strike */}
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,0.18)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {path && (
        <path
          d={path}
          fill="none"
          stroke={outside ? '#1eff8a' : 'rgba(230,239,232,0.85)'}
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
    {last && (
      <span
        aria-hidden
        className={cn(
          'absolute -translate-x-1/2 -translate-y-1/2 rounded-full',
          outside ? 'bg-accent shadow-[0_0_12px_rgba(30,255,138,0.7)]' : 'bg-fg',
          armed ? 'h-2.5 w-2.5 animate-pulse' : 'h-2 w-2',
        )}
        style={{ left: `${(x(last.t) / W) * 100}%`, top: `${(y(last.v) / H) * 100}%` }}
      />
    )}
    <span className="absolute right-0 top-0 text-[10.5px] text-accent/70">+${band}</span>
    <span className="absolute right-0 bottom-0 text-[10.5px] text-accent/70">−${band}</span>
    </div>
  );
}
