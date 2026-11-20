/**
 * The real-time layer.
 *
 * Socket.IO with `@socket.io/redis-adapter` so several API instances share
 * rooms (ADR-0006). One thing about the emits is worth saying plainly, because
 * it is the opposite of the usual pattern: **every emit here is `io.local`**.
 *
 * Each instance tails the event streams of the lots its own sockets watch (see
 * `tailer.ts`), so each instance already has the deltas for its own clients. If
 * it emitted through the adapter as well, every client would receive one copy
 * per instance. Local emits plus independent tailing give exactly one delivery
 * per client and need no de-duplication. The adapter is still there, and still
 * earns its place: cross-instance watcher counts come from it.
 */

import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import type { RealtimeLogger } from './logging.js';
import {
  ensureLotState,
  oldestRetainedSeq,
  readAfterSeq,
  readLiveState,
  toPublicEvent,
  toPublicSnapshot,
  type LiveContext,
  type PublicLotSnapshot,
} from '@ojalive/live';
import {
  CLIENT_EVENTS,
  lotRoom,
  resyncPayloadSchema,
  SERVER_EVENTS,
  timePayloadSchema,
  unwatchPayloadSchema,
  watchPayloadSchema,
  type ResyncReply,
  type TimeReply,
} from './protocol.js';
import { TailerRegistry } from './tailer.js';

export interface RealtimeOptions {
  readonly httpServer: HttpServer;
  readonly live: LiveContext;
  readonly redis: Redis;
  readonly logger: RealtimeLogger;
  readonly corsOrigins: readonly string[];
  /** How often watcher counts are recalculated and sent. */
  readonly presenceIntervalMillis?: number;
  readonly onBidAcknowledged?: (lotId: string, seq: number) => void;
}

export interface Realtime {
  readonly io: Server;
  readonly watcherCount: (lotId: string) => Promise<number>;
  readonly close: () => Promise<void>;
}

/**
 * The lot's state, rebuilding it from Postgres if Redis has none.
 *
 * A cold lot being watched is the ordinary case — somebody opens a page before
 * anybody bids — so this is the normal path, not a recovery path.
 */
async function snapshotFor(
  live: LiveContext,
  redis: Redis,
  lotId: string,
): Promise<PublicLotSnapshot | null> {
  let state = await readLiveState(redis, lotId);
  if (state === null) {
    const installed = await ensureLotState(live, lotId);
    if (installed === 'unknown_lot') return null;
    state = await readLiveState(redis, lotId);
  }
  return state === null ? null : toPublicSnapshot(state, Date.now());
}

export function createRealtime(options: RealtimeOptions): Realtime {
  const { httpServer, live, redis, logger } = options;

  const io = new Server(httpServer, {
    path: '/socket',
    cors: { origin: [...options.corsOrigins], credentials: true },
    // Deltas are small and frequent; the defaults are tuned for larger, rarer
    // messages. A phone on 4G benefits more from short pings than from fewer.
    pingInterval: 20_000,
    pingTimeout: 20_000,
    serveClient: false,
  });

  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  const tailers = new TailerRegistry(
    redis,
    (lotId, events) => {
      for (const event of events) {
        io.local.to(lotRoom(lotId)).emit(SERVER_EVENTS.delta, event);
      }
      const last = events[events.length - 1];
      if (last !== undefined) options.onBidAcknowledged?.(lotId, last.seq);
    },
    logger,
  );

  /** Watchers across every instance, from the adapter. */
  const watcherCount = async (lotId: string): Promise<number> => {
    const sockets = await io.in(lotRoom(lotId)).fetchSockets();
    return sockets.length;
  };

  const lastAnnounced = new Map<string, number>();

  const announcePresence = async (): Promise<void> => {
    for (const lotId of tailers.lots()) {
      try {
        const count = await watcherCount(lotId);
        if (lastAnnounced.get(lotId) === count) continue;
        lastAnnounced.set(lotId, count);
        io.local.to(lotRoom(lotId)).emit(SERVER_EVENTS.watchers, { lotId, watchers: count });
      } catch (error: unknown) {
        logger.debug({ lotId, error }, 'could not count watchers');
      }
    }
  };

  const presenceTimer = setInterval(() => {
    void announcePresence();
  }, options.presenceIntervalMillis ?? 3_000);

  io.on('connection', (socket: Socket) => {
    logger.debug({ socketId: socket.id }, 'socket connected');
    const watching = new Set<string>();

    socket.on(CLIENT_EVENTS.watch, (raw: unknown, ack?: (reply: unknown) => void) => {
      void (async () => {
        const parsed = watchPayloadSchema.safeParse(raw);
        if (!parsed.success) {
          socket.emit(SERVER_EVENTS.problem, { reason: 'bad_request' });
          ack?.({ kind: 'bad_request' });
          return;
        }
        const { lotId } = parsed.data;

        const snapshot = await snapshotFor(live, redis, lotId);
        if (snapshot === null) {
          socket.emit(SERVER_EVENTS.problem, { lotId, reason: 'unknown_lot' });
          ack?.({ kind: 'unknown_lot' });
          return;
        }

        await socket.join(lotRoom(lotId));
        watching.add(lotId);
        // Tail from the snapshot's seq, so nothing between the snapshot and the
        // first delta is skipped and nothing before it is repeated.
        tailers.acquire(lotId, snapshot.seq);

        socket.emit(SERVER_EVENTS.snapshot, snapshot);
        ack?.({ kind: 'watching', snapshot });
        void announcePresence();
      })();
    });

    socket.on(CLIENT_EVENTS.unwatch, (raw: unknown, ack?: (reply: unknown) => void) => {
      void (async () => {
        const parsed = unwatchPayloadSchema.safeParse(raw);
        if (!parsed.success) {
          ack?.({ kind: 'bad_request' });
          return;
        }
        const { lotId } = parsed.data;
        await socket.leave(lotRoom(lotId));
        if (watching.delete(lotId)) await tailers.release(lotId);
        ack?.({ kind: 'stopped' });
      })();
    });

    socket.on(CLIENT_EVENTS.resync, (raw: unknown, ack?: (reply: ResyncReply) => void) => {
      void (async () => {
        const parsed = resyncPayloadSchema.safeParse(raw);
        if (!parsed.success) {
          ack?.({ kind: 'unknown_lot' });
          return;
        }
        const { lotId, fromSeq } = parsed.data;

        // If the stream no longer reaches back to where the client left off,
        // deltas would silently skip events. A snapshot is the honest answer.
        const oldest = await oldestRetainedSeq(redis, lotId);
        if (oldest !== null && oldest > fromSeq + 1) {
          const snapshot = await snapshotFor(live, redis, lotId);
          ack?.(snapshot === null ? { kind: 'unknown_lot' } : { kind: 'snapshot', snapshot });
          return;
        }

        const missed = await readAfterSeq(redis, lotId, fromSeq);
        ack?.({ kind: 'deltas', events: missed.map(toPublicEvent) });
      })();
    });

    socket.on(CLIENT_EVENTS.time, (raw: unknown, ack?: (reply: TimeReply) => void) => {
      const parsed = timePayloadSchema.safeParse(raw);
      // The server's clock is the only one that decides anything; this exchange
      // just lets the client draw a countdown that agrees with it (§7.6).
      ack?.({ t0: parsed.success ? parsed.data.t0 : 0, t1: Date.now() });
    });

    socket.on('disconnect', () => {
      void (async () => {
        for (const lotId of watching) await tailers.release(lotId);
        watching.clear();
      })();
    });
  });

  return {
    io,
    watcherCount,
    close: async () => {
      clearInterval(presenceTimer);
      await tailers.stopAll();
      await io.close();
      pubClient.disconnect();
      subClient.disconnect();
    },
  };
}
