/** @type {import('next').NextConfig} */

// STATIC_EXPORT=1 swaps the build into `output: 'export'` mode for hosting
// on Walrus Sites (or any static aggregator). Without the flag, Next emits
// the normal server+static bundle that Netlify's @netlify/plugin-nextjs
// expects, so the existing Netlify deploy is unaffected.
//
// Static-export requirements we set here:
//   - trailingSlash: Walrus aggregators resolve /about/ more reliably than
//     /about (consistent index.html lookup).
//   - images.unoptimized: we don't use next/image but this makes the
//     export idempotent if anyone adds one.
const isStaticExport = process.env.STATIC_EXPORT === '1';

const nextConfig = {
  reactStrictMode: true,
  // No `output: 'standalone'` — Next's standalone tracer is flaky in our
  // pnpm-workspace Docker builds. The runtime image instead ships the full
  // node_modules and uses `next start`. Image is ~30MB larger but reliable.
  ...(isStaticExport && {
    output: 'export',
    trailingSlash: true,
    images: { unoptimized: true },
  }),
  env: {
    NEXT_PUBLIC_SVX_API: process.env.NEXT_PUBLIC_SVX_API ?? 'http://127.0.0.1:4321',
  },
};
module.exports = nextConfig;
