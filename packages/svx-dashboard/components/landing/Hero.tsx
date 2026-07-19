'use client';

/**
 * Landing hero. Visual pattern (notched-corner mask + caption pill) is
 * adapted from the eve-frontier-space sibling repo's Hero — same CSS
 * mask-composite trick — restyled for SVX's dark / accent-green theme and
 * extended with a live PnL headline pulled from the bot status.
 *
 * The "Overview" caption sits in the bottom-left corner and the mask
 * carves a notch around it so it appears to float beside the hero card,
 * matching the eve "Join Reapers" interaction. Caption expands on hover.
 */

import Link from 'next/link';
import './hero.css';
import { formatUsdc } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { ArrowRight, ChartLineUp } from '@phosphor-icons/react';

interface HeroProps {
  network: 'testnet' | 'mainnet';
  combinedPnl: number;
  pnl24h: number;
  tradesLast24h?: number;
  signalsLast24h?: number;
  paused: boolean;
  liveOnSelectedNetwork: boolean;
}

export function Hero({
  network,
  combinedPnl,
  pnl24h,
  tradesLast24h,
  signalsLast24h,
  paused,
  liveOnSelectedNetwork,
}: HeroProps) {
  const isMainnet = network === 'mainnet';
  const pnlTone = combinedPnl > 0 ? 'win' : combinedPnl < 0 ? 'loss' : 'neutral';
  const pnl24Tone = pnl24h > 0 ? 'win' : pnl24h < 0 ? 'loss' : 'neutral';

  const statusLabel = paused
    ? 'paused'
    : liveOnSelectedNetwork
      ? isMainnet
        ? 'live · real money'
        : 'live · testnet'
      : 'paper';

  return (
    <section className="svx-hero grid min-h-[58vh] sm:min-h-[62vh] items-end justify-items-start">
      <div className="svx-hero-mask relative overflow-hidden rounded-[2rem] [grid-area:1/1] place-self-stretch border border-border/80">
        <div className="svx-hero-bg absolute inset-0" />
        <div className="svx-hero-grid absolute inset-0" aria-hidden />
        <div className="svx-hero-gradient absolute inset-0" />

        <div className="relative flex flex-col justify-between h-full pt-8 sm:pt-10 pb-24 sm:pb-28 px-6 sm:px-10 md:px-12 gap-8">
          {/* Top-anchored chip row — sits above the bottom-anchored
              headline block so the badges read as a header strip rather
              than crowding the H1. */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={isMainnet ? 'mainnet' : 'testnet'} className="text-[10px]">
              {isMainnet ? 'mainnet · real money' : 'testnet'}
            </Badge>
            <Badge
              variant={paused ? 'outline' : liveOnSelectedNetwork ? 'live' : 'default'}
              className="text-[10px]"
            >
              {statusLabel}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              Sui Overflow ’26
            </Badge>
          </div>

          {/* Bottom-anchored headline + stats block. */}
          <div className="flex flex-col gap-5">
            <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-semibold text-white leading-[0.95] tracking-tight max-w-3xl">
              Cross-venue<br />
              vol-arb on<br />
              <span className="text-accent">DeepBook Predict.</span>
            </h1>

            <p className="text-base sm:text-lg text-white/75 max-w-xl leading-relaxed">
              One operator, three venues. A bot that prices bets off
              Predict's volatility surface, executes real money on
              Polymarket, and reads realized volatility from Hyperliquid.
              Fully open source.
            </p>

            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 pt-2 max-w-3xl">
            <Stat
              label={isMainnet ? 'Combined PnL' : 'Predict PnL'}
              value={formatUsdc(combinedPnl)}
              tone={pnlTone}
              hint="all time"
            />
            <Stat
              label="PnL 24h"
              value={formatUsdc(pnl24h)}
              tone={pnl24Tone}
              hint="rolling"
            />
            <Stat
              label="Trades 24h"
              value={tradesLast24h != null ? String(tradesLast24h) : '—'}
              tone="neutral"
              hint={signalsLast24h != null ? `${signalsLast24h} signals` : 'awaiting'}
            />
            <Stat
              label="Venues"
              value="3"
              tone="neutral"
              hint="Predict · Poly · HL"
            />
            </dl>
          </div>
        </div>
      </div>

      <Link
        href="/overview"
        aria-label="View the live operator overview"
        className="svx-hero-caption z-10 flex items-center justify-center overflow-hidden cursor-pointer text-bg no-underline [grid-area:1/1]"
      >
        <span className="svx-hero-caption__content flex items-center justify-center gap-2">
          <ChartLineUp
            className="svx-hero-caption__logo h-6 w-6 shrink-0"
            weight="bold"
          />
          <span className="svx-hero-caption__text text-base md:text-lg font-semibold whitespace-nowrap inline-flex items-center gap-1">
            Live overview
            <ArrowRight className="h-4 w-4" />
          </span>
        </span>
      </Link>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: 'win' | 'loss' | 'neutral';
  hint: string;
}) {
  const toneCls =
    tone === 'win'
      ? 'text-accent'
      : tone === 'loss'
        ? 'text-loss'
        : 'text-white';
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.16em] text-white/55 font-medium">
        {label}
      </dt>
      <dd
        className={`mt-1 text-2xl sm:text-3xl font-mono font-semibold tabular-nums ${toneCls}`}
      >
        {value}
      </dd>
      <div className="text-[11px] text-white/45 mt-0.5 font-mono">{hint}</div>
    </div>
  );
}
