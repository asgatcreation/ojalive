import { Redis } from 'ioredis';
import { createDb } from '@ojalive/db';
import { ScriptRunner, type LiveContext } from '@ojalive/live';
import { loadApiEnv } from './env.js';
import { buildApp } from './app.js';
import { createRealtime } from './realtime/server.js';

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

  let ready = false;

  const database = createDb({ url: env.DATABASE_URL });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const scripts = await ScriptRunner.create(redis);
  const live: LiveContext = { db: database.db, redis, scripts };

  const app = await buildApp({ env, isReady: () => ready, live, redis });

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  // Socket.IO attaches to the server Fastify is already listening on, so there
  // is one port, one TLS certificate and one thing for Fly to health-check.
  const realtime = createRealtime({
    httpServer: app.server,
    live,
    redis,
    logger: app.log,
    corsOrigins: env.CORS_ORIGINS,
  });

  // Readiness means both dependencies answered, not merely that we bound a port.
  await Promise.all([redis.ping(), database.pool.query('select 1')]);
  ready = true;
  app.log.info({ url: env.API_PUBLIC_URL, socketPath: '/socket' }, 'ojalive api listening');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    app.log.info({ signal }, 'draining');

    // Give load balancers a moment to stop sending us traffic before we close.
    setTimeout(() => {
      void (async () => {
        // Sockets first: clients reconnect to a surviving instance and resync
        // from their last seq, so a deploy costs them a round trip, not a bid.
        await realtime.close();
        await app.close();
        redis.disconnect();
        await database.close();
      })()
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
