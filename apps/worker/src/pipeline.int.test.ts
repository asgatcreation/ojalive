/**
 * The whole pipeline, end to end, with nothing stubbed.
 *
 * A lot is scheduled to end in two seconds. A bid is placed through the Lua
 * script. The real persistence loop drains it into Postgres. The real BullMQ
 * delayed job fires at the end time and closes the lot through all four layers.
 * Then the assertions check what a person would check: the auction ended, the
 * right bidder won, the price is right, and the log says exactly what happened.
 *
 * This is the "real run" the definition of done asks for on backend work.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { naira } from '@ojalive/shared';
import { bidEventsForLot, getClosure, getLotStateRow } from '@ojalive/db';
import { ensureLotState, placeBid, readLiveState } from '@ojalive/live';
import {
  cleanupLot,
  clearLotKeys,
  noSoftCloseRules,
  seedLot,
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
} from '@ojalive/live/int-support';
import { loadWorkerEnv } from './env.js';
import { createLogger } from './logger.js';
import { createWorkerContext, type WorkerContext } from './context.js';
import { createCloseQueue, createCloseWorker, scheduleLotClose } from './jobs/close-lot.js';
import { startPersistLoop } from './jobs/persist-bids.js';
import { sweepOnce } from './jobs/sweeper.js';

const env = loadWorkerEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  DATABASE_URL: TEST_DATABASE_URL,
  REDIS_URL: TEST_REDIS_URL,
  SWEEPER_INTERVAL_MS: '1000',
  SWEEPER_GRACE_MS: '0',
});

const logger = createLogger(env);
let ctx: WorkerContext;

beforeAll(async () => {
  ctx = await createWorkerContext(env);
});

afterAll(async () => {
  await ctx.close();
});

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null>,
  timeoutMillis = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMillis;
  for (;;) {
    const result = await probe();
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('the bidding pipeline, end to end', () => {
  it('accepts a bid, persists it, and closes the lot on time through the real job', async () => {
    const endsAt = Date.now() + 2_000;
    const seeded = await seedLot(ctx.db, {
      bidders: 3,
      rules: noSoftCloseRules,
      endsAt,
      reserveNaira: 55_000,
    });

    const queue = createCloseQueue(ctx.queueConnection);
    const closeWorker = createCloseWorker(ctx, queue, logger);
    const stopPersisting = startPersistLoop(ctx, { consumerName: 'pipeline-test' }, logger);

    try {
      await clearLotKeys(ctx.redis, seeded.lotId);
      await ensureLotState(ctx.live, seeded.lotId);

      const [winner, underbidder] = seeded.bidderIds;
      if (winner === undefined || underbidder === undefined) throw new Error('No bidders');

      const first = await placeBid(
        ctx.live,
        {
          lotId: seeded.lotId,
          userId: winner,
          maxKobo: naira(80_000),
          idempotencyKey: 'pipeline-1',
          bidLimitKobo: naira(1_000_000),
          limitReason: 'deposit_required',
        },
        Date.now(),
      );
      expect(first.kind).toBe('accepted');

      const second = await placeBid(
        ctx.live,
        {
          lotId: seeded.lotId,
          userId: underbidder,
          maxKobo: naira(70_000),
          idempotencyKey: 'pipeline-2',
          bidLimitKobo: naira(1_000_000),
          limitReason: 'deposit_required',
        },
        Date.now(),
      );
      expect(second.kind).toBe('accepted');

      // The persistence loop should get both bids into Postgres on its own.
      const persisted = await waitFor('both bids to reach Postgres', async () => {
        const events = await bidEventsForLot(ctx.db, seeded.lotId);
        return events.filter((event) => event.kind === 'bid').length === 2 ? events : null;
      });
      expect(persisted.map((event) => event.seq)).toEqual([1, 2]);
      // The underbidder's maximum is in the log, where it belongs, and the
      // price is one increment above it.
      expect(persisted[1]?.maxAmountKobo).toBe(naira(70_000));
      expect(persisted[1]?.priceAfterKobo).toBe(naira(71_000));
      expect(persisted[1]?.leaderAfterUserId).toBe(winner);

      // Schedule the close the way the API will when a lot opens, and let the
      // delayed job fire by itself.
      await scheduleLotClose(queue, seeded.lotId, endsAt);

      const closure = await waitFor('the lot to be closed', () => getClosure(ctx.db, seeded.lotId));

      expect(closure.outcome).toBe('sold');
      expect(closure.hammerPriceKobo).toBe(naira(71_000));
      expect(closure.winningBidEventId).not.toBeNull();

      // Redis agrees, the projection agrees, and the log has exactly one close.
      const live = await readLiveState(ctx.redis, seeded.lotId);
      expect(live?.status).toBe('closed');
      expect(live?.outcome).toBe('sold');
      expect(live?.leaderUserId).toBe(winner);

      const projection = await getLotStateRow(ctx.db, seeded.lotId);
      expect(projection?.priceKobo).toBe(naira(71_000));
      expect(projection?.leaderUserId).toBe(winner);
      expect(projection?.reserveMet).toBe(true);

      const finalEvents = await bidEventsForLot(ctx.db, seeded.lotId);
      expect(finalEvents.filter((event) => event.kind === 'close')).toHaveLength(1);
    } finally {
      await stopPersisting();
      await closeWorker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await clearLotKeys(ctx.redis, seeded.lotId);
      await cleanupLot(ctx.db, seeded);
    }
  });

  it('the sweeper closes a lot whose delayed job never existed', async () => {
    // The nightmare case: the lot ended, and no job was ever queued for it —
    // Redis was flushed, or the API died before scheduling. Nobody is coming.
    const endsAt = Date.now() - 10_000;
    const seeded = await seedLot(ctx.db, { bidders: 2, rules: noSoftCloseRules, endsAt });

    const queue = createCloseQueue(ctx.queueConnection);
    const closeWorker = createCloseWorker(ctx, queue, logger);

    try {
      await clearLotKeys(ctx.redis, seeded.lotId);
      await ensureLotState(ctx.live, seeded.lotId);

      const result = await sweepOnce(ctx, queue, 0, logger);
      expect(result.found).toBeGreaterThanOrEqual(1);

      const closure = await waitFor('the sweeper to get the lot closed', () =>
        getClosure(ctx.db, seeded.lotId),
      );

      // No bids were placed, so there is nothing to sell — and that is recorded
      // as an outcome rather than left as an open lot nobody understands.
      expect(closure.outcome).toBe('no_bids');
      expect(closure.winningBidEventId).toBeNull();
      expect((await readLiveState(ctx.redis, seeded.lotId))?.status).toBe('closed');
    } finally {
      await closeWorker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await clearLotKeys(ctx.redis, seeded.lotId);
      await cleanupLot(ctx.db, seeded);
    }
  });
});
