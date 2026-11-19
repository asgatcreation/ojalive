/**
 * The differential test: the Lua script versus the pure engine.
 *
 * `packages/bid-engine` is the reference. The Lua script is what actually
 * decides every real bid, because it is the only thing that can run atomically
 * inside Redis. Two implementations of the same rules will drift — that is not
 * pessimism, it is what happened to every system that has ever had a fast path
 * and a model of the fast path.
 *
 * So: random command sequences, both implementations, state compared field by
 * field after every single command, and the same comparison for every
 * rejection. This test is the reason the Lua script can be trusted with money.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { naira } from '@ojalive/shared';
import { apply, type LotState, type PlaceBidCommand } from '@ojalive/bid-engine';
import { loadEngineState } from '@ojalive/db';
import { placeBid, closeLot, ensureLotState } from './bid-service.js';
import {
  cleanupLot,
  clearLotKeys,
  createHarness,
  describeState,
  noSoftCloseRules,
  seedLot,
  testRules,
  type Harness,
} from './int-support.js';
import { snapshotToState } from './replies.js';
import { readLiveState } from './state.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

interface RawBid {
  readonly bidder: number;
  readonly thousands: number;
  readonly offsetSeconds: number;
}

const rawBids = (maxLength: number) =>
  fc.array(
    fc.record({
      bidder: fc.integer({ min: 0, max: 3 }),
      thousands: fc.integer({ min: 45, max: 300 }),
      offsetSeconds: fc.integer({ min: 0, max: 0 }),
    }),
    { minLength: 1, maxLength },
  );

/**
 * Run one sequence through both implementations.
 *
 * The engine starts from the same state Redis was seeded with, so any
 * divergence is the scripts' doing and not a different starting point.
 */
async function runBoth(options: {
  readonly bids: readonly RawBid[];
  readonly rules: typeof testRules;
  readonly endsAt: number;
  readonly startAt: number;
  readonly closeAtEnd: boolean;
}): Promise<void> {
  const seeded = await seedLot(harness.db, {
    bidders: 4,
    rules: options.rules,
    endsAt: options.endsAt,
    reserveNaira: 58_000,
  });

  try {
    await clearLotKeys(harness.redis, seeded.lotId);
    await ensureLotState(harness.ctx, seeded.lotId);

    const initial = await loadEngineState(harness.db, seeded.lotId);
    if (initial === null) throw new Error('The seeded lot has no state');
    let engineState: LotState = initial;

    for (const [index, raw] of options.bids.entries()) {
      const userId = seeded.bidderIds[raw.bidder % seeded.bidderIds.length];
      if (userId === undefined) throw new Error('The seeded lot has no bidders');
      const now = options.startAt + raw.offsetSeconds * 1_000;
      const command: PlaceBidCommand = {
        kind: 'place_bid',
        lotId: seeded.lotId,
        userId,
        maxKobo: naira(raw.thousands * 1_000),
        idempotencyKey: `diff_${String(index)}`,
        bidLimitKobo: naira(1_000_000_000),
        limitReason: 'deposit_required',
      };

      const expected = apply(engineState, command, now);
      const actual = await placeBid(harness.ctx, { ...command }, now);

      if (expected.rejection !== undefined) {
        expect(actual.kind, `command ${String(index)} should have been rejected`).toBe('rejected');
        if (actual.kind === 'rejected') {
          expect(actual.rejection).toEqual(expected.rejection);
        }
      } else {
        expect(actual.kind, `command ${String(index)} should have been accepted`).toBe('accepted');
        if (actual.kind === 'accepted') {
          expect(describeState(snapshotToState(actual.snapshot, engineState))).toEqual(
            describeState(expected.state),
          );
        }
      }

      engineState = expected.state;
    }

    if (options.closeAtEnd) {
      const closeAt = Math.max(engineState.endsAt, options.startAt) + 1;
      const expected = apply(engineState, { kind: 'close_lot', lotId: seeded.lotId }, closeAt);
      const actual = await closeLot(harness.ctx, seeded.lotId, closeAt);
      expect(actual.kind).toBe('closed');
      if (actual.kind === 'closed') {
        expect(actual.snapshot.lotOutcome).toBe(expected.state.outcome);
        expect(actual.snapshot.priceKobo).toBe(expected.state.priceKobo);
      }
      engineState = expected.state;
    }

    // And the state left behind in Redis, read back through the normal read
    // path, must still match — not just the reply the script returned.
    const live = await readLiveState(harness.redis, seeded.lotId);
    expect(live).not.toBeNull();
    if (live !== null) {
      expect(describeState(live)).toEqual(describeState(engineState));
    }
  } finally {
    await clearLotKeys(harness.redis, seeded.lotId);
    await cleanupLot(harness.db, seeded);
  }
}

describe('the Lua script and the pure engine agree', () => {
  it('on proxy bidding, ties, increments and rejections', async () => {
    await fc.assert(
      fc.asyncProperty(rawBids(8), async (bids) => {
        await runBoth({
          bids,
          rules: noSoftCloseRules,
          endsAt: Date.now() + 3_600_000,
          startAt: Date.now(),
          closeAtEnd: false,
        });
      }),
      { numRuns: 25, endOnFailure: true },
    );
  });

  it('on exact ties, where the earlier maximum has to keep the lead', async () => {
    // Drawn from a handful of amounts on purpose. The wide-open generator above
    // picks from 256 values, so two bidders almost never choose the same
    // maximum to the kobo — and a tie is exactly where a `>` that should not be
    // a `>=` hides. Mutating the Lua comparison proved the point: the broad
    // test passed, this one fails.
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            bidder: fc.integer({ min: 0, max: 3 }),
            thousands: fc.constantFrom(50, 55, 60, 61, 75, 80),
            offsetSeconds: fc.constant(0),
          }),
          { minLength: 2, maxLength: 8 },
        ),
        async (bids) => {
          await runBoth({
            bids,
            rules: noSoftCloseRules,
            endsAt: Date.now() + 3_600_000,
            startAt: Date.now(),
            closeAtEnd: false,
          });
        },
      ),
      { numRuns: 30, endOnFailure: true },
    );
  });

  it('on the soft close, with bids landing inside the extension window', async () => {
    const endsAt = Date.now() + 600_000;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            bidder: fc.integer({ min: 0, max: 3 }),
            thousands: fc.integer({ min: 45, max: 300 }),
            // Bids land from 130 seconds before the end to just after it: on
            // both sides of the 120-second window, and past it.
            offsetSeconds: fc.integer({ min: 0, max: 130 }),
          }),
          { minLength: 2, maxLength: 6 },
        ),
        async (bids) => {
          const ordered = [...bids].sort((a, b) => a.offsetSeconds - b.offsetSeconds);
          await runBoth({
            bids: ordered,
            rules: testRules,
            endsAt,
            startAt: endsAt - 130_000,
            closeAtEnd: false,
          });
        },
      ),
      { numRuns: 20, endOnFailure: true },
    );
  });

  it('on closing, including the outcome and the hammer price', async () => {
    await fc.assert(
      fc.asyncProperty(rawBids(5), async (bids) => {
        const endsAt = Date.now() + 3_600_000;
        await runBoth({
          bids,
          rules: noSoftCloseRules,
          endsAt,
          startAt: Date.now(),
          closeAtEnd: true,
        });
      }),
      { numRuns: 12, endOnFailure: true },
    );
  });
});
