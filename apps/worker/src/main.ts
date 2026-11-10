import { loadWorkerEnv } from './env.js';
import { createLogger } from './logger.js';
import { QUEUE_NAMES } from './queues.js';

/**
 * The worker process: timers, settlement, notifications and demo bots.
 *
 * Milestone 2 brings up the process, its configuration and its shutdown
 * behaviour. Milestone 4 attaches the real queues, starting with lot closing.
 */
function main(): void {
  const env = loadWorkerEnv();
  const logger = createLogger(env);

  logger.info(
    { queues: Object.values(QUEUE_NAMES), strictDurability: env.FEATURE_STRICT_DURABILITY },
    'ojalive worker starting',
  );

  const shutdownHandlers: Array<() => void | Promise<void>> = [];

  // A heartbeat, so that `pnpm dev` shows the process is alive before the real
  // queues exist. Milestone 4 replaces it with BullMQ workers.
  const heartbeat = setInterval(() => {
    logger.debug('worker idle — no queues attached yet (milestone 4)');
  }, 30_000);
  shutdownHandlers.push(() => {
    clearInterval(heartbeat);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker draining');

    void Promise.all(shutdownHandlers.map((handler) => Promise.resolve(handler())))
      .then(() => {
        logger.info('worker closed cleanly');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ error }, 'worker failed to close cleanly');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (error: unknown) {
  // The logger may not exist yet, so this one goes to stderr directly.
  console.error('Failed to start ojalive worker:', error);
  process.exit(1);
}
