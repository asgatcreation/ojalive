/**
 * Moving accepted bids from Redis into Postgres.
 *
 * This is the loop behind the honest caveat in design doc §8.1. A bid is
 * acknowledged once the Lua script has written it and appended it to the lot's
 * stream; this loop is what gets it to durable storage a few milliseconds
 * later. The gap between those two moments is the whole durability risk, which
 * is why the backlog is a metric and not just a comment.
 *
 * It reads with a consumer group, so an entry is redelivered if this process
 * dies before acknowledging it. Redelivery is safe: `UNIQUE (lot_id, seq)`
 * turns at-least-once delivery into exactly-once storage.
 */

import type { Logger } from 'pino';
import {
  ackEvents,
  activeLots,
  ensureGroup,
  markLotInactive,
  pendingCount,
  persistStreamEvent,
  readGroupBatch,
  readLiveState,
} from '@ojalive/live';
import type { WorkerContext } from '../context.js';

export interface PersistLoopOptions {
  readonly consumerName: string;
  readonly intervalMillis?: number;
  readonly batchSize?: number;
}

export interface PersistPass {
  readonly lots: number;
  readonly written: number;
  readonly alreadyPresent: number;
  readonly backlog: number;
}

/**
 * One pass over every lot that has live state in Redis.
 *
 * Exported separately from the loop so it can be driven directly by a test and
 * by the smoke run, without waiting on a timer.
 */
export async function persistOnce(
  ctx: WorkerContext,
  options: PersistLoopOptions,
  logger: Logger,
): Promise<PersistPass> {
  const lots = await activeLots(ctx.redis);
  let written = 0;
  let alreadyPresent = 0;
  let backlog = 0;

  for (const lotId of lots) {
    await ensureGroup(ctx.redis, lotId);

    for (;;) {
      const batch = await readGroupBatch(
        ctx.redis,
        lotId,
        options.consumerName,
        options.batchSize ?? 200,
      );
      if (batch.length === 0) break;

      const done: string[] = [];
      for (const event of batch) {
        try {
          const outcome = await persistStreamEvent(ctx.db, event);
          if (outcome === 'written') written += 1;
          if (outcome === 'already_present') alreadyPresent += 1;
          done.push(event.id);
        } catch (error: unknown) {
          // Leave it unacknowledged: it stays in the pending list and is
          // retried on the next pass. Postgres being unavailable must not cost
          // us a bid, and it must not stop bidding either (design doc §8.4).
          logger.error({ lotId, streamId: event.id, error }, 'could not persist a bid event');
          break;
        }
      }

      await ackEvents(ctx.redis, lotId, done);
      if (done.length < batch.length) break;
    }

    backlog += await pendingCount(ctx.redis, lotId);

    // A closed lot with nothing left pending needs no more attention.
    const state = await readLiveState(ctx.redis, lotId);
    if (state?.status === 'closed' && (await pendingCount(ctx.redis, lotId)) === 0) {
      await markLotInactive(ctx.redis, lotId);
    }
  }

  return { lots: lots.length, written, alreadyPresent, backlog };
}

/** The running loop. Returns a function that stops it. */
export function startPersistLoop(
  ctx: WorkerContext,
  options: PersistLoopOptions,
  logger: Logger,
): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const pass = await persistOnce(ctx, options, logger);
      if (pass.written > 0 || pass.backlog > 0) {
        logger.debug(pass, 'bid persistence pass');
      }
    } catch (error: unknown) {
      logger.error({ error }, 'bid persistence pass failed');
    }
  };

  const timer = setInterval(() => {
    running = running.then(tick);
  }, options.intervalMillis ?? 250);

  return async () => {
    stopped = true;
    clearInterval(timer);
    // Let the pass in flight finish, so nothing is left half-acknowledged.
    await running;
  };
}
