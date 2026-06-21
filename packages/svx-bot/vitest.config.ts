import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // better-sqlite3's native .node binary isn't safe to load across the
    // default worker-thread pool — produces ERR_DLOPEN_FAILED on every suite
    // that touches the ledger. `forks` isolates each test file in its own
    // process so the native module loads once per process.
    pool: 'forks',
  },
});
