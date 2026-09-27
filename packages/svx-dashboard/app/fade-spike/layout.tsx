import type { Metadata } from 'next';

// Kept out of search results even when something links here (robots.ts
// also asks crawlers not to fetch it).
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function FadeSpikeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
