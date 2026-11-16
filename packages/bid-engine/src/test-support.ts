/**
 * Builders for the lots and commands the tests use.
 *
 * Test-only, and deliberately not re-exported from `index.ts` — the application
 * never builds a lot by hand. Milestone 4's differential tests, which run the
 * same command sequences through this engine and through the Lua script, import
 * it by path.
 */

import { naira, type EpochMillis } from '@ojalive/shared';
import type { IncrementBand, LotRules, LotState, PlaceBidCommand } from './types.js';

/** The phone-lot table from docs/MILESTONE-1-DESIGN.md §7.3: ₦1,000 steps. */
export const phoneBands: readonly IncrementBand[] = [
  { upToKobo: naira(100_000), stepKobo: naira(1_000) },
  { upToKobo: null, stepKobo: naira(5_000) },
];

/** A single open band, so the increment is the same at every price. */
export const flatBands: readonly IncrementBand[] = [{ upToKobo: null, stepKobo: naira(1_000) }];

/** The anti-sniping rules from §7.5: window 120 s, extension 120 s, cap 30 min. */
export const standardSoftClose = {
  windowMillis: 120_000,
  extensionMillis: 120_000,
  maxTotalExtensionMillis: 1_800_000,
} as const;

/** No extensions, for tests that are about proxy bidding rather than time. */
export const noSoftClose = {
  windowMillis: 0,
  extensionMillis: 0,
  maxTotalExtensionMillis: 0,
} as const;

/** 14:00:00 Lagos on 1 December 2026, as the §7.5 worked example uses. */
export const endsAtFixture: EpochMillis = Date.UTC(2026, 11, 1, 13, 0, 0);

export function lotRules(overrides: Partial<LotRules> = {}): LotRules {
  return {
    incrementBands: phoneBands,
    softClose: noSoftClose,
    ...overrides,
  };
}

/**
 * The §7.3 phone lot: open, start ₦50,000, hidden reserve ₦58,000, no bids yet,
 * ending far enough away that nothing in a proxy-bidding test touches the clock.
 */
export function phoneLot(overrides: Partial<LotState> = {}): LotState {
  const base: LotState = {
    lotId: 'lot_phone_1',
    status: 'open',
    seq: 0,
    priceKobo: naira(50_000),
    startingPriceKobo: naira(50_000),
    reservePriceKobo: naira(58_000),
    buyNowPriceKobo: null,
    leaderUserId: null,
    leaderMaxKobo: null,
    leaderMaxSetSeq: null,
    bidCount: 0,
    endsAt: endsAtFixture,
    originalEndsAt: endsAtFixture,
    extensionCount: 0,
    outcome: null,
    rules: lotRules(),
  };
  return { ...base, ...overrides };
}

/** A bid of `maxNaira`, cleared to any amount unless `bidLimitKobo` is given. */
export function bidOf(
  userId: string,
  maxNaira: number,
  overrides: Partial<PlaceBidCommand> = {},
): PlaceBidCommand {
  return {
    kind: 'place_bid',
    lotId: 'lot_phone_1',
    userId,
    maxKobo: naira(maxNaira),
    idempotencyKey: `key_${userId}_${String(maxNaira)}`,
    bidLimitKobo: naira(1_000_000_000),
    limitReason: 'deposit_required',
    ...overrides,
  };
}

/** Well before the end of the fixture lot — outside any soft-close window. */
export const earlyTime: EpochMillis = endsAtFixture - 3_600_000;
