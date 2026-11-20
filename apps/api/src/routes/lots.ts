/**
 * The REST fallback for the real-time data.
 *
 * Everything a socket delivers is also available over plain HTTP, for one
 * practical reason: on a slow or filtered Nigerian mobile connection,
 * WebSockets sometimes simply do not establish. A bidder on such a connection
 * should get a working, if less lively, auction page rather than a spinner.
 *
 * These routes are **read-only**. There is no bid endpoint yet, deliberately:
 * placing a bid needs an authenticated caller, and authentication arrives in
 * milestone 7. An endpoint that took a user id on trust would be a hole, and
 * shipping one "just for the demo" is how holes become permanent.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  ensureLotState,
  oldestRetainedSeq,
  readAfterSeq,
  readLiveState,
  toPublicEvent,
  toPublicSnapshot,
  type LiveContext,
} from '@ojalive/live';
import type { Redis } from 'ioredis';

const lotParamsSchema = z.object({ lotId: z.string().uuid() });
const eventsQuerySchema = z.object({
  fromSeq: z.coerce.number().int().nonnegative().default(0),
});

export interface LotRoutesOptions {
  readonly live: LiveContext;
  readonly redis: Redis;
}

export function registerLotRoutes(app: FastifyInstance, options: LotRoutesOptions): void {
  const { live, redis } = options;

  /** The server's clock, for a client with no socket to do the §7.6 exchange on. */
  app.get('/time', () => ({ serverTime: Date.now() }));

  app.get('/lots/:lotId/state', async (request, reply) => {
    const params = lotParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_lot_id' });

    const { lotId } = params.data;
    let state = await readLiveState(redis, lotId);
    if (state === null) {
      const installed = await ensureLotState(live, lotId);
      if (installed === 'unknown_lot') return reply.code(404).send({ error: 'unknown_lot' });
      state = await readLiveState(redis, lotId);
    }
    if (state === null) return reply.code(404).send({ error: 'unknown_lot' });

    // A lot's price changes constantly; caching it even briefly would show
    // somebody a stale price and let them bid against it.
    reply.header('cache-control', 'no-store');
    return toPublicSnapshot(state, Date.now());
  });

  app.get('/lots/:lotId/events', async (request, reply) => {
    const params = lotParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'bad_lot_id' });
    const query = eventsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'bad_from_seq' });

    const { lotId } = params.data;
    const { fromSeq } = query.data;
    reply.header('cache-control', 'no-store');

    // The same decision the socket resync makes: if the stream no longer
    // reaches back that far, deltas would skip events, so say so and send a
    // snapshot instead of pretending.
    const oldest = await oldestRetainedSeq(redis, lotId);
    if (oldest !== null && oldest > fromSeq + 1) {
      let state = await readLiveState(redis, lotId);
      if (state === null) {
        const installed = await ensureLotState(live, lotId);
        if (installed === 'unknown_lot') return reply.code(404).send({ error: 'unknown_lot' });
        state = await readLiveState(redis, lotId);
      }
      if (state === null) return reply.code(404).send({ error: 'unknown_lot' });
      return { kind: 'snapshot' as const, snapshot: toPublicSnapshot(state, Date.now()) };
    }

    const missed = await readAfterSeq(redis, lotId, fromSeq);
    return { kind: 'deltas' as const, events: missed.map(toPublicEvent) };
  });
}
