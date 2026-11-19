import process from 'node:process';
import { loadWorkerEnv } from './env.js';
import { createLogger } from './logger.js';
import { createWorkerContext } from './context.js';
import { createCloseQueue, createCloseWorker } from './jobs/close-lot.js';
import { startPersistLoop } from './jobs/persist-bids.js';
import { startSweeper } from './jobs/sweeper.js';
import { QUEUE_NAMES } from './queues.js';

/**
 * The worker process.
 *
 * Three things run here, and between them they are what makes an accepted bid
 * durable and a finished auction finished:
 *
 * 1. **Bid persistence** — drains each lot's Redis stream into Postgres.
 * 2. **The close worker** — delayed jobs that close lots at their end time, and
 *    reschedule themselves when the soft close has moved it.
 * 3. **The sweeper** — every 30 seconds, finds anything the other two missed.
 *
 * Settlement, notifications and demo bots attach in later milestones.
 */
async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const logger = createLogger(env);
  const ctx = await createWorkerContext(env);

  const consumerName = `worker-${String(process.pid)}`;
  const closeQueue = createCloseQueue(ctx.queueConnection);
  const closeWorker = createCloseWorker(ctx, closeQueue, logger);

  const stopPersisting = startPersistLoop(ctx, { consumerName }, logger);
  const stopSweeping = startSweeper(
    ctx,
    closeQueue,
    { intervalMillis: env.SWEEPER_INTERVAL_MS, graceMillis: env.SWEEPER_GRACE_MS },
    logger,
  );

  closeWorker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, lotId: job?.data.lotId, error }, 'close job failed');
  });

  logger.info(
    {
      queues: [QUEUE_NAMES.lotClose],
      consumerName,
      sweeperIntervalMs: env.SWEEPER_INTERVAL_MS,
      strictDurability: env.FEATURE_STRICT_DURABILITY,
    },
    'ojalive worker started',
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker draining');

    // Order matters on the way down: stop taking new work, then let the
    // persistence pass in flight finish, so no acknowledged bid is left
    // unwritten by our own shutdown.
    void (async () => {
      await stopSweeping();
      await closeWorker.close();
      await stopPersisting();
      await closeQueue.close();
      await ctx.close();
    })()
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

main().catch((error: unknown) => {
  // The logger may not exist yet, so this one goes to stderr directly.
  console.error('Failed to start ojalive worker:', error);
  process.exit(1);
});
