'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

// Ordered as the demo flow: the brain → live signals/positions → real-money
// strategy → post-mortems → the Predict-native finale. Matches the numbered
// journey on the landing page and docs/demo-script.md.
const NAV = [
  ['Overview', '/overview'],
  ['Surface', '/surface'],
  ['Signals', '/signals'],
  ['Positions', '/positions'],
  ['Poly-arb', '/poly-arb'],
  ['IV-RV', '/vol-arb'],
  ['Margin-Lever', '/margin-lever'],
  ['Divergence', '/divergence-mint'],
  ['Vaults', '/vaults'],
  ['Wallets', '/wallets'],
  ['About', '/about'],
] as const;

/**
 * Top-nav links with an active-route highlight rendered as a vibrant green
 * pill — matches the modern crypto-trader reference (Hyperliquid / BlockTrade)
 * rather than the underline-on-text style.
 */
export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex items-center gap-0.5 text-[13px]">
      {NAV.map(([label, href]) => {
        const isActive = pathname === href || pathname?.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'inline-flex items-center h-8 px-3 rounded-md transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70',
              isActive
                ? 'bg-accent text-bg font-semibold shadow-[0_0_22px_-4px_rgba(30,255,138,0.55)]'
                : 'text-muted hover:text-fg hover:bg-surface-elevated/80',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
