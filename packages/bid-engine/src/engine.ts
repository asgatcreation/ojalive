/**
 * The engine. A pure function from (state, command, now) to (state, events,
 * rejection), implementing docs/MILESTONE-1-DESIGN.md §7.2 exactly.
 *
 * Nothing here reads a clock, touches Redis or awaits anything. `now` is always
 * passed in. That is deliberate:
 *
 * - the Lua script in milestone 4 is a faithful port of this file, and a
 *   differential test runs random command sequences through both;
 * - a lot's state is a projection, so a retraction is "replay the log without
 *   that event" (`replay` below) rather than a hand-written correction;
 * - the soft close can be tested at the millisecond with a fake clock.
 *
 * Two product rules worth stating out loud, because both are choices:
 *
 * 1. **At an exact tie the earlier maximum keeps the lead.** Arrival order
 *    decides, and `leaderMaxSetSeq` records it. So the order-independence
 *    property (§7.4) is stated over *distinct* maxima, which is how a real sale
 *    behaves — two bidders choosing the same secret maximum to the kobo is
 *    vanishingly rare, and someone has to win.
 * 2. **The leader cannot bid again on their own lot.** They are told "you
 *    already lead this lot". Raising your own maximum is not supported in this
 *    version: it cannot change the price (no one has challenged), so it would
 *    only buy a hidden advantage in a later tie.
 */

import type { EpochMillis, Kobo } from '@ojalive/shared';
import { incrementFor, minimumAcceptableKobo } from './increments.js';
import type {
  BidCommand,
  BidEvent,
  BuyNowCommand,
  CloseLotCommand,
  EngineResult,
  LotOutcome,
  LotState,
  PlaceBidCommand,
  Rejection,
  RejectionReason,
} from './types.js';

/** A bug on our side — a command for the wrong lot, or an impossible state. */
export class EngineError extends Error {}

function accept(state: LotState, events: readonly BidEvent[]): EngineResult {
  return { state, events };
}

function reject(state: LotState, reason: RejectionReason, nextAcceptableKobo?: Kobo): EngineResult {
  const rejection: Rejection =
    nextAcceptableKobo === undefined ? { reason } : { reason, nextAcceptableKobo };
  return { state, events: [], rejection };
}

/** True when the lot has no reserve, or the price has reached it. */
export function isReserveMet(state: LotState): boolean {
  return state.reservePriceKobo === null || state.priceKobo >= state.reservePriceKobo;
}

/** The smallest maximum this lot would accept right now. */
export function nextAcceptableKobo(state: LotState): Kobo {
  return minimumAcceptableKobo({
    bidCount: state.bidCount,
    priceKobo: state.priceKobo,
    startingPriceKobo: state.startingPriceKobo,
    bands: state.rules.incrementBands,
  });
}

/**
 * Can this lot take a bid at `now`? The status check and the time check are the
 * same check as far as a bidder is concerned, but they are different messages.
 */
function liveness(state: LotState, now: EpochMillis): RejectionReason | null {
  switch (state.status) {
    case 'closed':
    case 'closing':
      return 'auction_closed';
    case 'paused':
      return 'bidding_paused';
    case 'scheduled':
      return 'auction_not_open';
    case 'open':
      return now >= state.endsAt ? 'auction_closed' : null;
  }
}

/**
 * The anti-sniping soft close (§7.5). A bid inside the window pushes the end
 * time out, capped at `originalEndsAt + maxTotalExtensionMillis`.
 *
 * The end time never moves backwards: once the cap is reached, late bids are
 * still accepted while the lot is open, they simply stop extending it.
 */
function softClose(
  state: LotState,
  now: EpochMillis,
): { readonly endsAt: EpochMillis; readonly extended: boolean } {
  const { windowMillis, extensionMillis, maxTotalExtensionMillis } = state.rules.softClose;
  if (now <= state.endsAt - windowMillis) {
    return { endsAt: state.endsAt, extended: false };
  }
  const cap = state.originalEndsAt + maxTotalExtensionMillis;
  const proposed = Math.min(now + extensionMillis, cap);
  if (proposed <= state.endsAt) {
    return { endsAt: state.endsAt, extended: false };
  }
  return { endsAt: proposed, extended: true };
}

function placeBid(state: LotState, command: PlaceBidCommand, now: EpochMillis): EngineResult {
  const notLive = liveness(state, now);
  if (notLive !== null) return reject(state, notLive);

  if (state.leaderUserId === command.userId) {
    return reject(state, 'already_leading');
  }

  const minimum = nextAcceptableKobo(state);
  if (command.maxKobo < minimum) {
    return reject(state, 'below_next_increment', minimum);
  }

  if (command.maxKobo > command.bidLimitKobo) {
    return reject(state, command.limitReason, command.bidLimitKobo);
  }

  const seq = state.seq + 1;
  const bands = state.rules.incrementBands;
  const previousLeaderUserId = state.leaderUserId;
  const previousPriceKobo = state.priceKobo;

  let priceKobo: Kobo;
  let leaderUserId: string;
  let leaderMaxKobo: Kobo;
  let leaderMaxSetSeq: number;
  let displacedLeader = false;

  if (state.leaderUserId === null || state.leaderMaxKobo === null) {
    // First bid on the lot. The price opens AT the starting price, not at the
    // bidder's maximum — their maximum only spends what it has to.
    priceKobo = state.startingPriceKobo;
    leaderUserId = command.userId;
    leaderMaxKobo = command.maxKobo;
    leaderMaxSetSeq = seq;
  } else if (command.maxKobo > state.leaderMaxKobo) {
    // The challenger has the higher maximum and takes the lead, paying one
    // increment above the maximum they beat.
    priceKobo = min(
      command.maxKobo,
      state.leaderMaxKobo + incrementFor(state.leaderMaxKobo, bands),
    );
    leaderUserId = command.userId;
    leaderMaxKobo = command.maxKobo;
    leaderMaxSetSeq = seq;
    displacedLeader = true;
  } else {
    // The challenger loses — including on an exact tie, where the earlier
    // maximum keeps the lead. Their bid still pushes the price up against the
    // leader's standing maximum.
    priceKobo = min(state.leaderMaxKobo, command.maxKobo + incrementFor(command.maxKobo, bands));
    leaderUserId = state.leaderUserId;
    leaderMaxKobo = state.leaderMaxKobo;
    leaderMaxSetSeq = state.leaderMaxSetSeq ?? seq;
  }

  const { endsAt, extended } = softClose(state, now);
  const reserveWasMet = isReserveMet(state);

  const next: LotState = {
    ...state,
    seq,
    priceKobo,
    leaderUserId,
    leaderMaxKobo,
    leaderMaxSetSeq,
    bidCount: state.bidCount + 1,
    buyNowPriceKobo: null,
    endsAt,
    extensionCount: extended ? state.extensionCount + 1 : state.extensionCount,
  };

  const events: BidEvent[] = [
    {
      kind: 'bid_placed',
      lotId: state.lotId,
      seq,
      at: now,
      userId: command.userId,
      maxKobo: command.maxKobo,
      idempotencyKey: command.idempotencyKey,
    },
  ];

  if (state.buyNowPriceKobo !== null) {
    // Buy Now and a first bid can never both succeed: one command at a time.
    events.push({ kind: 'buy_now_withdrawn', lotId: state.lotId, seq, at: now });
  }
  if (priceKobo !== previousPriceKobo) {
    events.push({
      kind: 'price_changed',
      lotId: state.lotId,
      seq,
      at: now,
      priceKobo,
      previousPriceKobo,
    });
  }
  if (leaderUserId !== previousLeaderUserId) {
    events.push({
      kind: 'leader_changed',
      lotId: state.lotId,
      seq,
      at: now,
      leaderUserId,
      previousLeaderUserId,
    });
  }
  if (displacedLeader && previousLeaderUserId !== null) {
    events.push({
      kind: 'outbid',
      lotId: state.lotId,
      seq,
      at: now,
      userId: previousLeaderUserId,
      cause: 'displaced',
    });
  }
  if (!displacedLeader && previousLeaderUserId !== null) {
    events.push({
      kind: 'outbid',
      lotId: state.lotId,
      seq,
      at: now,
      userId: command.userId,
      cause: 'lower_maximum',
    });
  }
  if (!reserveWasMet && isReserveMet(next)) {
    events.push({ kind: 'reserve_met', lotId: state.lotId, seq, at: now, priceKobo });
  }
  if (extended) {
    events.push({
      kind: 'end_time_extended',
      lotId: state.lotId,
      seq,
      at: now,
      endsAt,
      previousEndsAt: state.endsAt,
      extensionCount: next.extensionCount,
    });
  }

  return accept(next, events);
}

function buyNow(state: LotState, command: BuyNowCommand, now: EpochMillis): EngineResult {
  const notLive = liveness(state, now);
  if (notLive !== null) return reject(state, notLive);

  const priceKobo = state.buyNowPriceKobo;
  if (priceKobo === null || state.bidCount > 0) {
    return reject(state, 'buy_now_unavailable');
  }
  if (priceKobo > command.bidLimitKobo) {
    return reject(state, command.limitReason, command.bidLimitKobo);
  }

  const seq = state.seq + 1;
  const next: LotState = {
    ...state,
    seq,
    status: 'closed',
    priceKobo,
    buyNowPriceKobo: null,
    leaderUserId: command.userId,
    leaderMaxKobo: priceKobo,
    leaderMaxSetSeq: seq,
    outcome: 'sold',
  };

  const events: BidEvent[] = [
    {
      kind: 'buy_now_purchased',
      lotId: state.lotId,
      seq,
      at: now,
      userId: command.userId,
      priceKobo,
    },
    { kind: 'buy_now_withdrawn', lotId: state.lotId, seq, at: now },
  ];
  if (priceKobo !== state.priceKobo) {
    events.push({
      kind: 'price_changed',
      lotId: state.lotId,
      seq,
      at: now,
      priceKobo,
      previousPriceKobo: state.priceKobo,
    });
  }
  events.push({
    kind: 'leader_changed',
    lotId: state.lotId,
    seq,
    at: now,
    leaderUserId: command.userId,
    previousLeaderUserId: state.leaderUserId,
  });
  events.push({
    kind: 'lot_closed',
    lotId: state.lotId,
    seq,
    at: now,
    outcome: 'sold',
    priceKobo,
    winnerUserId: command.userId,
    highBidderUserId: command.userId,
  });

  return accept(next, events);
}

/**
 * Close the lot. Closing exactly once is enforced by four layers in milestone 4
 * (a delayed job, the job re-reading the database end time, a compare-and-set in
 * Lua, and a unique constraint). This is the first of them: a lot that is
 * already closed rejects, and a lot that is not yet due rejects.
 */
function closeLot(state: LotState, _command: CloseLotCommand, now: EpochMillis): EngineResult {
  if (state.status === 'closed') return reject(state, 'auction_closed');
  if (state.status === 'scheduled') return reject(state, 'auction_not_open');
  if (now < state.endsAt) return reject(state, 'not_yet_due');

  const outcome: LotOutcome =
    state.leaderUserId === null
      ? 'unsold_no_bids'
      : isReserveMet(state)
        ? 'sold'
        : 'unsold_reserve_not_met';

  const seq = state.seq + 1;
  const next: LotState = { ...state, seq, status: 'closed', buyNowPriceKobo: null, outcome };

  return accept(next, [
    {
      kind: 'lot_closed',
      lotId: state.lotId,
      seq,
      at: now,
      outcome,
      priceKobo: state.priceKobo,
      winnerUserId: outcome === 'sold' ? state.leaderUserId : null,
      highBidderUserId: state.leaderUserId,
    },
  ]);
}

/**
 * Apply one command. The whole engine is this function.
 *
 * Idempotency is deliberately NOT here: the engine has no memory of previous
 * idempotency keys, because that is per-lot bookkeeping the Lua script and a
 * `UNIQUE (lot_id, user_id, idempotency_key)` constraint own (§7.8). What this
 * function guarantees instead is determinism — the same state, command and
 * `now` always produce the same result — which is what makes a replayed retry
 * safe.
 */
export function apply(state: LotState, command: BidCommand, now: EpochMillis): EngineResult {
  if (command.lotId !== state.lotId) {
    throw new EngineError(`Command for lot ${command.lotId} applied to lot ${state.lotId}`);
  }
  switch (command.kind) {
    case 'place_bid':
      return placeBid(state, command, now);
    case 'buy_now':
      return buyNow(state, command, now);
    case 'close_lot':
      return closeLot(state, command, now);
  }
}

/** A command and the server time it was accepted at — one entry of the log. */
export interface TimedCommand {
  readonly command: BidCommand;
  readonly at: EpochMillis;
}

export interface ReplayResult {
  readonly state: LotState;
  readonly events: readonly BidEvent[];
  /** Commands the engine refused, by their index in the input. */
  readonly rejections: ReadonlyArray<{ readonly index: number; readonly rejection: Rejection }>;
}

/**
 * Replay a log onto a starting state.
 *
 * This is how a retraction works (§7.7): append the retraction, then replay the
 * lot's log with the retracted command left out. It is also how we rebuild
 * `lot_state` after losing Redis (§8.2) — the same code path either way, which
 * is why it is exercised constantly rather than only in an emergency.
 */
export function replay(initial: LotState, log: readonly TimedCommand[]): ReplayResult {
  let state = initial;
  const events: BidEvent[] = [];
  const rejections: Array<{ index: number; rejection: Rejection }> = [];

  for (const [index, entry] of log.entries()) {
    const result = apply(state, entry.command, entry.at);
    state = result.state;
    if (result.rejection === undefined) {
      events.push(...result.events);
    } else {
      rejections.push({ index, rejection: result.rejection });
    }
  }

  return { state, events, rejections };
}

function min(a: Kobo, b: Kobo): Kobo {
  return a < b ? a : b;
}
