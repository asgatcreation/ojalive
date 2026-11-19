/**
 * Reading a lot's live state out of Redis as a `LotState`.
 *
 * This is the read path the lot page and the resync endpoint use — the Lua
 * scripts own every write. It parses the hash with zod, because a hash that was
 * written by an older version of a script is exactly the sort of thing that
 * should fail loudly rather than quietly produce a wrong price.
 */

import { z } from 'zod';
import type { Redis } from 'ioredis';
import type { LotState } from '@ojalive/bid-engine';
import { lotStateKey } from './keys.js';

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

const rulesSchema = z.object({
  incrementBands: z
    .array(
      z.object({
        upToKobo: z.union([
          z
            .string()
            .regex(/^\d+$/)
            .transform((value) => BigInt(value)),
          z.null(),
        ]),
        stepKobo: z
          .string()
          .regex(/^\d+$/)
          .transform((value) => BigInt(value)),
      }),
    )
    .min(1),
  softClose: z.object({
    windowMillis: z.number().int().nonnegative(),
    extensionMillis: z.number().int().nonnegative(),
    maxTotalExtensionMillis: z.number().int().nonnegative(),
  }),
});

const hashSchema = z.object({
  lotId: z.string().min(1),
  status: z.enum(['scheduled', 'open', 'paused', 'closing', 'closed']),
  seq: count,
  price: amount,
  startingPrice: amount,
  reserve: optionalAmount,
  buyNow: optionalAmount,
  leaderUserId: optionalText,
  leaderMax: optionalAmount,
  leaderMaxSetSeq: optionalCount,
  bidCount: count,
  endsAt: count,
  originalEndsAt: count,
  extensionCount: count,
  outcome: z
    .string()
    .transform((value) => (value === '' ? null : value))
    .pipe(z.union([z.enum(['sold', 'unsold_no_bids', 'unsold_reserve_not_met']), z.null()])),
  rules: z.string().transform((value): unknown => JSON.parse(value)),
});

export class LiveStateError extends Error {}

/** The lot's live state, or null when Redis holds none (cold, or restarted). */
export async function readLiveState(redis: Redis, lotId: string): Promise<LotState | null> {
  const hash = await redis.hgetall(lotStateKey(lotId));
  if (Object.keys(hash).length === 0) return null;

  const parsed = hashSchema.safeParse(hash);
  if (!parsed.success) {
    throw new LiveStateError(
      `Live state for lot ${lotId} is not readable: ${parsed.error.message}`,
    );
  }
  const rules = rulesSchema.safeParse(parsed.data.rules);
  if (!rules.success) {
    throw new LiveStateError(`Lot ${lotId} has unreadable rules: ${rules.error.message}`);
  }

  const row = parsed.data;
  return {
    lotId: row.lotId,
    status: row.status,
    seq: row.seq,
    priceKobo: row.price,
    startingPriceKobo: row.startingPrice,
    reservePriceKobo: row.reserve,
    buyNowPriceKobo: row.buyNow,
    leaderUserId: row.leaderUserId,
    leaderMaxKobo: row.leaderMax,
    leaderMaxSetSeq: row.leaderMaxSetSeq,
    bidCount: row.bidCount,
    endsAt: row.endsAt,
    originalEndsAt: row.originalEndsAt,
    extensionCount: row.extensionCount,
    outcome: row.outcome,
    rules: rules.data,
  };
}
