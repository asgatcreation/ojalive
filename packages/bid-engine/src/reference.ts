/**
 * A reference model of the auction, written for clarity rather than for speed
 * or for reuse by the application.
 *
 * The engine is a state machine: it keeps a price and a leader and nudges them
 * one command at a time. This model is the opposite — it keeps nothing but the
 * list of accepted maximums and works the answer out from scratch every time,
 * from the economic rule of a proxy auction:
 *
 *   **the highest maximum wins, and pays one increment above the second
 *   highest, but never more than its own maximum.**
 *
 * Two independent formulations that must always agree. `properties.test.ts`
 * runs thousands of random command sequences through both. When they disagree,
 * one of them is wrong and the test tells us which case to look at.
 *
 * Deliberately out of scope here: time, the soft close, Buy Now and closing.
 * The model is about proxy bidding and increments only, so the property tests
 * that use it run on a lot whose end time is far away. The soft close is tested
 * directly against a fake clock in `soft-close.test.ts`.
 */

import type { Kobo } from '@ojalive/shared';
import { incrementFor } from './increments.js';
import type { IncrementBand, PlaceBidCommand } from './types.js';

interface AcceptedBid {
  readonly userId: string;
  readonly maxKobo: Kobo;
  /** Arrival order. Lower wins an exact tie. */
  readonly order: number;
}

export interface ReferenceLot {
  readonly startingPriceKobo: Kobo;
  readonly bands: readonly IncrementBand[];
}

export interface ReferenceOutcome {
  readonly priceKobo: Kobo;
  readonly leaderUserId: string | null;
  readonly bidCount: number;
  /** Indexes of the commands this model refused, in input order. */
  readonly rejectedIndexes: readonly number[];
}

/** Highest maximum first; at an equal maximum the earlier bid comes first. */
function ranked(accepted: readonly AcceptedBid[]): readonly AcceptedBid[] {
  return [...accepted].sort((a, b) => {
    if (a.maxKobo !== b.maxKobo) return a.maxKobo > b.maxKobo ? -1 : 1;
    return a.order - b.order;
  });
}

function leaderOf(accepted: readonly AcceptedBid[]): string | null {
  return ranked(accepted)[0]?.userId ?? null;
}

/**
 * The price implied by a set of accepted maximums — computed from the set, with
 * no reference to how it was built up.
 */
function priceOf(lot: ReferenceLot, accepted: readonly AcceptedBid[]): Kobo {
  const order = ranked(accepted);
  const highest = order[0];
  const second = order[1];
  if (highest === undefined) return lot.startingPriceKobo;
  if (second === undefined) return lot.startingPriceKobo;
  const oneUp = second.maxKobo + incrementFor(second.maxKobo, lot.bands);
  return oneUp < highest.maxKobo ? oneUp : highest.maxKobo;
}

/**
 * Run a sequence of bids through the model. Mirrors the engine's rejection
 * rules — closed lots aside — because which bids are accepted is part of what
 * has to agree.
 */
export function referenceRun(
  lot: ReferenceLot,
  commands: readonly PlaceBidCommand[],
): ReferenceOutcome {
  const accepted: AcceptedBid[] = [];
  const rejectedIndexes: number[] = [];

  for (const [index, command] of commands.entries()) {
    const priceKobo = priceOf(lot, accepted);

    if (leaderOf(accepted) === command.userId) {
      rejectedIndexes.push(index);
      continue;
    }

    const minimum =
      accepted.length === 0
        ? lot.startingPriceKobo
        : priceKobo + incrementFor(priceKobo, lot.bands);
    if (command.maxKobo < minimum) {
      rejectedIndexes.push(index);
      continue;
    }

    if (command.maxKobo > command.bidLimitKobo) {
      rejectedIndexes.push(index);
      continue;
    }

    accepted.push({ userId: command.userId, maxKobo: command.maxKobo, order: accepted.length });
  }

  return {
    priceKobo: priceOf(lot, accepted),
    leaderUserId: leaderOf(accepted),
    bidCount: accepted.length,
    rejectedIndexes,
  };
}
