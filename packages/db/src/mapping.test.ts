import { describe, expect, it } from 'vitest';
import { naira } from '@ojalive/shared';
import { initialStateForReplay, toEngineState, toEngineStatus } from './mapping.js';
import { fromStoredRules, toStoredRules } from './rules.js';
import type { LotRow, LotStateRow } from './schema.js';

const rules = {
  incrementBands: [
    { upToKobo: naira(100_000), stepKobo: naira(1_000) },
    { upToKobo: null, stepKobo: naira(5_000) },
  ],
  softClose: {
    windowMillis: 120_000,
    extensionMillis: 120_000,
    maxTotalExtensionMillis: 1_800_000,
  },
};

const originalEndsAt = new Date('2026-12-01T13:00:00.000Z');
const extendedEndsAt = new Date('2026-12-01T13:05:00.000Z');

const lot: LotRow = {
  id: 'lot_1',
  saleId: 'sale_1',
  sellerId: null,
  lotNumber: 1,
  title: 'A phone',
  slug: 'a-phone',
  description: '',
  lotType: 'single',
  quantity: 1,
  attributes: {},
  conditionGrade: null,
  startingPriceKobo: naira(50_000),
  reservePriceKobo: naira(58_000),
  buyNowPriceKobo: null,
  opensAt: new Date('2026-11-30T13:00:00.000Z'),
  endsAt: extendedEndsAt,
  originalEndsAt,
  extensionCount: 2,
  status: 'open',
  rulesSnapshot: toStoredRules(rules),
  isDemo: true,
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
};

const projection: LotStateRow = {
  lotId: 'lot_1',
  seq: 4,
  priceKobo: naira(61_000),
  leaderUserId: 'user_dapo',
  leaderMaxKobo: naira(75_000),
  leaderMaxSetSeq: 4,
  bidCount: 4,
  endsAt: extendedEndsAt,
  reserveMet: true,
  updatedAt: new Date(),
};

describe('toEngineStatus', () => {
  it.each([
    ['draft', 'scheduled'],
    ['submitted', 'scheduled'],
    ['approved', 'scheduled'],
    ['scheduled', 'scheduled'],
    ['open', 'open'],
    ['paused', 'paused'],
    ['closing', 'closing'],
    ['closed', 'closed'],
    // A cancelled lot takes no more bids, which is all the engine needs to know.
    ['cancelled', 'closed'],
  ] as const)('maps %s to %s', (stored, expected) => {
    expect(toEngineStatus(stored)).toBe(expected);
  });
});

describe('toEngineState', () => {
  it('takes the live numbers from the projection', () => {
    const state = toEngineState(lot, projection);
    expect(state.seq).toBe(4);
    expect(state.priceKobo).toBe(naira(61_000));
    expect(state.leaderUserId).toBe('user_dapo');
    expect(state.leaderMaxSetSeq).toBe(4);
    expect(state.endsAt).toBe(extendedEndsAt.getTime());
    expect(state.rules.incrementBands[0]?.stepKobo).toBe(naira(1_000));
  });

  it('falls back to the lot itself when there is no projection yet', () => {
    const state = toEngineState(lot, null);
    expect(state.seq).toBe(0);
    expect(state.bidCount).toBe(0);
    expect(state.priceKobo).toBe(naira(50_000));
    expect(state.leaderUserId).toBeNull();
  });
});

describe('initialStateForReplay', () => {
  it('starts from the ORIGINAL end time, so extensions are recomputed not restored', () => {
    const state = initialStateForReplay(lot);
    expect(state.endsAt).toBe(originalEndsAt.getTime());
    expect(state.originalEndsAt).toBe(originalEndsAt.getTime());
    expect(state.extensionCount).toBe(0);
  });

  it('starts open, whatever the lot says now, because the log closes it again', () => {
    expect(initialStateForReplay({ ...lot, status: 'closed' }).status).toBe('open');
  });

  it('keeps the frozen rules, not whatever the category says today', () => {
    expect(initialStateForReplay(lot).rules.softClose.windowMillis).toBe(120_000);
  });
});

describe('stored rules', () => {
  it('round-trips through JSONB without losing a kobo', () => {
    expect(fromStoredRules(toStoredRules(rules))).toEqual(rules);
  });

  it('stores amounts as strings, because JSON cannot hold a bigint', () => {
    const stored = toStoredRules(rules);
    expect(stored.incrementBands).toEqual([
      { upToKobo: '10000000', stepKobo: '100000' },
      { upToKobo: null, stepKobo: '500000' },
    ]);
    // The real point: this is what makes the row serialisable at all.
    expect(() => JSON.stringify(stored)).not.toThrow();
    expect(() => JSON.stringify(rules)).toThrow(TypeError);
  });
});
