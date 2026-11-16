/**
 * The anti-sniping soft close, against a fake clock (design §7.5).
 *
 * Every time here is exact to the millisecond: the server clock is the only
 * clock that decides anything, so these are the tests that have to be fussy.
 */

import { describe, expect, it } from 'vitest';
import { fakeClock, naira, SECOND } from '@ojalive/shared';
import { apply } from './engine.js';
import {
  bidOf,
  endsAtFixture,
  flatBands,
  lotRules,
  phoneLot,
  standardSoftClose,
} from './test-support.js';
import type { BidEvent, LotState } from './types.js';

const cap = endsAtFixture + standardSoftClose.maxTotalExtensionMillis;

function softCloseLot(overrides: Partial<LotState> = {}): LotState {
  return phoneLot({
    rules: lotRules({ incrementBands: flatBands, softClose: standardSoftClose }),
    ...overrides,
  });
}

function extensionOf(events: readonly BidEvent[]) {
  return events.find((event) => event.kind === 'end_time_extended');
}

describe('soft close', () => {
  it('leaves the end time alone for a bid outside the window', () => {
    // 13:57:10 against a 14:00:00 close, with a 120 s window.
    const clock = fakeClock(endsAtFixture - 170 * SECOND);
    const result = apply(softCloseLot(), bidOf('ada', 60_000), clock.now());

    expect(result.rejection).toBeUndefined();
    expect(result.state.endsAt).toBe(endsAtFixture);
    expect(result.state.extensionCount).toBe(0);
    expect(extensionOf(result.events)).toBeUndefined();
  });

  it('pushes the end time to the bid time plus the extension for a snipe', () => {
    // 13:59:58 — two seconds left, inside the window.
    const clock = fakeClock(endsAtFixture - 2 * SECOND);
    const result = apply(softCloseLot(), bidOf('ada', 60_000), clock.now());

    expect(result.state.endsAt).toBe(clock.now() + 120 * SECOND);
    expect(result.state.endsAt).toBe(endsAtFixture + 118 * SECOND);
    expect(result.state.extensionCount).toBe(1);
    expect(extensionOf(result.events)).toEqual(
      expect.objectContaining({
        kind: 'end_time_extended',
        previousEndsAt: endsAtFixture,
        endsAt: endsAtFixture + 118 * SECOND,
        extensionCount: 1,
        seq: 1,
      }),
    );
  });

  it('treats the window edge exactly: one millisecond inside it extends, on it does not', () => {
    const onTheEdge = apply(
      softCloseLot(),
      bidOf('ada', 60_000),
      endsAtFixture - standardSoftClose.windowMillis,
    );
    expect(onTheEdge.state.endsAt).toBe(endsAtFixture);

    const justInside = apply(
      softCloseLot(),
      bidOf('ada', 60_000),
      endsAtFixture - standardSoftClose.windowMillis + 1,
    );
    expect(justInside.state.endsAt).toBeGreaterThan(endsAtFixture);
  });

  it('extends again for a counter-bid inside the new window', () => {
    const clock = fakeClock(endsAtFixture - 2 * SECOND);
    const first = apply(softCloseLot(), bidOf('ada', 60_000), clock.now());

    // 14:01:57 — one second before the extended end.
    clock.set(first.state.endsAt - SECOND);
    const second = apply(first.state, bidOf('bola', 65_000), clock.now());

    expect(second.rejection).toBeUndefined();
    expect(second.state.endsAt).toBe(clock.now() + 120 * SECOND);
    expect(second.state.extensionCount).toBe(2);
  });

  it('never extends past the cap, however long the bidding war runs', () => {
    let state = softCloseLot();
    let extensions = 0;
    let acceptedAfterTheCap = 0;
    let extendedAfterTheCap = 0;

    // Two bidders taking turns, each bidding one second before the end.
    for (let round = 0; round < 40; round += 1) {
      const atTheCapAlready = state.endsAt === cap;
      const result = apply(
        state,
        bidOf(round % 2 === 0 ? 'ada' : 'bola', 60_000 + round * 5_000),
        state.endsAt - SECOND,
      );
      expect(result.rejection).toBeUndefined();
      if (extensionOf(result.events) !== undefined) extensions += 1;
      if (atTheCapAlready) {
        acceptedAfterTheCap += 1;
        if (extensionOf(result.events) !== undefined) extendedAfterTheCap += 1;
      }
      state = result.state;
      expect(state.endsAt).toBeLessThanOrEqual(cap);
    }

    expect(state.endsAt).toBe(cap);
    expect(state.extensionCount).toBe(extensions);
    // Bidding is not blocked once the cap is reached — it simply stops moving
    // the end time, so a lot cannot be held open forever by two stubborn people.
    expect(acceptedAfterTheCap).toBeGreaterThan(0);
    expect(extendedAfterTheCap).toBe(0);
  });

  it('refuses a bid one millisecond after the capped end time', () => {
    const capped = softCloseLot({ endsAt: cap, extensionCount: 15 });
    expect(apply(capped, bidOf('ada', 60_000), cap - 1).rejection).toBeUndefined();
    expect(apply(capped, bidOf('ada', 60_000), cap).rejection?.reason).toBe('auction_closed');
    expect(apply(capped, bidOf('ada', 60_000), cap + 1).rejection?.reason).toBe('auction_closed');
  });

  it('closes at the extended end time, not the original one', () => {
    const clock = fakeClock(endsAtFixture - 2 * SECOND);
    const extended = apply(softCloseLot(), bidOf('ada', 60_000), clock.now());
    const close = { kind: 'close_lot', lotId: extended.state.lotId } as const;

    clock.set(endsAtFixture + SECOND);
    expect(apply(extended.state, close, clock.now()).rejection).toEqual({ reason: 'not_yet_due' });

    clock.set(extended.state.endsAt);
    const closed = apply(extended.state, close, clock.now());
    expect(closed.rejection).toBeUndefined();
    expect(closed.state.status).toBe('closed');
    expect(closed.state.priceKobo).toBe(naira(50_000));
    expect(closed.state.outcome).toBe('unsold_reserve_not_met');
  });
});
