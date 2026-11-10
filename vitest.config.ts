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
