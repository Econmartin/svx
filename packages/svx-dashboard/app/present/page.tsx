'use client';

/**
 * /present — entry point for presenter mode. The actual deck lives in
 * components/Presenter.tsx (mounted site-wide in the layout): visiting this
 * route activates it, and the sequence then interleaves full-screen slides
 * with the site's real live pages. Casual visitors never land here — the
 * route is not linked from the nav.
 */

export default function PresentPage() {
  // The Presenter (in the root layout) detects this pathname and takes
  // over with the slide overlay. This underlay only shows if JS is slow.
  return (
    <div className="min-h-[60vh] flex items-center justify-center text-muted text-sm">
      Loading presentation… (arrow keys advance · Escape exits)
    </div>
  );
}
