/**
 * The correctness claims, as properties over thousands of random runs.
 *
 * The headline one is order independence (design §7.4): for any arrival order of
 * a set of distinct maximums, the same bidder wins at the same price. That is
 * what makes the engine safe under concurrency — the Lua script serialises
 * bids, and this says the order it happens to pick does not matter.
 *
 * One honest limit, worth stating because the README states it too. The claim
 * holds for maximums that are pairwise more than one increment apart and at
 * least two increments above the starting price. Outside that, whether the
 * lower maximum is acceptable at all depends on the price at the moment it
 * arrives — a maximum equal to the starting price, for instance, can only be
 * accepted as the very first bid — so arrival order can decide whether it is
 * ever recorded. Those cases are not a bug and they are not glossed over: the
 * generator below respects the condition, and `engine agrees with the reference
 * model` covers tight spacing and amounts below the starting price without
 * assuming order independence.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { naira, type Kobo } from '@ojalive/shared';
import { apply } from './engine.js';
import { referenceRun, type ReferenceLot } from './reference.js';
import { bidOf, earlyTime, flatBands, lotRules, phoneLot } from './test-support.js';
import type { LotState, PlaceBidCommand } from './types.js';

/** One flat ₦1,000 increment at every price, so "spaced apart" is unambiguous. */
const startingPriceKobo = naira(50_000);
const incrementKobo = naira(1_000);

function freshLot(): LotState {
  return phoneLot({
    priceKobo: startingPriceKobo,
    startingPriceKobo,
    reservePriceKobo: null,
    rules: lotRules({ incrementBands: flatBands }),
  });
}

const referenceLot: ReferenceLot = { startingPriceKobo, bands: flatBands };

function runEngine(commands: readonly PlaceBidCommand[]): {
  readonly state: LotState;
  readonly rejectedIndexes: number[];
} {
  let state = freshLot();
  const rejectedIndexes: number[] = [];
  for (const [index, command] of commands.entries()) {
    const result = apply(state, command, earlyTime);
    state = result.state;
    if (result.rejection !== undefined) rejectedIndexes.push(index);
  }
  return { state, rejectedIndexes };
}

/**
 * Distinct maximums, each at least ₦5,000 from the next and at least ₦5,000
 * above the starting price — one per bidder, so nobody bids against themselves.
 * That is the condition under which order independence holds; see the note at
 * the top of this file.
 */
const spacedBidsArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 90 }), { minLength: 1, maxLength: 8 })
  .map((steps) => steps.map((step, index) => bidOf(`u${String(index)}`, 50_000 + step * 5_000)));

describe('order independence (design §7.4)', () => {
  it('the same bidder wins at the same price whatever the arrival order', () => {
    fc.assert(
      fc.property(spacedBidsArb, (commands) => {
        const asGenerated = runEngine(commands).state;
        const descending = runEngine(
          [...commands].sort((a, b) =>
            a.maxKobo === b.maxKobo ? 0 : a.maxKobo > b.maxKobo ? -1 : 1,
          ),
        ).state;

        expect(asGenerated.leaderUserId).toBe(descending.leaderUserId);
        expect(asGenerated.priceKobo).toBe(descending.priceKobo);
      }),
      { numRuns: 2_000 },
    );
  });

  it('the winner is the highest maximum, paying one increment above the second', () => {
    fc.assert(
      fc.property(spacedBidsArb, (commands) => {
        const sorted = [...commands].sort((a, b) =>
          a.maxKobo === b.maxKobo ? 0 : a.maxKobo > b.maxKobo ? -1 : 1,
        );
        const highest = sorted[0];
        const second = sorted[1];
        if (highest === undefined) return;

        const { state } = runEngine(commands);
        expect(state.leaderUserId).toBe(highest.userId);

        const expected: Kobo =
          second === undefined
            ? startingPriceKobo
            : minOf(highest.maxKobo, second.maxKobo + incrementKobo);
        expect(state.priceKobo).toBe(expected);
      }),
      { numRuns: 2_000 },
    );
  });

  it('nobody ever learns a maximum: no broadcast event carries one', () => {
    fc.assert(
      fc.property(spacedBidsArb, (commands) => {
        let state = freshLot();
        for (const command of commands) {
          const result = apply(state, command, earlyTime);
          state = result.state;
          for (const event of result.events) {
            if (event.kind === 'bid_placed') continue;
            const serialised = JSON.stringify(event, (_key, value: unknown) =>
              typeof value === 'bigint' ? value.toString() : value,
            );
            for (const bid of commands) {
              // The price may legitimately equal a maximum (a tie, or a bidder
              // spending all of theirs), so only amounts above the price leak.
              if (bid.maxKobo > state.priceKobo) {
                expect(serialised).not.toContain(bid.maxKobo.toString());
              }
            }
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});

/** Any bids at all: repeated bidders, tight spacing, amounts below the start. */
const anyBidsArb = fc.array(
  fc.record({
    user: fc.integer({ min: 0, max: 4 }),
    thousands: fc.integer({ min: 40, max: 200 }),
    capped: fc.boolean(),
  }),
  { maxLength: 20 },
);

function toCommands(
  raw: ReadonlyArray<{ user: number; thousands: number; capped: boolean }>,
): PlaceBidCommand[] {
  return raw.map((entry, index) =>
    bidOf(`u${String(entry.user)}`, entry.thousands * 1_000, {
      idempotencyKey: `key_${String(index)}`,
      bidLimitKobo: entry.capped ? naira(120_000) : naira(1_000_000_000),
    }),
  );
}

describe('the engine agrees with the reference model', () => {
  it('reaches the same price, leader and bid count, and refuses the same bids', () => {
    fc.assert(
      fc.property(anyBidsArb, (raw) => {
        const commands = toCommands(raw);
        const engine = runEngine(commands);
        const model = referenceRun(referenceLot, commands);

        expect(engine.state.priceKobo).toBe(model.priceKobo);
        expect(engine.state.leaderUserId).toBe(model.leaderUserId);
        expect(engine.state.bidCount).toBe(model.bidCount);
        expect(engine.rejectedIndexes).toEqual([...model.rejectedIndexes]);
      }),
      { numRuns: 3_000 },
    );
  });
});

describe('invariants that must hold after every command', () => {
  it('holds for any sequence of bids', () => {
    fc.assert(
      fc.property(anyBidsArb, (raw) => {
        const commands = toCommands(raw);
        let state = freshLot();
        let accepted = 0;
        const acceptedMaxima: Kobo[] = [];

        for (const command of commands) {
          const previous = state;
          const result = apply(state, command, earlyTime);
          state = result.state;

          if (result.rejection !== undefined) {
            // A refused bid changes nothing at all — not the price, not the
            // sequence number, not the lot's state object.
            expect(state).toBe(previous);
            expect(result.events).toEqual([]);
            continue;
          }

          accepted += 1;
          acceptedMaxima.push(command.maxKobo);

          // One accepted command advances seq exactly once, and every event it
          // produced carries that seq.
          expect(state.seq).toBe(previous.seq + 1);
          expect(result.events.every((event) => event.seq === state.seq)).toBe(true);
          expect(result.events.filter((event) => event.kind === 'bid_placed')).toHaveLength(1);

          // The price only ever goes up, never above the leader's maximum, and
          // never below the starting price.
          expect(state.priceKobo).toBeGreaterThanOrEqual(previous.priceKobo);
          expect(state.priceKobo).toBeGreaterThanOrEqual(startingPriceKobo);
          expect(state.leaderMaxKobo).not.toBeNull();
          expect(state.priceKobo).toBeLessThanOrEqual(state.leaderMaxKobo ?? 0n);

          // The leader always holds the highest maximum the lot has accepted.
          const highest = acceptedMaxima.reduce((a, b) => (a > b ? a : b), 0n);
          expect(state.leaderMaxKobo).toBe(highest);
          expect(state.leaderUserId).not.toBeNull();
          expect(state.bidCount).toBe(accepted);
          expect(state.seq).toBe(accepted);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});

function minOf(a: Kobo, b: Kobo): Kobo {
  return a < b ? a : b;
}
