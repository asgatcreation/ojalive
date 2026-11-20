/**
 * Two API instances, one Redis, real socket clients.
 *
 * This is the claim milestone 5 exists to prove: a bid accepted anywhere
 * reaches every watcher, wherever they are connected, in order, once each, and
 * inside the 500 ms target. It is tested with two real HTTP servers on two
 * ports and real `socket.io-client` connections spread across both.
 *
 * What it is NOT: a browser test. The milestone plan said Playwright across
 * several browsers, and that is deferred to milestone 7 for an honest reason —
 * there is no bidding UI to drive yet, so a browser would only prove that the
 * same socket client works inside Chromium. The claim above is about the
 * server, and this tests the server. The browser pass lands with the UI.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { Redis } from 'ioredis';
import { naira } from '@ojalive/shared';
import { createDb, type Database } from '@ojalive/db';
import { closeLot, ensureLotState, placeBid, ScriptRunner, type LiveContext } from '@ojalive/live';
import {
  cleanupLot,
  clearLotKeys,
  noSoftCloseRules,
  seedLot,
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  type SeededLot,
} from '@ojalive/live/int-support';
import { createRealtime, type Realtime } from './server.js';
import { CLIENT_EVENTS, SERVER_EVENTS, type ResyncReply, type TimeReply } from './protocol.js';
import type { RealtimeLogger } from './logging.js';

const quiet: RealtimeLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Instance {
  readonly port: number;
  readonly http: HttpServer;
  readonly realtime: Realtime;
}

let db: Database;
let closeDb: () => Promise<void>;
let redis: Redis;
let live: LiveContext;
const instances: Instance[] = [];
const clients: ClientSocket[] = [];

async function startInstance(port: number): Promise<Instance> {
  const http = createServer();
  const realtime = createRealtime({
    httpServer: http,
    live,
    redis,
    logger: quiet,
    corsOrigins: ['http://localhost:3001'],
    presenceIntervalMillis: 250,
  });
  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
  const instance = { port, http, realtime };
  instances.push(instance);
  return instance;
}

function client(port: number): ClientSocket {
  const socket = connect(`http://127.0.0.1:${String(port)}`, {
    path: '/socket',
    transports: ['websocket'],
    reconnection: false,
  });
  clients.push(socket);
  return socket;
}

async function watch(socket: ClientSocket, lotId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watch timed out')), 10_000);
    socket.emit(CLIENT_EVENTS.watch, { lotId }, (reply: unknown) => {
      clearTimeout(timer);
      const kind =
        typeof reply === 'object' && reply !== null && 'kind' in reply ? reply.kind : null;
      if (kind === 'watching') resolve();
      else reject(new Error(`watch refused: ${String(kind)}`));
    });
  });
}

interface Received {
  readonly seq: number;
  readonly priceKobo: string;
  readonly receivedAt: number;
  readonly payload: Record<string, unknown>;
}

/** Collect deltas as they arrive, with the local time they landed. */
function collect(socket: ClientSocket): Received[] {
  const received: Received[] = [];
  socket.on(SERVER_EVENTS.delta, (payload: Record<string, unknown>) => {
    received.push({
      seq: Number(payload.seq),
      priceKobo: String(payload.priceKobo),
      receivedAt: Date.now(),
      payload,
    });
  });
  return received;
}

async function waitUntil(
  what: string,
  ready: () => boolean,
  timeoutMillis = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMillis;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(async () => {
  const handle = createDb({ url: TEST_DATABASE_URL, max: 10 });
  db = handle.db;
  closeDb = handle.close;
  redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 3 });
  live = { db, redis, scripts: await ScriptRunner.create(redis) };

  // Two instances, as there will be in production (ADR-0002).
  await startInstance(4301);
  await startInstance(4302);
}, 60_000);

afterAll(async () => {
  for (const socket of clients) socket.disconnect();
  for (const instance of instances) {
    await instance.realtime.close();
    await new Promise<void>((resolve) => instance.http.close(() => resolve()));
  }
  redis.disconnect();
  await closeDb();
});

async function seedWatchedLot(): Promise<SeededLot> {
  const seeded = await seedLot(db, { bidders: 6, rules: noSoftCloseRules });
  await clearLotKeys(redis, seeded.lotId);
  await ensureLotState(live, seeded.lotId);
  return seeded;
}

describe('deltas across two instances', () => {
  it('reaches watchers on both instances, in order and once each', async () => {
    const seeded = await seedWatchedLot();
    try {
      const onA = client(4301);
      const onB = client(4302);
      const alsoOnB = client(4302);

      await Promise.all([
        watch(onA, seeded.lotId),
        watch(onB, seeded.lotId),
        watch(alsoOnB, seeded.lotId),
      ]);

      const fromA = collect(onA);
      const fromB = collect(onB);
      const fromAlsoB = collect(alsoOnB);

      const now = Date.now();
      for (const [index, bidder] of seeded.bidderIds.entries()) {
        await placeBid(
          live,
          {
            lotId: seeded.lotId,
            userId: bidder,
            maxKobo: naira(60_000 + index * 5_000),
            idempotencyKey: `rt_${String(index)}`,
            bidLimitKobo: naira(1_000_000),
            limitReason: 'deposit_required',
          },
          now + index,
        );
      }

      const expected = seeded.bidderIds.length;
      await waitUntil(
        'every client to see every bid',
        () => fromA.length >= expected && fromB.length >= expected && fromAlsoB.length >= expected,
      );

      // Once each, in sequence order, on every client — including the two
      // sharing an instance, which must not receive doubles.
      for (const received of [fromA, fromB, fromAlsoB]) {
        expect(received.map((event) => event.seq)).toEqual(
          Array.from({ length: expected }, (_, i) => i + 1),
        );
      }
      // And the same prices: there is one ordering authority, not one per node.
      expect(fromA.map((event) => event.priceKobo)).toEqual(fromB.map((event) => event.priceKobo));
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('delivers inside the 500 ms target, measured end to end', async () => {
    const seeded = await seedWatchedLot();
    try {
      const onA = client(4301);
      const onB = client(4302);
      await Promise.all([watch(onA, seeded.lotId), watch(onB, seeded.lotId)]);
      const fromA = collect(onA);
      const fromB = collect(onB);

      const latencies: number[] = [];
      const rounds = 12;
      for (let round = 0; round < rounds; round += 1) {
        const bidder = seeded.bidderIds[round % seeded.bidderIds.length];
        if (bidder === undefined) throw new Error('No bidders');
        const before = fromA.length;
        const sentAt = Date.now();
        await placeBid(
          live,
          {
            lotId: seeded.lotId,
            userId: bidder,
            maxKobo: naira(60_000 + round * 5_000),
            idempotencyKey: `lat_${String(round)}`,
            bidLimitKobo: naira(10_000_000),
            limitReason: 'deposit_required',
          },
          sentAt,
        );
        await waitUntil('the delta to arrive on both instances', () => {
          return fromA.length > before && fromB.length > before;
        });
        const a = fromA[fromA.length - 1];
        const b = fromB[fromB.length - 1];
        if (a === undefined || b === undefined) throw new Error('No delta recorded');
        latencies.push(Math.max(a.receivedAt, b.receivedAt) - sentAt);
      }

      latencies.sort((x, y) => x - y);
      const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
      expect(p95).toBeDefined();
      // The service target from design doc §5. Measured here on one machine, so
      // it is a floor rather than a promise about Lagos — milestone 11 publishes
      // the real numbers under load.
      expect(p95 ?? Number.MAX_SAFE_INTEGER).toBeLessThan(500);
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('broadcasts a close that the worker performed, not the API', async () => {
    const endsAt = Date.now() - 1_000;
    const seeded = await seedLot(db, { bidders: 2, rules: noSoftCloseRules, endsAt });
    try {
      await clearLotKeys(redis, seeded.lotId);
      await ensureLotState(live, seeded.lotId);

      const watcher = client(4301);
      await watch(watcher, seeded.lotId);
      const received = collect(watcher);

      // Closing happens in `@ojalive/live`, which is what the worker calls. No
      // API instance emits anything here: the delta arrives because the close
      // was appended to the lot's stream and the tailer is reading it.
      const result = await closeLot(live, seeded.lotId, Date.now());
      expect(result.kind).toBe('closed');

      await waitUntil('the close to reach the watcher', () => received.length >= 1);
      const last = received[received.length - 1];
      expect(last?.payload.kind).toBe('close');
      expect(last?.payload.lotOutcome).toBe('unsold_no_bids');
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('never broadcasts a bidder’s maximum', async () => {
    const seeded = await seedWatchedLot();
    try {
      const watcher = client(4301);
      await watch(watcher, seeded.lotId);
      const received = collect(watcher);

      const bidder = seeded.bidderIds[0];
      if (bidder === undefined) throw new Error('No bidders');
      await placeBid(
        live,
        {
          lotId: seeded.lotId,
          userId: bidder,
          // A maximum far above the price it will actually pay.
          maxKobo: naira(900_000),
          idempotencyKey: 'secret',
          bidLimitKobo: naira(10_000_000),
          limitReason: 'deposit_required',
        },
        Date.now(),
      );

      await waitUntil('the delta', () => received.length >= 1);
      const payload = received[0]?.payload ?? {};
      expect(payload.priceKobo).toBe(naira(50_000).toString());
      expect(Object.values(payload)).not.toContain(naira(900_000).toString());
      expect(Object.keys(payload)).not.toContain('maxKobo');
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });
});

describe('reconnecting', () => {
  it('catches a client up from the sequence number it last saw', async () => {
    const seeded = await seedWatchedLot();
    try {
      const watcher = client(4301);
      await watch(watcher, seeded.lotId);
      const received = collect(watcher);

      const now = Date.now();
      for (const [index, bidder] of seeded.bidderIds.entries()) {
        await placeBid(
          live,
          {
            lotId: seeded.lotId,
            userId: bidder,
            maxKobo: naira(60_000 + index * 5_000),
            idempotencyKey: `sync_${String(index)}`,
            bidLimitKobo: naira(1_000_000),
            limitReason: 'deposit_required',
          },
          now + index,
        );
      }
      await waitUntil('all deltas', () => received.length >= seeded.bidderIds.length);

      // As if this client had been offline since seq 2.
      const reply = await new Promise<ResyncReply>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('resync timed out')), 10_000);
        watcher.emit(
          CLIENT_EVENTS.resync,
          { lotId: seeded.lotId, fromSeq: 2 },
          (r: ResyncReply) => {
            clearTimeout(timer);
            resolve(r);
          },
        );
      });

      expect(reply.kind).toBe('deltas');
      if (reply.kind === 'deltas') {
        expect(reply.events.map((event) => event.seq)).toEqual(
          Array.from({ length: seeded.bidderIds.length - 2 }, (_, i) => i + 3),
        );
        // The catch-up is subject to the same rule as the live feed.
        for (const event of reply.events) {
          expect(Object.keys(event)).not.toContain('maxKobo');
        }
      }
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('sends a snapshot instead of deltas when the events are gone', async () => {
    const seeded = await seedWatchedLot();
    try {
      const watcher = client(4301);
      await watch(watcher, seeded.lotId);

      // Three bids, so the stream holds seq 1, 2 and 3.
      const now = Date.now();
      for (const [index, bidder] of seeded.bidderIds.slice(0, 3).entries()) {
        await placeBid(
          live,
          {
            lotId: seeded.lotId,
            userId: bidder,
            maxKobo: naira(60_000 + index * 5_000),
            idempotencyKey: `trim_${String(index)}`,
            bidLimitKobo: naira(1_000_000),
            limitReason: 'deposit_required',
          },
          now + index,
        );
      }

      // Now trim it to its newest entry only, which is what retention does to a
      // busy lot over time. A client asking from seq 0 cannot be caught up with
      // deltas any more: seq 1 and 2 are genuinely gone.
      await redis.xtrim(`{lot:${seeded.lotId}}:events`, 'MAXLEN', 1);

      const reply = await new Promise<ResyncReply>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('resync timed out')), 10_000);
        watcher.emit(
          CLIENT_EVENTS.resync,
          { lotId: seeded.lotId, fromSeq: 0 },
          (r: ResyncReply) => {
            clearTimeout(timer);
            resolve(r);
          },
        );
      });

      // The honest answer is "start again", not a feed with a hole in it.
      expect(reply.kind).toBe('snapshot');
      if (reply.kind === 'snapshot') {
        expect(reply.snapshot.seq).toBe(3);
        expect(reply.snapshot.bidCount).toBe(3);
        expect(Object.keys(reply.snapshot)).not.toContain('leaderMaxKobo');
      }
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('still sends deltas when the client is only just inside the window', async () => {
    const seeded = await seedWatchedLot();
    try {
      const watcher = client(4301);
      await watch(watcher, seeded.lotId);

      const bidder = seeded.bidderIds[0];
      if (bidder === undefined) throw new Error('No bidders');
      await placeBid(
        live,
        {
          lotId: seeded.lotId,
          userId: bidder,
          maxKobo: naira(60_000),
          idempotencyKey: 'edge',
          bidLimitKobo: naira(1_000_000),
          limitReason: 'deposit_required',
        },
        Date.now(),
      );

      // The stream starts at seq 1 and the client last saw seq 0, so nothing is
      // missing. This is the boundary the previous test sits just past.
      const reply = await new Promise<ResyncReply>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('resync timed out')), 10_000);
        watcher.emit(
          CLIENT_EVENTS.resync,
          { lotId: seeded.lotId, fromSeq: 0 },
          (r: ResyncReply) => {
            clearTimeout(timer);
            resolve(r);
          },
        );
      });

      expect(reply.kind).toBe('deltas');
      if (reply.kind === 'deltas') {
        expect(reply.events.map((event) => event.seq)).toEqual([1]);
      }
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });
});

describe('presence and the clock', () => {
  /** Poll the adapter until the watcher count settles on what we expect. */
  async function waitForWatchers(
    instance: Instance,
    lotId: string,
    expected: number,
  ): Promise<number> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const last = await instance.realtime.watcherCount(lotId);
      if (last === expected) return last;
      if (Date.now() > deadline) {
        throw new Error(`watchers never reached ${String(expected)} (last saw ${String(last)})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('counts watchers across both instances', async () => {
    const seeded = await seedWatchedLot();
    try {
      const first = instances[0];
      if (first === undefined) throw new Error('No instance');

      const onA = client(4301);
      const onB = client(4302);
      await Promise.all([watch(onA, seeded.lotId), watch(onB, seeded.lotId)]);

      // The count comes from the Redis adapter, so one instance sees the
      // other's sockets. That is why the adapter is mounted at all, given that
      // deltas themselves are delivered locally.
      expect(await waitForWatchers(first, seeded.lotId, 2)).toBe(2);

      onB.disconnect();
      expect(await waitForWatchers(first, seeded.lotId, 1)).toBe(1);
    } finally {
      await clearLotKeys(redis, seeded.lotId);
      await cleanupLot(db, seeded);
    }
  });

  it('answers the clock exchange with the server’s time and the echoed t0', async () => {
    const socket = client(4301);
    const t0 = Date.now();
    const reply = await new Promise<TimeReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('time timed out')), 10_000);
      socket.emit(CLIENT_EVENTS.time, { t0 }, (r: TimeReply) => {
        clearTimeout(timer);
        resolve(r);
      });
    });

    expect(reply.t0).toBe(t0);
    expect(reply.t1).toBeGreaterThanOrEqual(t0);
    // A client takes the median of several of these and draws its countdown
    // against server time; it never decides a lot has closed by itself (§7.6).
    expect(reply.t1 - t0).toBeLessThan(5_000);
  });
});
