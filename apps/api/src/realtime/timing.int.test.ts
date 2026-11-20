/**
 * What a watcher actually waits, bid by bid.
 *
 * This exists because two of the tests in `realtime.int.test.ts` took five and
 * eight seconds, which looked like a delivery problem next to a 500 ms target.
 * It is not: those seconds are Postgres seeding and cleanup around the
 * assertions. Measuring the deltas on their own separates the two, and the
 * numbers go in the docs rather than being averaged into a pass.
 *
 * Measured on one developer machine against Docker, so these are a floor, not a
 * promise about a phone in Lagos. Milestone 11 publishes the real ones under
 * load. The first delta is slower than the rest on purpose: a lot's tailer
 * opens its own Redis connection when the first watcher arrives, and that
 * handshake is counted here rather than hidden.
 */

import { createServer } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { io as connect } from 'socket.io-client';
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
} from '@ojalive/live/int-support';
import { createRealtime } from './server.js';
import { CLIENT_EVENTS, SERVER_EVENTS } from './protocol.js';
import type { RealtimeLogger } from './logging.js';

const quiet: RealtimeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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
});

afterAll(async () => {
  redis.disconnect();
  await closeDb();
});

it('delivers the first delta in under a second and the rest well inside the target', async () => {
  const http = createServer();
  const realtime = createRealtime({
    httpServer: http,
    live,
    redis,
    logger: quiet,
    corsOrigins: ['http://localhost:3001'],
  });
  await new Promise<void>((resolve) => http.listen(4399, '127.0.0.1', resolve));

  const seeded = await seedLot(db, { bidders: 5, rules: noSoftCloseRules });
  try {
    await clearLotKeys(redis, seeded.lotId);
    await ensureLotState(live, seeded.lotId);

    const socket = connect('http://127.0.0.1:4399', {
      path: '/socket',
      transports: ['websocket'],
      reconnection: false,
    });
    const arrivals: Array<{ seq: number; at: number }> = [];
    socket.on(SERVER_EVENTS.delta, (payload: { seq: number }) => {
      arrivals.push({ seq: Number(payload.seq), at: Date.now() });
    });
    await new Promise<void>((resolve) => {
      socket.emit(CLIENT_EVENTS.watch, { lotId: seeded.lotId }, () => resolve());
    });

    const latencies: number[] = [];
    for (const [index, bidder] of seeded.bidderIds.entries()) {
      const sentAt = Date.now();
      await placeBid(
        live,
        {
          lotId: seeded.lotId,
          userId: bidder,
          maxKobo: naira(60_000 + index * 5_000),
          idempotencyKey: `timing_${String(index)}`,
          bidLimitKobo: naira(10_000_000),
          limitReason: 'deposit_required',
        },
        sentAt,
      );
      while (arrivals.length <= index) await new Promise((resolve) => setTimeout(resolve, 5));
      latencies.push((arrivals[index]?.at ?? 0) - sentAt);
    }

    // Printed on purpose: publishing measured numbers is one of this project's
    // goals, and a test that measures something should say what it measured.
    console.log(`delta latencies, first to last (ms): ${latencies.join(', ')}`);

    const [first, ...rest] = latencies;
    expect(first ?? Number.MAX_SAFE_INTEGER).toBeLessThan(1_000);
    for (const latency of rest) {
      expect(latency).toBeLessThan(500);
    }
    // Deltas arrive in sequence order, and exactly once each.
    expect(arrivals.map((arrival) => arrival.seq)).toEqual(
      Array.from({ length: seeded.bidderIds.length }, (_, i) => i + 1),
    );

    socket.disconnect();
  } finally {
    await realtime.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await clearLotKeys(redis, seeded.lotId);
    await cleanupLot(db, seeded);
  }
});
