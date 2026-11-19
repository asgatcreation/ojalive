/**
 * The worker's connections, built once and shared by every job.
 *
 * BullMQ needs its own Redis connection with `maxRetriesPerRequest: null` —
 * blocking commands would otherwise be killed by ioredis' retry limit. The
 * bidding path gets a separate connection with a normal retry limit, because
 * there a request that cannot be served should fail fast rather than hang a
 * bidder.
 */

import { Redis } from 'ioredis';
import { createDb, type Database, type DbHandle } from '@ojalive/db';
import { ScriptRunner, type LiveContext } from '@ojalive/live';
import type { WorkerEnv } from './env.js';

export interface WorkerContext {
  readonly live: LiveContext;
  readonly db: Database;
  readonly redis: Redis;
  /** For BullMQ only. Blocking reads live on this one. */
  readonly queueConnection: Redis;
  readonly close: () => Promise<void>;
}

export async function createWorkerContext(env: WorkerEnv): Promise<WorkerContext> {
  const handle: DbHandle = createDb({ url: env.DATABASE_URL, max: 10 });
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const queueConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const scripts = await ScriptRunner.create(redis);

  const live: LiveContext = { db: handle.db, redis, scripts };

  return {
    live,
    db: handle.db,
    redis,
    queueConnection,
    close: async () => {
      redis.disconnect();
      queueConnection.disconnect();
      await handle.close();
    },
  };
}
