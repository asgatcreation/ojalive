/**
 * What watchers are allowed to see.
 *
 * A stream entry carries the bidder's secret maximum, because the persisting
 * worker needs it. A broadcast must not. This module is the single gate between
 * the two, so "a maximum never leaves the server" is enforced in one place
 * rather than remembered at every call site — and `broadcast.test.ts` asserts
 * it over the whole shape, not field by field.
 */

import type { EpochMillis, Kobo } from '@ojalive/shared';
import type { LotOutcome, LotState } from '@ojalive/bid-engine';
import type { StreamEvent } from './stream.js';

/** One delta, as it goes out to every watcher of a lot. */
export interface PublicLotEvent {
  readonly lotId: string;
  /** The ordering authority. A client remembers the last one it saw. */
  readonly seq: number;
  readonly at: EpochMillis;
  readonly kind: 'bid' | 'buy_now' | 'close';
  readonly priceKobo: string;
  /** Who leads. Display names are resolved by the web app, not broadcast here. */
  readonly leaderUserId: string | null;
  readonly bidCount: number;
  readonly endsAt: EpochMillis;
  readonly extensionCount: number;
  readonly reserveMet: boolean;
  readonly lotOutcome: LotOutcome | null;
}

/** The whole lot, for a client that has just arrived or fallen too far behind. */
export interface PublicLotSnapshot {
  readonly lotId: string;
  readonly status: LotState['status'];
  readonly seq: number;
  readonly priceKobo: string;
  readonly startingPriceKobo: string;
  readonly leaderUserId: string | null;
  readonly bidCount: number;
  readonly endsAt: EpochMillis;
  readonly originalEndsAt: EpochMillis;
  readonly extensionCount: number;
  /** Whether a reserve exists, and whether it is met — never the amount. */
  readonly hasReserve: boolean;
  readonly reserveMet: boolean;
  readonly buyNowKobo: string | null;
  readonly lotOutcome: LotOutcome | null;
  /** The server's clock when this was taken, so a client can check its offset. */
  readonly serverTime: EpochMillis;
}

/**
 * Amounts cross the wire as strings. JSON numbers are doubles, and a price in
 * kobo that happens to be exact today would be a rounding bug waiting for a
 * bigger lot.
 */
function amount(value: Kobo): string {
  return value.toString();
}

export function toPublicEvent(event: StreamEvent): PublicLotEvent {
  return {
    lotId: event.lotId,
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    priceKobo: amount(event.priceKobo),
    leaderUserId: event.leaderUserId,
    bidCount: event.bidCount,
    endsAt: event.endsAt,
    extensionCount: event.extensionCount,
    reserveMet: event.reserveMet,
    lotOutcome: event.lotOutcome,
  };
}

export function toPublicSnapshot(state: LotState, serverTime: EpochMillis): PublicLotSnapshot {
  return {
    lotId: state.lotId,
    status: state.status,
    seq: state.seq,
    priceKobo: amount(state.priceKobo),
    startingPriceKobo: amount(state.startingPriceKobo),
    leaderUserId: state.leaderUserId,
    bidCount: state.bidCount,
    endsAt: state.endsAt,
    originalEndsAt: state.originalEndsAt,
    extensionCount: state.extensionCount,
    hasReserve: state.reservePriceKobo !== null,
    reserveMet: state.reservePriceKobo === null || state.priceKobo >= state.reservePriceKobo,
    buyNowKobo: state.buyNowPriceKobo === null ? null : amount(state.buyNowPriceKobo),
    lotOutcome: state.outcome,
    serverTime,
  };
}
