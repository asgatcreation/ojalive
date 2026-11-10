import { loadApiEnv } from './env.js';
import { buildApp } from './app.js';

/**
 * Start the API.
 *
 * Shutdown is deliberate: Fly will replace instances during a deploy, and a lot
 * that is seconds from closing must not lose bids to it. We stop accepting new
 * work, let in-flight requests finish, tell sockets to reconnect elsewhere, and
 * only then exit. See docs/MILESTONE-1-DESIGN.md §8.3.
 */
async function main(): Promise<void> {
  const env = loadApiEnv();

  // Milestone 4 replaces this with real Postgres and Redis checks.
  let ready = false;

  const app = await buildApp({ env, isReady: () => ready });

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  ready = true;
  app.log.info({ url: env.API_PUBLIC_URL }, 'ojalive api listening');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    app.log.info({ signal }, 'draining');

    // Give load balancers a moment to stop sending us traffic before we close.
    setTimeout(() => {
      void app
        .close()
        .then(() => {
          app.log.info('closed cleanly');
          process.exit(0);
        })
        .catch((error: unknown) => {
          app.log.error({ error }, 'error while closing');
          process.exit(1);
        });
    }, 2_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so this one goes to stderr directly.
  console.error('Failed to start ojalive api:', error);
  process.exit(1);
});
