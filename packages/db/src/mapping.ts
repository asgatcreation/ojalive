/**
 * Translating between database rows and the engine's `LotState`.
 *
 * The engine knows nothing about Postgres and nothing about time zones: it
 * takes milliseconds since the epoch and integer kobo. Everything that converts
 * between the two worlds lives here, so there is one place to check when a
 * number looks wrong.
 */

import type { EpochMillis } from '@ojalive/shared';
import type { LotState, LotStatus } from '@ojalive/bid-engine';
import { fromStoredRules } from './rules.js';
import type { LotRow, LotStateRow } from './schema.js';

/**
 * The lot lifecycle in the database is wider than the engine's: it also covers
 * the stages before a lot is ever scheduled. The engine only needs to know
 * whether a bid may be accepted, so everything pre-scheduling collapses to
 * `scheduled`, and a cancelled lot behaves like a closed one.
 */
export function toEngineStatus(status: LotRow['status']): LotStatus {
  switch (status) {
    case 'draft':
    case 'submitted':
    case 'approved':
    case 'scheduled':
      return 'scheduled';
    case 'open':
      return 'open';
    case 'paused':
      return 'paused';
    case 'closing':
      return 'closing';
    case 'closed':
    case 'cancelled':
      return 'closed';
  }
}

export function millis(at: Date): EpochMillis {
  return at.getTime();
}

export function atTime(at: EpochMillis): Date {
  return new Date(at);
}

/**
 * Build the engine's view of a lot from the lot row and its projection.
 *
 * `endsAt` comes from the projection when one exists, because that is what the
 * soft close has been moving; `lots.ends_at` is kept in step by the same write.
 */
export function toEngineState(lot: LotRow, state: LotStateRow | null): LotState {
  return {
    lotId: lot.id,
    status: toEngineStatus(lot.status),
    seq: state?.seq ?? 0,
    priceKobo: state?.priceKobo ?? lot.startingPriceKobo,
    startingPriceKobo: lot.startingPriceKobo,
    reservePriceKobo: lot.reservePriceKobo,
    buyNowPriceKobo: lot.buyNowPriceKobo,
    leaderUserId: state?.leaderUserId ?? null,
    leaderMaxKobo: state?.leaderMaxKobo ?? null,
    leaderMaxSetSeq: state?.leaderMaxSetSeq ?? null,
    bidCount: state?.bidCount ?? 0,
    endsAt: millis(state?.endsAt ?? lot.endsAt),
    originalEndsAt: millis(lot.originalEndsAt),
    extensionCount: lot.extensionCount,
    outcome: null,
    rules: fromStoredRules(lot.rulesSnapshot),
  };
}

/**
 * The state a lot starts from when its log is replayed (design doc §8.2).
 *
 * Note `endsAt: originalEndsAt`. Extensions are not restored from anywhere —
 * they are *recomputed* by replaying the bids through the soft-close rule. If
 * they were restored, a rebuild could not be used to check them.
 */
export function initialStateForReplay(lot: LotRow): LotState {
  return {
    lotId: lot.id,
    // Replay has to start from a lot that accepts bids, whatever the lot's
    // status is now; the log's own close event is what closes it again.
    status: 'open',
    seq: 0,
    priceKobo: lot.startingPriceKobo,
    startingPriceKobo: lot.startingPriceKobo,
    reservePriceKobo: lot.reservePriceKobo,
    buyNowPriceKobo: lot.buyNowPriceKobo,
    leaderUserId: null,
    leaderMaxKobo: null,
    leaderMaxSetSeq: null,
    bidCount: 0,
    endsAt: millis(lot.originalEndsAt),
    originalEndsAt: millis(lot.originalEndsAt),
    extensionCount: 0,
    outcome: null,
    rules: fromStoredRules(lot.rulesSnapshot),
  };
}
