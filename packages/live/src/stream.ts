/**
 * The per-lot event stream: how an accepted bid gets from Redis to Postgres,
 * and how a reconnecting client catches up.
 *
 * One Redis Stream per lot, appended to inside the same atomic script that
 * accepted the bid — so an accepted bid and its stream entry cannot come apart.
 * The persisting worker reads with a consumer group, which gives at-least-once
 * delivery; `UNIQUE (lot_id, seq)` on the other end turns that into
 * exactly-once storage.
 */

import { z } from 'zod';
import type { Redis } from 'ioredis';
import { lotStreamKey, PERSIST_GROUP } from './keys.js';

/** Lots with live state in Redis, so the worker knows which streams exist. */
export const ACTIVE_LOTS_KEY = 'ojalive:lots:active';

const amount = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => BigInt(value));
const optionalAmount = z
  .string()
  .transform((value) => (value === '' ? null : value))
  .pipe(z.union([amount, z.null()]));
const optionalText = z.string().transform((value) => (value === '' ? null : value));
const count = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number(value));
const optionalCount = z
  .string()
  .transform((value) => (value === '' ? null : value))
  .pipe(z.union([count, z.null()]));

const entrySchema = z.object({
  seq: count,
  at: count,
  kind: z.enum(['bid', 'buy_now', 'close']),
  userId: optionalText,
  maxKobo: optionalAmount,
  priceKobo: amount,
  leaderUserId: optionalText,
  leaderMaxKobo: optionalAmount,
  leaderMaxSetSeq: optionalCount,
  bidCount: count,
  endsAt: count,
  extensionCount: count,
  reserveMet: z.enum(['0', '1']).transform((value) => value === '1'),
  idempotencyKey: optionalText,
  source: z.enum(['web', 'api', 'bot', 'staff']),
  lotOutcome: z
    .string()
    .transform((value) => (value === '' ? null : value))
    .pipe(z.union([z.enum(['sold', 'unsold_no_bids', 'unsold_reserve_not_met']), z.null()])),
});

export type StreamEvent = z.infer<typeof entrySchema> & {
  /** The Redis Stream id, used to acknowledge and to resume from. */
  readonly id: string;
  readonly lotId: string;
};

export class StreamError extends Error {}

/** Turn XADD's flat field array back into an object. */
function toObject(fields: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) out[key] = value;
  }
  return out;
}

export function parseStreamEntry(
  lotId: string,
  id: string,
  fields: readonly string[],
): StreamEvent {
  const parsed = entrySchema.safeParse(toObject(fields));
  if (!parsed.success) {
    throw new StreamError(
      `Stream entry ${id} on lot ${lotId} is unreadable: ${parsed.error.message}`,
    );
  }
  return { ...parsed.data, id, lotId };
}

/**
 * Create the consumer group if it is not there. `MKSTREAM` so a cold lot does
 * not need its stream to exist first, and BUSYGROUP is success, not failure —
 * every worker instance calls this on startup and only one can be first.
 */
export async function ensureGroup(redis: Redis, lotId: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', lotStreamKey(lotId), PERSIST_GROUP, '0', 'MKSTREAM');
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('BUSYGROUP')) return;
    throw error;
  }
}

/** New entries for this consumer, plus anything it was handed and never acked. */
export async function readGroupBatch(
  redis: Redis,
  lotId: string,
  consumer: string,
  count_ = 100,
): Promise<StreamEvent[]> {
  const key = lotStreamKey(lotId);
  const events: StreamEvent[] = [];

  // '0' first: entries already delivered to this consumer but not acknowledged,
  // which is where a crashed worker's work is waiting.
  for (const from of ['0', '>']) {
    const reply = await redis.xreadgroup(
      'GROUP',
      PERSIST_GROUP,
      consumer,
      'COUNT',
      count_,
      'STREAMS',
      key,
      from,
    );
    for (const entry of flattenReadReply(reply)) {
      events.push(parseStreamEntry(lotId, entry.id, entry.fields));
    }
    if (events.length > 0) break;
  }

  return events;
}

/** Entries after `fromId`, for a client that reconnected and sent its last seq. */
export async function readStreamFrom(
  redis: Redis,
  lotId: string,
  fromId: string,
  count_ = 500,
): Promise<StreamEvent[]> {
  const reply = await redis.xrange(lotStreamKey(lotId), `(${fromId}`, '+', 'COUNT', count_);
  return reply.map(([id, fields]) => parseStreamEntry(lotId, id, fields));
}

export async function ackEvents(
  redis: Redis,
  lotId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await redis.xack(lotStreamKey(lotId), PERSIST_GROUP, ...ids);
}

/**
 * How far behind the persisting worker is for one lot.
 *
 * This is the honest-caveat metric from design doc §8.1: the number of
 * acknowledged bids that are not yet in Postgres. It is what an alert watches,
 * because it is the exact size of the window a Redis crash could cost us.
 */
export async function pendingCount(redis: Redis, lotId: string): Promise<number> {
  const reply: unknown = await redis.xpending(lotStreamKey(lotId), PERSIST_GROUP);
  if (Array.isArray(reply) && typeof reply[0] === 'number') return reply[0];
  return 0;
}

export async function activeLots(redis: Redis): Promise<string[]> {
  return redis.smembers(ACTIVE_LOTS_KEY);
}

export async function markLotActive(redis: Redis, lotId: string): Promise<void> {
  await redis.sadd(ACTIVE_LOTS_KEY, lotId);
}

export async function markLotInactive(redis: Redis, lotId: string): Promise<void> {
  await redis.srem(ACTIVE_LOTS_KEY, lotId);
}

interface RawEntry {
  readonly id: string;
  readonly fields: string[];
}

/**
 * XREADGROUP replies as [[streamKey, [[id, [field, value, ...]], ...]], ...].
 * ioredis types that as `unknown`, so it is narrowed here rather than cast.
 */
function flattenReadReply(reply: unknown): RawEntry[] {
  if (!Array.isArray(reply)) return [];
  const entries: RawEntry[] = [];
  // `Array.isArray` on an `unknown` narrows to `any[]`, so each element is
  // re-typed as `unknown` on the way in; otherwise `any` spreads from here.
  for (const stream of reply as unknown[]) {
    if (!Array.isArray(stream)) continue;
    const parts: unknown[] = stream;
    const rows = parts[1];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as unknown[]) {
      if (!Array.isArray(row)) continue;
      const pair: unknown[] = row;
      const id = pair[0];
      const fields = pair[1];
      if (typeof id !== 'string' || !Array.isArray(fields)) continue;
      const values: unknown[] = fields;
      entries.push({ id, fields: values.filter((f): f is string => typeof f === 'string') });
    }
  }
  return entries;
}
