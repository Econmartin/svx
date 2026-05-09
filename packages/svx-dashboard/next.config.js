const path = require('node:path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output bundles only what's needed for runtime — image size
  // shrinks by ~10x and the production container needs no node_modules.
  output: 'standalone',
  // For pnpm-workspace monorepos, point the file tracer at the workspace root
  // so symlinked workspace packages (`svx-shared`) get traced into the bundle.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  env: {
    NEXT_PUBLIC_SVX_API: process.env.NEXT_PUBLIC_SVX_API ?? 'http://127.0.0.1:4321',
  },
};
module.exports = nextConfig;
