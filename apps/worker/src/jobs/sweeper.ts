/**
 * The stuck-lot sweeper (design doc §8.5).
 *
 * Every 30 seconds: find lots whose end time has passed while they are still
 * open, and enqueue a close for each. This is what catches a delayed job lost
 * to a `SCRIPT FLUSH`, a Redis restart, or a worker that died holding it.
 *
 * It is the difference between a system that heals itself and one that waits
 * for a bidder to email asking why the auction never ended. The grace period
 * keeps it from racing the delayed job that is probably already running — and
 * if it does race, closing is exactly-once anyway, so the cost is a wasted
 * round trip rather than a wrong outcome.
 */

import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { lotsDueToClose } from '@ojalive/db';
import type { WorkerContext } from '../context.js';
import { scheduleLotClose, type CloseLotJob } from './close-lot.js';

export interface SweepResult {
  readonly found: number;
  readonly enqueued: number;
}

export async function sweepOnce(
  ctx: WorkerContext,
  queue: Queue<CloseLotJob>,
  graceMillis: number,
  logger: Logger,
): Promise<SweepResult> {
  const now = Date.now();
  const due = await lotsDueToClose(ctx.db, now, graceMillis);

  for (const lot of due) {
    await scheduleLotClose(queue, lot.id, lot.endsAt.getTime(), now);
  }

  if (due.length > 0) {
    logger.warn(
      { count: due.length, lotIds: due.map((lot) => lot.id) },
      'sweeper found lots past their end time and still open',
    );
  }

  return { found: due.length, enqueued: due.length };
}

/** The running loop. Returns a function that stops it. */
export function startSweeper(
  ctx: WorkerContext,
  queue: Queue<CloseLotJob>,
  options: { readonly intervalMillis: number; readonly graceMillis: number },
  logger: Logger,
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await sweepOnce(ctx, queue, options.graceMillis, logger);
    } catch (error: unknown) {
      logger.error({ error }, 'sweeper pass failed');
    }
  };

  const timer = setInterval(() => {
    running = running.then(tick);
  }, options.intervalMillis);

  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
