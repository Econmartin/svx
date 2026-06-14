'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const NAV = [
  ['Overview', '/'],
  ['Signals', '/signals'],
  ['Positions', '/positions'],
  ['Vol-arb', '/vol-arb'],
  ['Wallets', '/wallets'],
  ['Surface', '/surface'],
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
    <nav className="flex gap-1 text-sm">
      {NAV.map(([label, href]) => {
        const isActive = href === '/' ? pathname === '/' : pathname?.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              'px-3 py-1.5 rounded-md transition-all whitespace-nowrap',
              isActive
                ? 'bg-accent text-bg font-semibold shadow-[0_0_18px_-2px_rgba(30,255,138,0.45)]'
                : 'text-muted hover:text-fg hover:bg-surface-elevated',
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
