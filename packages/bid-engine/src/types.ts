/**
 * The vocabulary of the bid engine.
 *
 * This package is PURE: no Redis, no database, no `Date.now()`. It is a function
 * from (state, command, now) to (state, events, rejection). That is what makes it
 * testable against a reference model with fast-check, and what lets us replay an
 * append-only log to rebuild any lot's state after a retraction or a Redis loss.
 *
 * See docs/MILESTONE-1-DESIGN.md §7.
 */

import type { EpochMillis, Kobo } from '@ojalive/shared';

/** One band of the increment table: bids below `upToKobo` step by `stepKobo`. */
export interface IncrementBand {
  /** Exclusive upper bound of the band, or null for "everything above". */
  readonly upToKobo: Kobo | null;
  readonly stepKobo: Kobo;
}

/** Anti-sniping configuration, per category and frozen onto the lot. */
export interface SoftCloseRules {
  /** A bid inside this many milliseconds of the end extends the lot. */
  readonly windowMillis: number;
  /** How far past the bid the end time is pushed. */
  readonly extensionMillis: number;
  /** Hard cap on total extension, measured from the original end time. */
  readonly maxTotalExtensionMillis: number;
}

export interface LotRules {
  readonly incrementBands: readonly IncrementBand[];
  readonly softClose: SoftCloseRules;
}

export type LotStatus = 'scheduled' | 'open' | 'paused' | 'closing' | 'closed';

/**
 * Everything the engine needs to decide a bid. Note `leaderMaxKobo` — the
 * leader's secret maximum. It lives in state and in the log, and is never
 * broadcast to anyone.
 */
export interface LotState {
  readonly lotId: string;
  readonly status: LotStatus;
  readonly seq: number;
  readonly priceKobo: Kobo;
  readonly startingPriceKobo: Kobo;
  readonly reservePriceKobo: Kobo | null;
  readonly leaderUserId: string | null;
  readonly leaderMaxKobo: Kobo | null;
  /** The seq at which the current leader's maximum was set. Breaks exact ties. */
  readonly leaderMaxSetSeq: number | null;
  readonly bidCount: number;
  readonly endsAt: EpochMillis;
  readonly originalEndsAt: EpochMillis;
  readonly extensionCount: number;
  readonly rules: LotRules;
}

export interface PlaceBidCommand {
  readonly kind: 'place_bid';
  readonly lotId: string;
  readonly userId: string;
  /** The bidder's secret maximum. A quick-bid button sends the next increment. */
  readonly maxKobo: Kobo;
  readonly idempotencyKey: string;
  /** The highest total this bidder is cleared for, from deposit and verification. */
  readonly bidLimitKobo: Kobo;
}

export type BidCommand = PlaceBidCommand;

/**
 * Why a bid was refused. Enumerated, not free text, because the bidder sees it
 * and because rejection counts by reason are a metric we publish.
 */
export type RejectionReason =
  | 'auction_closed'
  | 'auction_not_open'
  | 'bidding_paused'
  | 'below_next_increment'
  | 'deposit_required'
  | 'already_leading'
  | 'rate_limited';

export interface Rejection {
  readonly reason: RejectionReason;
  /** The amount that WOULD have been acceptable, when that helps the bidder. */
  readonly nextAcceptableKobo?: Kobo;
}
