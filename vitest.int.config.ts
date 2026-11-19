// Integration tests: real Postgres, real Redis, real Lua. Separate from the
// unit run because they need `pnpm docker:up` first, and because a unit suite
// that needs a database is a unit suite nobody runs.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ojalive/shared': fromRoot('./packages/shared/src/index.ts'),
      '@ojalive/bid-engine': fromRoot('./packages/bid-engine/src/index.ts'),
      '@ojalive/payments': fromRoot('./packages/payments/src/index.ts'),
      '@ojalive/db': fromRoot('./packages/db/src/index.ts'),
      // Test-only, and listed BEFORE the bare package name: Vite matches alias
      // keys as prefixes in order, so '@ojalive/live' would otherwise swallow
      // this one. The harness is deliberately not part of the public surface,
      // but the worker's own integration test needs it.
      '@ojalive/live/int-support': fromRoot('./packages/live/src/int-support.ts'),
      '@ojalive/live': fromRoot('./packages/live/src/index.ts'),
    },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.int.test.ts'],
    environment: 'node',
    // One lot at a time per file; files themselves run in parallel.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
