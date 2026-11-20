/**
 * What this milestone actually claims, tested against real Redis and real
 * Postgres: no bid is lost or doubled under concurrency, a retry places one
 * bid, a lot closes exactly once, and losing Redis entirely costs nothing
 * because the log can be replayed.
 *
 * These are not unit tests with a mock in place of the hard part. The hard part
 * IS the two stores and the race between them, so there is nothing useful to
 * mock.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { naira } from '@ojalive/shared';
import { apply, type LotState, type PlaceBidCommand } from '@ojalive/bid-engine';
import {
  bidEventsForLot,
  loadEngineState,
  lotsDueToClose,
  rebuildLotState,
  type Database,
} from '@ojalive/db';
import { closeLot, ensureLotState, placeBid, buyNow } from './bid-service.js';
import {
  cleanupLot,
  clearLotKeys,
  createHarness,
  describeState,
  noSoftCloseRules,
  seedLot,
  testRules,
  type Harness,
  type SeededLot,
} from './int-support.js';
import { persistStreamEvent } from './persist.js';
import { readLiveState } from './state.js';
import { ensureGroup, readGroupBatch, ackEvents, readAfterSeq, pendingCount } from './stream.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

/** Every event the lot's stream holds, oldest first. */
async function streamEvents(seeded: SeededLot) {
  return readAfterSeq(harness.redis, seeded.lotId, 0, 10_000);
}

function bidCommand(
  seeded: SeededLot,
  bidder: number,
  maxNaira: number,
  key: string,
): PlaceBidCommand {
  const userId = seeded.bidderIds[bidder % seeded.bidderIds.length];
  if (userId === undefined) throw new Error('The seeded lot has no bidders');
  return {
    kind: 'place_bid',
    lotId: seeded.lotId,
    userId,
    maxKobo: naira(maxNaira),
    idempotencyKey: key,
    bidLimitKobo: naira(1_000_000_000),
    limitReason: 'deposit_required',
  };
}

/** Drain the stream the way the worker does, into Postgres. */
async function persistEverything(db: Database, seeded: SeededLot): Promise<number> {
  await ensureGroup(harness.redis, seeded.lotId);
  let written = 0;
  for (;;) {
    const batch = await readGroupBatch(harness.redis, seeded.lotId, 'test-consumer', 500);
    if (batch.length === 0) break;
    for (const event of batch) {
      const outcome = await persistStreamEvent(db, event);
      if (outcome === 'written') written += 1;
    }
    await ackEvents(
      harness.redis,
      seeded.lotId,
      batch.map((event) => event.id),
    );
  }
  return written;
}

describe('concurrency on one lot', () => {
  it('processes 300 simultaneous bids in order, exactly once each', async () => {
    const seeded = await seedLot(harness.db, { bidders: 30, rules: noSoftCloseRules });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      const initial = await loadEngineState(harness.db, seeded.lotId);
      if (initial === null) throw new Error('The seeded lot has no state');

      const now = Date.now();
      // 300 bids fired at once, with rising maximums so plenty of them are
      // genuinely competitive rather than all being rejected as too low.
      const attempts = Array.from({ length: 300 }, (_, index) =>
        bidCommand(seeded, index % 30, 50_000 + index * 1_000, `race_${String(index)}`),
      );

      const results = await Promise.all(
        attempts.map((command) => placeBid(harness.ctx, command, now)),
      );

      const accepted = results.filter((result) => result.kind === 'accepted');
      const rejected = results.filter((result) => result.kind === 'rejected');
      expect(accepted.length + rejected.length).toBe(300);
      expect(accepted.length).toBeGreaterThan(5);

      // Every accepted bid got its own sequence number, and the numbers run
      // 1..n with no gaps and no repeats. This is the claim: no lost bid, no
      // doubled bid, whatever order they arrived in.
      const events = await streamEvents(seeded);
      const seqs = events.map((event) => event.seq);
      expect(seqs).toEqual(Array.from({ length: accepted.length }, (_, i) => i + 1));
      expect(new Set(seqs).size).toBe(seqs.length);

      // The price only ever rose.
      const prices = events.map((event) => event.priceKobo);
      for (let i = 1; i < prices.length; i += 1) {
        expect(prices[i]!).toBeGreaterThanOrEqual(prices[i - 1]!);
      }

      // And the order Redis happened to pick is a legal engine history: replay
      // the accepted bids through the pure engine and the state must match what
      // Redis holds, field for field.
      let replayed: LotState = initial;
      for (const event of events) {
        if (event.kind !== 'bid' || event.userId === null || event.maxKobo === null) continue;
        const result = apply(
          replayed,
          {
            kind: 'place_bid',
            lotId: seeded.lotId,
            userId: event.userId,
            maxKobo: event.maxKobo,
            idempotencyKey: event.idempotencyKey ?? '',
            bidLimitKobo: event.maxKobo,
            limitReason: 'deposit_required',
          },
          event.at,
        );
        expect(result.rejection, `replaying seq ${String(event.seq)} was rejected`).toBeUndefined();
        replayed = result.state;
      }

      const live = await readLiveState(harness.redis, seeded.lotId);
      expect(live).not.toBeNull();
      if (live !== null) expect(describeState(live)).toEqual(describeState(replayed));

      // The winner holds the highest maximum anyone bid successfully.
      const highest = events.reduce(
        (best, event) => (event.maxKobo! > best ? event.maxKobo! : best),
        0n,
      );
      expect(live?.leaderMaxKobo).toBe(highest);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });

  it('refuses two different bidders the same lead, even at the same millisecond', async () => {
    const seeded = await seedLot(harness.db, { bidders: 2, rules: noSoftCloseRules });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      const now = Date.now();

      const [first, second] = await Promise.all([
        placeBid(harness.ctx, bidCommand(seeded, 0, 80_000, 'same_ms_a'), now),
        placeBid(harness.ctx, bidCommand(seeded, 1, 78_000, 'same_ms_b'), now),
      ]);

      expect(first.kind).toBe('accepted');
      expect(second.kind).toBe('accepted');

      // Whoever Redis served first, the higher maximum leads at one increment
      // above the lower one — the worked example from design doc §7.4.
      const live = await readLiveState(harness.redis, seeded.lotId);
      expect(live?.leaderUserId).toBe(seeded.bidderIds[0]);
      expect(live?.priceKobo).toBe(naira(79_000));
      expect(live?.seq).toBe(2);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });
});

describe('idempotency', () => {
  it('answers a retried bid with the original outcome, not a second bid', async () => {
    const seeded = await seedLot(harness.db, { bidders: 2, rules: noSoftCloseRules });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      const now = Date.now();
      const command = bidCommand(seeded, 0, 60_000, 'one-and-only');

      const first = await placeBid(harness.ctx, command, now);
      const retry = await placeBid(harness.ctx, command, now + 5_000);

      expect(first.kind).toBe('accepted');
      expect(retry.kind).toBe('replayed');
      if (first.kind === 'accepted' && retry.kind === 'replayed') {
        expect(retry.snapshot.seq).toBe(first.snapshot.seq);
        expect(retry.snapshot.priceKobo).toBe(first.snapshot.priceKobo);
      }

      // One bid, one sequence number, one stream entry.
      expect((await streamEvents(seeded)).length).toBe(1);
      expect((await readLiveState(harness.redis, seeded.lotId))?.bidCount).toBe(1);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });

  it('places one bid when the same key arrives twenty times at once', async () => {
    const seeded = await seedLot(harness.db, { bidders: 2, rules: noSoftCloseRules });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      const now = Date.now();
      const command = bidCommand(seeded, 0, 60_000, 'double-tap');

      const results = await Promise.all(
        Array.from({ length: 20 }, () => placeBid(harness.ctx, command, now)),
      );

      expect(results.filter((result) => result.kind === 'accepted')).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'replayed')).toHaveLength(19);
      expect((await streamEvents(seeded)).length).toBe(1);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });

  it('keeps the database as the backstop: one row per key, enforced by a constraint', async () => {
    const seeded = await seedLot(harness.db, { bidders: 2, rules: noSoftCloseRules });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      const now = Date.now();
      await placeBid(harness.ctx, bidCommand(seeded, 0, 60_000, 'backstop'), now);

      // Persist the stream twice over. The second pass must write nothing: this
      // is at-least-once delivery becoming exactly-once storage.
      const firstPass = await persistEverything(harness.db, seeded);
      await harness.redis.xgroup('SETID', `{lot:${seeded.lotId}}:events`, 'persist', '0');
      const secondPass = await persistEverything(harness.db, seeded);

      expect(firstPass).toBe(1);
      expect(secondPass).toBe(0);
      expect(await bidEventsForLot(harness.db, seeded.lotId)).toHaveLength(1);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });
});

describe('closing exactly once', () => {
  it('closes once when twenty workers try at the same moment', async () => {
    const endsAt = Date.now() - 1_000;
    const seeded = await seedLot(harness.db, {
      bidders: 2,
      rules: noSoftCloseRules,
      endsAt,
      reserveNaira: 55_000,
    });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      // A bid placed before the end, so there is a winner to find.
      await placeBid(harness.ctx, bidCommand(seeded, 0, 60_000, 'pre-close'), endsAt - 60_000);
      await persistEverything(harness.db, seeded);

      const results = await Promise.all(
        Array.from({ length: 20 }, () => closeLot(harness.ctx, seeded.lotId, Date.now())),
      );

      const closed = results.filter((result) => result.kind === 'closed');
      expect(closed).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'already_closed')).toHaveLength(19);

      // Exactly one of the twenty wrote the closure row, and exactly one close
      // event exists. The unique constraint is what guarantees it, not the
      // ordering of the twenty calls.
      expect(
        results.filter((result) => 'wroteClosure' in result && result.wroteClosure),
      ).toHaveLength(1);
      const events = await bidEventsForLot(harness.db, seeded.lotId);
      expect(events.filter((event) => event.kind === 'close')).toHaveLength(1);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });

  it('reschedules instead of closing when the soft close moved the end time', async () => {
    const endsAt = Date.now() + 60_000;
    const seeded = await seedLot(harness.db, { bidders: 2, rules: testRules, endsAt });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);

      // A bid inside the 120-second window pushes the end out, and the lot row
      // is updated by persistence — which is what the close job re-reads.
      const bidAt = endsAt - 10_000;
      await placeBid(harness.ctx, bidCommand(seeded, 0, 60_000, 'snipe'), bidAt);
      await persistEverything(harness.db, seeded);

      const result = await closeLot(harness.ctx, seeded.lotId, endsAt + 1_000);
      expect(result.kind).toBe('not_yet_due');
      if (result.kind === 'not_yet_due') {
        expect(result.endsAt).toBe(bidAt + 120_000);
      }

      // Still open, nothing closed, nothing written.
      expect((await readLiveState(harness.redis, seeded.lotId))?.status).toBe('open');
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });

  it('finishes a closure that Redis completed but the worker died before writing', async () => {
    const endsAt = Date.now() - 1_000;
    const seeded = await seedLot(harness.db, { bidders: 2, rules: noSoftCloseRules, endsAt });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      await placeBid(harness.ctx, bidCommand(seeded, 0, 60_000, 'before-close'), endsAt - 60_000);
      await persistEverything(harness.db, seeded);

      // Close it in Redis only — the Lua compare-and-set alone, as if the
      // process had died immediately afterwards.
      await harness.ctx.scripts.run(
        'closeLot',
        [`{lot:${seeded.lotId}}:state`, `{lot:${seeded.lotId}}:events`],
        [Date.now().toString(), 'api'],
      );

      // The sweeper comes along later and finishes the job.
      const result = await closeLot(harness.ctx, seeded.lotId, Date.now());
      expect(result.kind).toBe('already_closed');
      if (result.kind === 'already_closed') expect(result.wroteClosure).toBe(true);

      const events = await bidEventsForLot(harness.db, seeded.lotId);
      expect(events.filter((event) => event.kind === 'close')).toHaveLength(1);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });

  it('the sweeper finds a lot that is past its end time', async () => {
    const seeded = await seedLot(harness.db, {
      bidders: 1,
      rules: noSoftCloseRules,
      endsAt: Date.now() - 60_000,
    });
    try {
      const due = await lotsDueToClose(harness.db, Date.now(), 5_000);
      expect(due.map((lot) => lot.id)).toContain(seeded.lotId);

      // And stops finding it once it is closed.
      await ensureLotState(harness.ctx, seeded.lotId);
      await closeLot(harness.ctx, seeded.lotId, Date.now());
      const after = await lotsDueToClose(harness.db, Date.now(), 5_000);
      expect(after.map((lot) => lot.id)).not.toContain(seeded.lotId);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });
});

describe('losing Redis entirely (design doc §8.2)', () => {
  it('rebuilds the lot from its log and carries on from the right sequence number', async () => {
    const endsAt = Date.now() + 600_000;
    const seeded = await seedLot(harness.db, { bidders: 4, rules: testRules, endsAt });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);

      const bidAt = endsAt - 60_000;
      await placeBid(harness.ctx, bidCommand(seeded, 0, 60_000, 'r1'), bidAt);
      await placeBid(harness.ctx, bidCommand(seeded, 1, 55_000, 'r2'), bidAt + 1);
      await placeBid(harness.ctx, bidCommand(seeded, 2, 75_000, 'r3'), bidAt + 2);
      await persistEverything(harness.db, seeded);

      const before = await readLiveState(harness.redis, seeded.lotId);
      expect(before).not.toBeNull();
      expect(before?.extensionCount).toBeGreaterThan(0);

      // Redis is gone: every key for this lot, as if it had restarted empty.
      await clearLotKeys(harness.redis, seeded.lotId);
      expect(await readLiveState(harness.redis, seeded.lotId)).toBeNull();

      // The next bid finds no state, triggers the rebuild, and is decided
      // against it. Nothing about this path is special-cased for recovery.
      const next = await placeBid(harness.ctx, bidCommand(seeded, 3, 90_000, 'r4'), bidAt + 3);
      expect(next.kind).toBe('accepted');

      const after = await readLiveState(harness.redis, seeded.lotId);
      expect(after?.seq).toBe(4);
      expect(after?.leaderUserId).toBe(seeded.bidderIds[3]);
      expect(after?.priceKobo).toBe(naira(76_000));
      // The extensions were recomputed from the log rather than restored from
      // anywhere: the three from before the loss, plus one for this new bid.
      expect(before?.extensionCount).toBe(3);
      expect(after?.extensionCount).toBe(4);
      expect(after?.endsAt).toBe(bidAt + 3 + 120_000);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });

  it('rebuilds the same state from the log as the live one, every time', async () => {
    const seeded = await seedLot(harness.db, { bidders: 4, rules: noSoftCloseRules });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      const now = Date.now();
      await placeBid(harness.ctx, bidCommand(seeded, 0, 60_000, 'p1'), now);
      await placeBid(harness.ctx, bidCommand(seeded, 1, 70_000, 'p2'), now + 1);
      await placeBid(harness.ctx, bidCommand(seeded, 2, 65_000, 'p3'), now + 2);
      await persistEverything(harness.db, seeded);

      const live = await readLiveState(harness.redis, seeded.lotId);
      const rebuilt = await rebuildLotState(harness.db, seeded.lotId);
      expect(rebuilt).not.toBeNull();
      if (live !== null && rebuilt !== null) {
        expect(rebuilt.state.priceKobo).toBe(live.priceKobo);
        expect(rebuilt.state.leaderUserId).toBe(live.leaderUserId);
        expect(rebuilt.state.leaderMaxKobo).toBe(live.leaderMaxKobo);
        expect(rebuilt.state.seq).toBe(live.seq);
        expect(rebuilt.state.bidCount).toBe(live.bidCount);
      }
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });
});

describe('Buy Now and the stream', () => {
  it('cannot be bought and bid on at the same time', async () => {
    const seeded = await seedLot(harness.db, {
      bidders: 4,
      rules: noSoftCloseRules,
      buyNowNaira: 70_000,
    });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      const now = Date.now();

      const buyer = seeded.bidderIds[0];
      if (buyer === undefined) throw new Error('No bidders');

      const [purchase, bid] = await Promise.all([
        buyNow(
          harness.ctx,
          {
            lotId: seeded.lotId,
            userId: buyer,
            idempotencyKey: 'buy',
            bidLimitKobo: naira(1_000_000),
            limitReason: 'deposit_required',
          },
          now,
        ),
        placeBid(harness.ctx, bidCommand(seeded, 1, 60_000, 'bid-vs-buy'), now),
      ]);

      // Exactly one of the two succeeded; which one depends on the order Redis
      // served them, and either order is correct.
      const accepted = [purchase, bid].filter((result) => result.kind === 'accepted');
      expect(accepted).toHaveLength(1);

      const live = await readLiveState(harness.redis, seeded.lotId);
      expect(live?.buyNowPriceKobo).toBeNull();
      if (purchase.kind === 'accepted') {
        expect(live?.status).toBe('closed');
        expect(live?.outcome).toBe('sold');
        expect(live?.priceKobo).toBe(naira(70_000));
      } else {
        expect(live?.status).toBe('open');
        expect(bid.kind).toBe('accepted');
      }
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });

  it('reports the persistence backlog, which is the durability risk window', async () => {
    const seeded = await seedLot(harness.db, { bidders: 2, rules: noSoftCloseRules });
    try {
      await clearLotKeys(harness.redis, seeded.lotId);
      await ensureLotState(harness.ctx, seeded.lotId);
      await ensureGroup(harness.redis, seeded.lotId);
      const now = Date.now();
      await placeBid(harness.ctx, bidCommand(seeded, 0, 60_000, 'lag1'), now);
      await placeBid(harness.ctx, bidCommand(seeded, 1, 70_000, 'lag2'), now + 1);

      // Read without acknowledging: these two are exactly the bids that are
      // accepted but not yet in Postgres (design doc §8.1).
      const batch = await readGroupBatch(harness.redis, seeded.lotId, 'lag-consumer', 10);
      expect(batch).toHaveLength(2);
      expect(await pendingCount(harness.redis, seeded.lotId)).toBe(2);

      for (const event of batch) await persistStreamEvent(harness.db, event);
      await ackEvents(
        harness.redis,
        seeded.lotId,
        batch.map((event) => event.id),
      );
      expect(await pendingCount(harness.redis, seeded.lotId)).toBe(0);
    } finally {
      await clearLotKeys(harness.redis, seeded.lotId);
      await cleanupLot(harness.db, seeded);
    }
  });
});
