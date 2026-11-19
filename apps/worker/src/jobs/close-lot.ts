/**
 * Closing a lot: layers one and two of the four (design doc §8.5).
 *
 * Layer 1 is the delayed job scheduled for the lot's end time. Layer 2 is the
 * first thing the job does — re-read the end time from the database. If the
 * soft close moved it, the job reschedules itself and does nothing else. The
 * schedule is a hint; `lots.ends_at` is the authority.
 *
 * Layers 3 and 4 (the Lua compare-and-set and the unique constraint on
 * `lot_closures`) live in `@ojalive/live`'s `closeLot`, which this calls.
 */

import { z } from 'zod';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { closeLot } from '@ojalive/live';
import type { Logger } from 'pino';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '../queues.js';
import type { WorkerContext } from '../context.js';

export const closeLotJobSchema = z.object({
  lotId: z.string().uuid(),
  /** The end time this job was scheduled for, for logging and for the id. */
  dueAt: z.number().int(),
});

export type CloseLotJob = z.infer<typeof closeLotJobSchema>;

export function createCloseQueue(connection: Redis): Queue<CloseLotJob> {
  return new Queue<CloseLotJob>(QUEUE_NAMES.lotClose, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

/**
 * Schedule (or re-schedule) a lot's close.
 *
 * The job id includes the due time, so an extension produces a *different*
 * job rather than clashing with the one already queued. Several close jobs for
 * one lot are harmless — that is exactly what layers 3 and 4 are for — whereas
 * a lot with no job at all would stay open, so erring towards one too many is
 * the right way round.
 */
export async function scheduleLotClose(
  queue: Queue<CloseLotJob>,
  lotId: string,
  endsAt: number,
  now = Date.now(),
): Promise<void> {
  await queue.add(
    'close',
    { lotId, dueAt: endsAt },
    {
      jobId: `close:${lotId}:${String(endsAt)}`,
      delay: Math.max(0, endsAt - now),
    },
  );
}

export function createCloseWorker(
  ctx: WorkerContext,
  queue: Queue<CloseLotJob>,
  logger: Logger,
): Worker<CloseLotJob> {
  return new Worker<CloseLotJob>(
    QUEUE_NAMES.lotClose,
    async (job: Job<CloseLotJob>) => {
      const { lotId } = closeLotJobSchema.parse(job.data);
      const result = await closeLot(ctx.live, lotId, Date.now());

      switch (result.kind) {
        case 'closed':
          logger.info(
            {
              lotId,
              seq: result.snapshot.seq,
              outcome: result.snapshot.lotOutcome,
              wroteClosure: result.wroteClosure,
            },
            'lot closed',
          );
          return;
        case 'already_closed':
          // Not an error. Another instance got there first, or this is the
          // sweeper finishing a closure whose worker died mid-way.
          logger.debug({ lotId, wroteClosure: result.wroteClosure }, 'lot was already closed');
          return;
        case 'not_yet_due':
          logger.info(
            { lotId, endsAt: result.endsAt },
            'end time moved — rescheduling rather than closing',
          );
          await scheduleLotClose(queue, lotId, result.endsAt);
          return;
        case 'unknown_lot':
          logger.warn({ lotId }, 'close job for a lot that does not exist');
          return;
      }
    },
    { connection: ctx.queueConnection, concurrency: 4 },
  );
}
