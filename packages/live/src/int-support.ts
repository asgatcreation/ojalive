/**
 * The harness for the integration tests: real Postgres, real Redis, real Lua.
 *
 * Test-only. It is not re-exported from `index.ts`, and it never touches a key
 * or a row it did not create — in particular it never calls `FLUSHALL`, which
 * is renamed out of existence in `infra/redis/redis.conf` anyway. Every lot gets
 * its own id, so tests can run in any order and nothing is shared but the
 * server itself.
 */

import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Redis } from 'ioredis';
import { naira, type EpochMillis } from '@ojalive/shared';
import type { LotRules, LotState } from '@ojalive/bid-engine';
import {
  createDb,
  deleteDemoLot,
  lots,
  sales,
  toStoredRules,
  users,
  type Database,
  type DbHandle,
} from '@ojalive/db';
import { lotIdempotencyKey, lotStateKey, lotStreamKey } from './keys.js';
import { ScriptRunner } from './scripts.js';
import type { LiveContext } from './bid-service.js';
import { markLotInactive } from './stream.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://ojalive:ojalive@localhost:55436/ojalive';

export const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:56386';

/** ₦1,000 steps below ₦100,000, then ₦5,000 — the design doc's phone lot. */
export const testRules: LotRules = {
  incrementBands: [
    { upToKobo: naira(100_000), stepKobo: naira(1_000) },
    { upToKobo: null, stepKobo: naira(5_000) },
  ],
  softClose: {
    windowMillis: 120_000,
    extensionMillis: 120_000,
    maxTotalExtensionMillis: 1_800_000,
  },
};

export const noSoftCloseRules: LotRules = {
  incrementBands: testRules.incrementBands,
  softClose: { windowMillis: 0, extensionMillis: 0, maxTotalExtensionMillis: 0 },
};

export interface Harness {
  readonly ctx: LiveContext;
  readonly db: Database;
  readonly redis: Redis;
  readonly close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const handle: DbHandle = createDb({ url: TEST_DATABASE_URL, max: 20 });
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 3 });
  const scripts = await ScriptRunner.create(redis);

  const ctx: LiveContext = { db: handle.db, redis, scripts, idempotencyTtlSeconds: 600 };

  return {
    ctx,
    db: handle.db,
    redis,
    close: async () => {
      redis.disconnect();
      await handle.close();
    },
  };
}

export interface SeededLot {
  readonly lotId: string;
  readonly saleId: string;
  readonly bidderIds: string[];
  readonly endsAt: EpochMillis;
  readonly startingPriceKobo: bigint;
}

export interface SeedOptions {
  readonly bidders?: number;
  readonly startingPriceNaira?: number;
  readonly reserveNaira?: number | null;
  readonly buyNowNaira?: number | null;
  readonly rules?: LotRules;
  readonly endsAt?: EpochMillis;
  readonly status?: 'scheduled' | 'open' | 'paused';
}

/** A sale, a lot and some bidders, all of them freshly made for one test. */
export async function seedLot(db: Database, options: SeedOptions = {}): Promise<SeededLot> {
  const suffix = randomUUID().slice(0, 8);
  const endsAt = options.endsAt ?? Date.now() + 3_600_000;
  const startingPriceKobo = naira(options.startingPriceNaira ?? 50_000);

  const [sale] = await db
    .insert(sales)
    .values({
      slug: `test-sale-${suffix}`,
      title: `Test sale ${suffix}`,
      opensAt: new Date(endsAt - 86_400_000),
      firstLotClosesAt: new Date(endsAt),
      status: 'open',
      isDemo: true,
    })
    .returning();
  if (sale === undefined) throw new Error('Could not seed a sale');

  const [lot] = await db
    .insert(lots)
    .values({
      saleId: sale.id,
      lotNumber: 1,
      title: `Test lot ${suffix}`,
      slug: `test-lot-${suffix}`,
      startingPriceKobo,
      reservePriceKobo:
        options.reserveNaira === null || options.reserveNaira === undefined
          ? null
          : naira(options.reserveNaira),
      buyNowPriceKobo:
        options.buyNowNaira === null || options.buyNowNaira === undefined
          ? null
          : naira(options.buyNowNaira),
      opensAt: new Date(endsAt - 86_400_000),
      endsAt: new Date(endsAt),
      originalEndsAt: new Date(endsAt),
      status: options.status ?? 'open',
      rulesSnapshot: toStoredRules(options.rules ?? noSoftCloseRules),
      isDemo: true,
    })
    .returning();
  if (lot === undefined) throw new Error('Could not seed a lot');

  const bidderCount = options.bidders ?? 4;
  const bidderIds: string[] = [];
  if (bidderCount > 0) {
    const rows = await db
      .insert(users)
      .values(
        Array.from({ length: bidderCount }, (_, index) => ({
          displayName: `Bidder ${String(index)} ${suffix}`,
          email: `bidder-${String(index)}-${suffix}@example.test`,
          verificationTier: 2,
        })),
      )
      .returning({ id: users.id });
    for (const row of rows) bidderIds.push(row.id);
  }

  return { lotId: lot.id, saleId: sale.id, bidderIds, endsAt, startingPriceKobo };
}

/** Delete only this lot's Redis keys. Never a FLUSH of anything. */
export async function clearLotKeys(redis: Redis, lotId: string): Promise<void> {
  await redis.del(lotStateKey(lotId), lotStreamKey(lotId), lotIdempotencyKey(lotId));
  await markLotInactive(redis, lotId);
}

/** The engine's view of a lot as it stands in Redis, for differential checks. */
export function describeState(state: LotState): Record<string, string> {
  return {
    status: state.status,
    seq: String(state.seq),
    price: state.priceKobo.toString(),
    leader: state.leaderUserId ?? '-',
    leaderMax: state.leaderMaxKobo?.toString() ?? '-',
    leaderMaxSetSeq: String(state.leaderMaxSetSeq ?? '-'),
    bidCount: String(state.bidCount),
    endsAt: String(state.endsAt),
    extensionCount: String(state.extensionCount),
    buyNow: state.buyNowPriceKobo?.toString() ?? '-',
    outcome: state.outcome ?? '-',
  };
}

/**
 * Remove everything one test created, in foreign-key order.
 *
 * Integration tests that leave rows behind turn a developer's database into a
 * landfill and make the next test's "no rows" assertion meaningless.
 */
export async function cleanupLot(db: Database, seeded: SeededLot): Promise<void> {
  await deleteDemoLot(db, {
    lotId: seeded.lotId,
    saleId: seeded.saleId,
    userIds: seeded.bidderIds,
  });
}
