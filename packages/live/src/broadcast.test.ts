import { describe, expect, it } from 'vitest';
import { naira } from '@ojalive/shared';
import type { LotState } from '@ojalive/bid-engine';
import { toPublicEvent, toPublicSnapshot } from './broadcast.js';
import type { StreamEvent } from './stream.js';

const event: StreamEvent = {
  id: '7-0',
  lotId: 'lot_1',
  seq: 7,
  at: 1_800_000_000_000,
  kind: 'bid',
  userId: 'user_emeka',
  // The secret maximum. It is in the stream because the persisting worker needs
  // it; it must not survive the trip through toPublicEvent.
  maxKobo: naira(80_000),
  priceKobo: naira(79_000),
  leaderUserId: 'user_emeka',
  leaderMaxKobo: naira(80_000),
  leaderMaxSetSeq: 7,
  bidCount: 7,
  endsAt: 1_800_000_060_000,
  extensionCount: 1,
  reserveMet: true,
  idempotencyKey: 'key-1',
  source: 'web',
  lotOutcome: null,
};

const state: LotState = {
  lotId: 'lot_1',
  status: 'open',
  seq: 7,
  priceKobo: naira(79_000),
  startingPriceKobo: naira(50_000),
  reservePriceKobo: naira(58_000),
  buyNowPriceKobo: null,
  leaderUserId: 'user_emeka',
  leaderMaxKobo: naira(80_000),
  leaderMaxSetSeq: 7,
  bidCount: 7,
  endsAt: 1_800_000_060_000,
  originalEndsAt: 1_800_000_000_000,
  extensionCount: 1,
  outcome: null,
  rules: {
    incrementBands: [{ upToKobo: null, stepKobo: naira(1_000) }],
    softClose: { windowMillis: 0, extensionMillis: 0, maxTotalExtensionMillis: 0 },
  },
};

/** Every amount anywhere in the payload, however deeply nested. */
function amountsIn(value: unknown): string[] {
  if (typeof value === 'string') return /^\d{4,}$/.test(value) ? [value] : [];
  if (typeof value === 'number') return [String(value)];
  if (typeof value === 'bigint') return [value.toString()];
  if (Array.isArray(value)) return value.flatMap(amountsIn);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(amountsIn);
  }
  return [];
}

describe('toPublicEvent', () => {
  const published = toPublicEvent(event);

  it('carries the price, the leader and the sequence number', () => {
    expect(published).toEqual({
      lotId: 'lot_1',
      seq: 7,
      at: 1_800_000_000_000,
      kind: 'bid',
      priceKobo: '7900000',
      leaderUserId: 'user_emeka',
      bidCount: 7,
      endsAt: 1_800_000_060_000,
      extensionCount: 1,
      reserveMet: true,
      lotOutcome: null,
    });
  });

  it('does not carry a secret maximum, under any key', () => {
    // Value by value, not as a substring of the serialised payload: "8000000"
    // occurs inside the epoch timestamp 1800000060000, so a `toContain` on the
    // JSON fails for a reason that has nothing to do with leaking anything.
    // Checking each value separately is both stricter and honest.
    expect(amountsIn(published)).not.toContain(naira(80_000).toString());
    expect(Object.keys(published)).not.toContain('maxKobo');
    expect(Object.keys(published)).not.toContain('leaderMaxKobo');
    expect(Object.keys(published)).not.toContain('leaderMaxSetSeq');
  });

  it('does not carry the idempotency key either — that is nobody else’s business', () => {
    expect(JSON.stringify(published)).not.toContain('key-1');
  });

  it('sends amounts as strings, so a big price cannot be rounded by JSON', () => {
    expect(typeof published.priceKobo).toBe('string');
    const huge = toPublicEvent({ ...event, priceKobo: 123_456_789_012_345_678n });
    expect(huge.priceKobo).toBe('123456789012345678');
  });
});

describe('toPublicSnapshot', () => {
  const snapshot = toPublicSnapshot(state, 1_800_000_030_000);

  it('says whether a reserve exists and whether it is met, never the amount', () => {
    expect(snapshot.hasReserve).toBe(true);
    expect(snapshot.reserveMet).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('5800000');
  });

  it('reports no reserve as no reserve, rather than as an unmet one', () => {
    const noReserve = toPublicSnapshot({ ...state, reservePriceKobo: null }, 0);
    expect(noReserve.hasReserve).toBe(false);
    expect(noReserve.reserveMet).toBe(true);
  });

  it('reports an unmet reserve without revealing how far off it is', () => {
    const unmet = toPublicSnapshot(
      { ...state, priceKobo: naira(50_000), reservePriceKobo: naira(58_000) },
      0,
    );
    expect(unmet.hasReserve).toBe(true);
    expect(unmet.reserveMet).toBe(false);
    expect(JSON.stringify(unmet)).not.toContain('5800000');
  });

  it('never carries the leader’s maximum', () => {
    expect(amountsIn(snapshot)).not.toContain(naira(80_000).toString());
  });

  it('carries the server clock, so a client can measure its own offset', () => {
    expect(snapshot.serverTime).toBe(1_800_000_030_000);
  });
});
