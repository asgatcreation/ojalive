import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the workspace SOURCES, not each package's built dist, so
    // a test never silently passes against a stale build.
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
    include: ['{apps,packages}/*/src/**/*.test.ts', '{apps,packages}/*/test/**/*.test.ts'],
    environment: 'node',
    // Integration tests spin up real Postgres and Redis and are run separately.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
