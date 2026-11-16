import { describe, expect, it } from 'vitest';
import { naira } from '@ojalive/shared';
import { apply, EngineError, isReserveMet, replay, type TimedCommand } from './engine.js';
import { bidOf, earlyTime, phoneLot } from './test-support.js';
import type { BidEvent, LotState } from './types.js';

/** Apply a bid at a time well outside the soft-close window. */
function bid(state: LotState, userId: string, maxNaira: number) {
  return apply(state, bidOf(userId, maxNaira), earlyTime);
}

function kinds(events: readonly BidEvent[]): string[] {
  return events.map((event) => event.kind);
}

describe('worked example A — proxy bidding, ties and increments (design §7.3)', () => {
  // Phone lot: start ₦50,000, hidden reserve ₦58,000, ₦1,000 increments.
  const ada = bid(phoneLot(), 'ada', 60_000);

  it('1. the first bid opens at the starting price, not at the bidder’s maximum', () => {
    expect(ada.rejection).toBeUndefined();
    expect(ada.state.priceKobo).toBe(naira(50_000));
    expect(ada.state.leaderUserId).toBe('ada');
    expect(isReserveMet(ada.state)).toBe(false);
  });

  const bola = bid(ada.state, 'bola', 55_000);

  it('2. a lower maximum loses but still pushes the price to one step above itself', () => {
    expect(bola.rejection).toBeUndefined();
    expect(bola.state.priceKobo).toBe(naira(56_000));
    expect(bola.state.leaderUserId).toBe('ada');
    expect(isReserveMet(bola.state)).toBe(false);
  });

  it('2. and that bidder is told they were outbid by a higher maximum, not by how much', () => {
    const outbid = bola.events.find((event) => event.kind === 'outbid');
    expect(outbid).toEqual(
      expect.objectContaining({ userId: 'bola', cause: 'lower_maximum', seq: 2 }),
    );
    // Nothing broadcastable may contain anybody's maximum. Ada's ₦60,000 is
    // 6000000 kobo; only the (never broadcast) bid_placed record may hold one.
    const broadcastable = bola.events.filter((event) => event.kind !== 'bid_placed');
    const serialised = JSON.stringify(broadcastable, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain('6000000');
  });

  const chidi = bid(bola.state, 'chidi', 60_000);

  it('3. an exact tie leaves the lead with the earlier maximum', () => {
    expect(chidi.rejection).toBeUndefined();
    expect(chidi.state.priceKobo).toBe(naira(60_000));
    expect(chidi.state.leaderUserId).toBe('ada');
    expect(chidi.state.leaderMaxSetSeq).toBe(1);
  });

  it('3. and the hidden reserve becomes met, which is announced', () => {
    expect(isReserveMet(chidi.state)).toBe(true);
    expect(kinds(chidi.events)).toContain('reserve_met');
  });

  const dapo = bid(chidi.state, 'dapo', 75_000);

  it('4. a higher maximum takes the lead one increment above the maximum it beat', () => {
    expect(dapo.rejection).toBeUndefined();
    expect(dapo.state.priceKobo).toBe(naira(61_000));
    expect(dapo.state.leaderUserId).toBe('dapo');
    expect(dapo.state.leaderMaxKobo).toBe(naira(75_000));
  });

  it('4. the displaced leader is told they lost the lead', () => {
    expect(dapo.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'outbid', userId: 'ada', cause: 'displaced' }),
      ]),
    );
  });

  it('every event from one command carries that command’s seq', () => {
    expect(dapo.state.seq).toBe(4);
    expect(dapo.events.every((event) => event.seq === 4)).toBe(true);
  });
});

describe('worked example B — two bids in the same millisecond (design §7.4)', () => {
  // Price ₦61,000, leader Dapo with a ₦75,000 maximum.
  const contested = phoneLot({
    seq: 4,
    bidCount: 4,
    priceKobo: naira(61_000),
    leaderUserId: 'dapo',
    leaderMaxKobo: naira(75_000),
    leaderMaxSetSeq: 4,
  });

  it('order 1 — Emeka then Funke — ends with Emeka leading at ₦79,000', () => {
    const emeka = bid(contested, 'emeka', 80_000);
    expect(emeka.state.priceKobo).toBe(naira(76_000));
    const funke = bid(emeka.state, 'funke', 78_000);
    expect(funke.state.priceKobo).toBe(naira(79_000));
    expect(funke.state.leaderUserId).toBe('emeka');
  });

  it('order 2 — Funke then Emeka — ends with Emeka leading at ₦79,000', () => {
    const funke = bid(contested, 'funke', 78_000);
    expect(funke.state.priceKobo).toBe(naira(76_000));
    expect(funke.state.leaderUserId).toBe('funke');
    const emeka = bid(funke.state, 'emeka', 80_000);
    expect(emeka.state.priceKobo).toBe(naira(79_000));
    expect(emeka.state.leaderUserId).toBe('emeka');
  });

  it('both orders reach the same seq, so one bid can never be lost or doubled', () => {
    const viaEmeka = bid(bid(contested, 'emeka', 80_000).state, 'funke', 78_000);
    const viaFunke = bid(bid(contested, 'funke', 78_000).state, 'emeka', 80_000);
    expect(viaEmeka.state.seq).toBe(6);
    expect(viaFunke.state.seq).toBe(6);
    expect(viaEmeka.state.bidCount).toBe(6);
    expect(viaFunke.state.bidCount).toBe(6);
  });
});

describe('worked example D — retraction by replay (design §7.7)', () => {
  const log: readonly TimedCommand[] = [
    { command: bidOf('ada', 60_000), at: earlyTime },
    { command: bidOf('bola', 55_000), at: earlyTime },
    { command: bidOf('chidi', 60_000), at: earlyTime },
    { command: bidOf('dapo', 75_000), at: earlyTime },
    { command: bidOf('emeka', 80_000), at: earlyTime },
    { command: bidOf('funke', 78_000), at: earlyTime },
  ];

  it('replaying the whole log reproduces the live state', () => {
    const result = replay(phoneLot(), log);
    expect(result.rejections).toEqual([]);
    expect(result.state.leaderUserId).toBe('emeka');
    expect(result.state.priceKobo).toBe(naira(79_000));
    expect(result.state.seq).toBe(6);
  });

  it('replaying without Emeka’s retracted bid leaves Funke leading at ₦76,000', () => {
    const withoutEmeka = log.filter((entry) => {
      const command = entry.command;
      return command.kind !== 'place_bid' || command.userId !== 'emeka';
    });
    const result = replay(phoneLot(), withoutEmeka);
    expect(result.state.leaderUserId).toBe('funke');
    expect(result.state.priceKobo).toBe(naira(76_000));
    // Five accepted bids, so five sequence numbers — the retracted one is gone,
    // it is not left behind as a hole or as a correction.
    expect(result.state.seq).toBe(5);
    expect(result.state.bidCount).toBe(5);
  });

  it('replay is deterministic — the same log twice gives the same state', () => {
    expect(replay(phoneLot(), log).state).toEqual(replay(phoneLot(), log).state);
  });
});

describe('rejections (design §7.10)', () => {
  it('refuses a bid below the next increment and says what would be accepted', () => {
    const opened = bid(phoneLot(), 'ada', 60_000);
    const low = bid(opened.state, 'bola', 50_500);
    expect(low.rejection).toEqual({
      reason: 'below_next_increment',
      nextAcceptableKobo: naira(51_000),
    });
    expect(low.events).toEqual([]);
    expect(low.state).toBe(opened.state);
  });

  it('opens AT the starting price — the first bid does not have to beat it', () => {
    expect(bid(phoneLot(), 'ada', 50_000).rejection).toBeUndefined();
    expect(bid(phoneLot(), 'ada', 49_999).rejection?.reason).toBe('below_next_increment');
  });

  it('refuses a bid above the bidder’s cleared limit, with the reason they can act on', () => {
    const deposit = apply(
      phoneLot(),
      bidOf('ada', 60_000, { bidLimitKobo: naira(55_000), limitReason: 'deposit_required' }),
      earlyTime,
    );
    expect(deposit.rejection).toEqual({
      reason: 'deposit_required',
      nextAcceptableKobo: naira(55_000),
    });

    const verification = apply(
      phoneLot(),
      bidOf('ada', 60_000, { bidLimitKobo: naira(55_000), limitReason: 'verification_required' }),
      earlyTime,
    );
    expect(verification.rejection?.reason).toBe('verification_required');
  });

  it('refuses a bid from the bidder who already leads', () => {
    const opened = bid(phoneLot(), 'ada', 60_000);
    expect(bid(opened.state, 'ada', 90_000).rejection).toEqual({ reason: 'already_leading' });
    expect(bid(opened.state, 'ada', 90_000).state.leaderMaxKobo).toBe(naira(60_000));
  });

  it.each([
    ['scheduled', 'auction_not_open'],
    ['paused', 'bidding_paused'],
    ['closing', 'auction_closed'],
    ['closed', 'auction_closed'],
  ] as const)('refuses a bid on a %s lot with %s', (status, reason) => {
    expect(bid(phoneLot({ status }), 'ada', 60_000).rejection?.reason).toBe(reason);
  });

  it('refuses a bid at or after the end time, to the millisecond', () => {
    const lot = phoneLot();
    expect(apply(lot, bidOf('ada', 60_000), lot.endsAt - 1).rejection).toBeUndefined();
    expect(apply(lot, bidOf('ada', 60_000), lot.endsAt).rejection?.reason).toBe('auction_closed');
    expect(apply(lot, bidOf('ada', 60_000), lot.endsAt + 1).rejection?.reason).toBe(
      'auction_closed',
    );
  });

  it('throws on a command for a different lot — that is our bug, not a bidder’s', () => {
    expect(() =>
      apply(phoneLot(), bidOf('ada', 60_000, { lotId: 'lot_other' }), earlyTime),
    ).toThrow(EngineError);
  });
});

describe('Buy Now (design §7.9)', () => {
  const withBuyNow = phoneLot({ buyNowPriceKobo: naira(70_000) });

  it('sells and closes the lot at the Buy Now price', () => {
    const result = apply(
      withBuyNow,
      {
        kind: 'buy_now',
        lotId: withBuyNow.lotId,
        userId: 'ada',
        idempotencyKey: 'key_buy_now',
        bidLimitKobo: naira(1_000_000),
        limitReason: 'deposit_required',
      },
      earlyTime,
    );
    expect(result.rejection).toBeUndefined();
    expect(result.state.status).toBe('closed');
    expect(result.state.outcome).toBe('sold');
    expect(result.state.priceKobo).toBe(naira(70_000));
    expect(result.state.leaderUserId).toBe('ada');
    expect(kinds(result.events)).toContain('buy_now_purchased');
    expect(kinds(result.events)).toContain('lot_closed');
  });

  it('is withdrawn by the first bid, so both can never succeed', () => {
    const afterBid = bid(withBuyNow, 'ada', 60_000);
    expect(afterBid.state.buyNowPriceKobo).toBeNull();
    expect(kinds(afterBid.events)).toContain('buy_now_withdrawn');

    const tooLate = apply(
      afterBid.state,
      {
        kind: 'buy_now',
        lotId: withBuyNow.lotId,
        userId: 'bola',
        idempotencyKey: 'key_buy_now_late',
        bidLimitKobo: naira(1_000_000),
        limitReason: 'deposit_required',
      },
      earlyTime,
    );
    expect(tooLate.rejection).toEqual({ reason: 'buy_now_unavailable' });
  });
});

describe('closing', () => {
  const closeCommand = { kind: 'close_lot', lotId: 'lot_phone_1' } as const;

  it('will not close a lot that is not yet due', () => {
    const lot = phoneLot();
    expect(apply(lot, closeCommand, lot.endsAt - 1).rejection).toEqual({ reason: 'not_yet_due' });
  });

  it('sells to the leader when the reserve is met', () => {
    const lot = bid(
      bid(bid(phoneLot(), 'ada', 60_000).state, 'bola', 55_000).state,
      'chidi',
      60_000,
    ).state;
    const closed = apply(lot, closeCommand, lot.endsAt);
    expect(closed.state.status).toBe('closed');
    expect(closed.state.outcome).toBe('sold');
    expect(closed.events[0]).toEqual(
      expect.objectContaining({ kind: 'lot_closed', outcome: 'sold', winnerUserId: 'ada' }),
    );
  });

  it('does not sell below a hidden reserve, but records the high bidder', () => {
    const lot = bid(phoneLot(), 'ada', 55_000).state;
    const closed = apply(lot, closeCommand, lot.endsAt);
    expect(closed.state.outcome).toBe('unsold_reserve_not_met');
    expect(closed.events[0]).toEqual(
      expect.objectContaining({ winnerUserId: null, highBidderUserId: 'ada' }),
    );
  });

  it('records a lot with no bids as unsold', () => {
    const lot = phoneLot();
    expect(apply(lot, closeCommand, lot.endsAt).state.outcome).toBe('unsold_no_bids');
  });

  it('closes exactly once — a second close is refused', () => {
    const lot = phoneLot();
    const first = apply(lot, closeCommand, lot.endsAt);
    const second = apply(first.state, closeCommand, lot.endsAt);
    expect(second.rejection).toEqual({ reason: 'auction_closed' });
    expect(second.events).toEqual([]);
    expect(second.state.seq).toBe(first.state.seq);
  });
});
