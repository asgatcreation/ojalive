/**
 * The REST fallback, against the real stores.
 *
 * It exists for connections where WebSockets never establish, which is a real
 * condition on Nigerian mobile networks rather than a theoretical one. So it
 * has to return the same facts as the socket path, make the same
 * snapshot-versus-deltas decision, and keep the same secrets.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { naira } from '@ojalive/shared';
import { createDb, type Database } from '@ojalive/db';
import { ensureLotState, placeBid, ScriptRunner, type LiveContext } from '@ojalive/live';
import {
  cleanupLot,
  clearLotKeys,
  noSoftCloseRules,
  seedLot,
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  type SeededLot,
} from '@ojalive/live/int-support';
import { buildApp, type OjaLiveApp } from '../app.js';
import { loadApiEnv } from '../env.js';

let app: OjaLiveApp;
let db: Database;
let closeDb: () => Promise<void>;
let redis: Redis;
let live: LiveContext;

beforeAll(async () => {
  const handle = createDb({ url: TEST_DATABASE_URL, max: 5 });
  db = handle.db;
  closeDb = handle.close;
  redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 3 });
  live = { db, redis, scripts: await ScriptRunner.create(redis) };

  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
  });
  app = await buildApp({ env, isReady: () => true, live, redis });
});

afterAll(async () => {
  await app.close();
  redis.disconnect();
  await closeDb();
});

async function openLot(): Promise<SeededLot> {
  const seeded = await seedLot(db, { bidders: 3, rules: noSoftCloseRules, reserveNaira: 58_000 });
  await clearLotKeys(redis, seeded.lotId);
  await ensureLotState(live, seeded.lotId);
  return seeded;
}

describe('GET /lots/:lotId/state', () => {
  it('returns the lot without revealing the reserve or any maximum', async () => {
    const seeded = await openLot();
    try {
      const bidder = seeded.bidderIds[0];
      if (bidder === undefined) throw new Error('No bidders');
      await placeBid(
        live,
        {
          lotId: seeded.lotId,
          userId: bidder,
          maxKobo: naira(900_000),
          idempotencyKey: 'rest-1',
          bidLimitKobo: naira(10_000_000),
          limitReason: 'deposit_required',
        },
        Date.now(),
      );

      const response = await app.inject({ method: 'GET', url: `/lots/${seeded.lotId}/state` });
      expect(response.statusCode).toBe(200);

      const body = response.json<Record<string, unknown>>();
      expect(body.priceKobo).toBe(naira(50_000).toString());
      expect(body.leaderUserId).toBe(bidder);
      expect(body.hasReserve).toBe(true);
      expect(body.reserveMet).toBe(false);
      // Neither the reserve nor the bidder's maximum may appear anywhere.
      expect(Object.values(body)).not.toContain(naira(58_000).toString());
      expect(Object.values(body)).not.toContain(naira(900_000).toString());
      expect(Object.keys(body)).not.toContain('leaderMaxKobo');
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('is never cached, because a stale price is a price someone would bid against', async () => {
    const seeded = await openLot();
    try {
      const response = await app.inject({ method: 'GET', url: `/lots/${seeded.lotId}/state` });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('serves a cold lot by rebuilding it, which is the ordinary case', async () => {
    const seeded = await seedLot(db, { bidders: 1, rules: noSoftCloseRules });
    try {
      // No `ensureLotState`: Redis has never heard of this lot, exactly as when
      // somebody opens a page before anybody has bid.
      await clearLotKeys(redis, seeded.lotId);
      const response = await app.inject({ method: 'GET', url: `/lots/${seeded.lotId}/state` });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ seq: number }>().seq).toBe(0);
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('answers 404 for a lot that does not exist and 400 for a malformed id', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/lots/0b5f1f3e-0000-4000-8000-000000000000/state',
    });
    expect(missing.statusCode).toBe(404);

    const malformed = await app.inject({ method: 'GET', url: '/lots/not-a-uuid/state' });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('GET /lots/:lotId/events', () => {
  it('returns the events after the sequence number the caller has', async () => {
    const seeded = await openLot();
    try {
      const now = Date.now();
      for (const [index, bidder] of seeded.bidderIds.entries()) {
        await placeBid(
          live,
          {
            lotId: seeded.lotId,
            userId: bidder,
            maxKobo: naira(60_000 + index * 5_000),
            idempotencyKey: `rest_events_${String(index)}`,
            bidLimitKobo: naira(1_000_000),
            limitReason: 'deposit_required',
          },
          now + index,
        );
      }

      const response = await app.inject({
        method: 'GET',
        url: `/lots/${seeded.lotId}/events?fromSeq=1`,
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{ kind: string; events: Array<{ seq: number }> }>();
      expect(body.kind).toBe('deltas');
      expect(body.events.map((event) => event.seq)).toEqual([2, 3]);
      for (const event of body.events) {
        expect(Object.keys(event)).not.toContain('maxKobo');
      }
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('switches to a snapshot when the events the caller wants are gone', async () => {
    const seeded = await openLot();
    try {
      const now = Date.now();
      for (const [index, bidder] of seeded.bidderIds.entries()) {
        await placeBid(
          live,
          {
            lotId: seeded.lotId,
            userId: bidder,
            maxKobo: naira(60_000 + index * 5_000),
            idempotencyKey: `rest_trim_${String(index)}`,
            bidLimitKobo: naira(1_000_000),
            limitReason: 'deposit_required',
          },
          now + index,
        );
      }
      await redis.xtrim(`{lot:${seeded.lotId}}:events`, 'MAXLEN', 1);

      const response = await app.inject({
        method: 'GET',
        url: `/lots/${seeded.lotId}/events?fromSeq=0`,
      });
      const body = response.json<{ kind: string; snapshot: { seq: number } }>();
      expect(body.kind).toBe('snapshot');
      expect(body.snapshot.seq).toBe(3);
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('rejects a sequence number that is not one', async () => {
    const seeded = await openLot();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/lots/${seeded.lotId}/events?fromSeq=yesterday`,
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });
});

describe('GET /time', () => {
  it('gives a client with no socket the server clock to count down against', async () => {
    const before = Date.now();
    const response = await app.inject({ method: 'GET', url: '/time' });
    expect(response.statusCode).toBe(200);
    const { serverTime } = response.json<{ serverTime: number }>();
    expect(serverTime).toBeGreaterThanOrEqual(before);
    expect(serverTime).toBeLessThanOrEqual(Date.now());
  });
});
