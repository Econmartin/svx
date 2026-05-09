/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // No `output: 'standalone'` — Next's standalone tracer is flaky in our
  // pnpm-workspace Docker builds. The runtime image instead ships the full
  // node_modules and uses `next start`. Image is ~30MB larger but reliable.
  env: {
    NEXT_PUBLIC_SVX_API: process.env.NEXT_PUBLIC_SVX_API ?? 'http://127.0.0.1:4321',
  },
};
module.exports = nextConfig;
