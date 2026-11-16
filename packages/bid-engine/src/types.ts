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

/** How a lot ended. Decided by the engine, not by whoever ran the close job. */
export type LotOutcome = 'sold' | 'unsold_no_bids' | 'unsold_reserve_not_met';

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
  /** Buy Now, while it is still available. The first accepted bid removes it. */
  readonly buyNowPriceKobo: Kobo | null;
  readonly leaderUserId: string | null;
  readonly leaderMaxKobo: Kobo | null;
  /** The seq at which the current leader's maximum was set. Breaks exact ties. */
  readonly leaderMaxSetSeq: number | null;
  readonly bidCount: number;
  readonly endsAt: EpochMillis;
  readonly originalEndsAt: EpochMillis;
  readonly extensionCount: number;
  readonly outcome: LotOutcome | null;
  readonly rules: LotRules;
}

/** Why a bidder is capped: it changes the message they are shown. */
export type BidLimitReason = 'deposit_required' | 'verification_required';

export interface PlaceBidCommand {
  readonly kind: 'place_bid';
  readonly lotId: string;
  readonly userId: string;
  /** The bidder's secret maximum. A quick-bid button sends the next increment. */
  readonly maxKobo: Kobo;
  readonly idempotencyKey: string;
  /** The highest total this bidder is cleared for, from deposit and verification. */
  readonly bidLimitKobo: Kobo;
  /** Which message to show if `maxKobo` exceeds `bidLimitKobo`. */
  readonly limitReason: BidLimitReason;
}

export interface BuyNowCommand {
  readonly kind: 'buy_now';
  readonly lotId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly bidLimitKobo: Kobo;
  readonly limitReason: BidLimitReason;
}

export interface CloseLotCommand {
  readonly kind: 'close_lot';
  readonly lotId: string;
}

export type BidCommand = PlaceBidCommand | BuyNowCommand | CloseLotCommand;

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
  | 'verification_required'
  | 'already_leading'
  | 'buy_now_unavailable'
  | 'not_yet_due'
  | 'rate_limited';

export interface Rejection {
  readonly reason: RejectionReason;
  /** The amount that WOULD have been acceptable, when that helps the bidder. */
  readonly nextAcceptableKobo?: Kobo;
}

/** Why a bidder is no longer the one to beat. */
export type OutbidCause =
  /** They were leading and a higher maximum took the lead. */
  | 'displaced'
  /** Their maximum was not higher than the leader's, so it only raised the price. */
  | 'lower_maximum';

interface EventBase {
  readonly lotId: string;
  /**
   * The lot's sequence number after the command that produced this event.
   *
   * Every event from one accepted command shares that command's `seq`: `seq` is
   * the authority for ordering and for a reconnecting client's resync, so one
   * command must advance it exactly once.
   */
  readonly seq: number;
  readonly at: EpochMillis;
}

/**
 * The append-only record of an accepted bid.
 *
 * This is the ONLY event that carries a secret maximum. It is persisted to
 * `bid_events` and replayed through this engine; it is never broadcast, never
 * returned by the API and never logged (pino redacts `maxKobo`).
 */
export interface BidPlacedEvent extends EventBase {
  readonly kind: 'bid_placed';
  readonly userId: string;
  readonly maxKobo: Kobo;
  readonly idempotencyKey: string;
}

export interface PriceChangedEvent extends EventBase {
  readonly kind: 'price_changed';
  readonly priceKobo: Kobo;
  readonly previousPriceKobo: Kobo;
}

export interface LeaderChangedEvent extends EventBase {
  readonly kind: 'leader_changed';
  readonly leaderUserId: string;
  readonly previousLeaderUserId: string | null;
}

export interface OutbidEvent extends EventBase {
  readonly kind: 'outbid';
  readonly userId: string;
  readonly cause: OutbidCause;
}

export interface ReserveMetEvent extends EventBase {
  readonly kind: 'reserve_met';
  readonly priceKobo: Kobo;
}

export interface EndTimeExtendedEvent extends EventBase {
  readonly kind: 'end_time_extended';
  readonly endsAt: EpochMillis;
  readonly previousEndsAt: EpochMillis;
  readonly extensionCount: number;
}

export interface BuyNowWithdrawnEvent extends EventBase {
  readonly kind: 'buy_now_withdrawn';
}

export interface BuyNowPurchasedEvent extends EventBase {
  readonly kind: 'buy_now_purchased';
  readonly userId: string;
  readonly priceKobo: Kobo;
}

export interface LotClosedEvent extends EventBase {
  readonly kind: 'lot_closed';
  readonly outcome: LotOutcome;
  readonly priceKobo: Kobo;
  /** Non-null only when the outcome is `sold`. */
  readonly winnerUserId: string | null;
  /** The high bidder even when the reserve was not met — the seller may accept. */
  readonly highBidderUserId: string | null;
}

export type BidEvent =
  | BidPlacedEvent
  | PriceChangedEvent
  | LeaderChangedEvent
  | OutbidEvent
  | ReserveMetEvent
  | EndTimeExtendedEvent
  | BuyNowWithdrawnEvent
  | BuyNowPurchasedEvent
  | LotClosedEvent;

/**
 * What the engine returns. `rejection` is absent on success — not undefined —
 * because `exactOptionalPropertyTypes` is on and an absent key is cheaper to
 * reason about than a present one holding nothing.
 */
export interface EngineResult {
  readonly state: LotState;
  readonly events: readonly BidEvent[];
  readonly rejection?: Rejection;
}
