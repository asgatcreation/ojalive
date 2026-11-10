import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { naira } from '@ojalive/shared';
import {
  assertValidIncrementBands,
  IncrementTableError,
  incrementFor,
  minimumAcceptableKobo,
  quickBidAmounts,
} from './increments.js';
import type { IncrementBand } from './types.js';

/** The vehicles table from docs/MILESTONE-1-DESIGN.md §9.4. */
const vehicleBands: IncrementBand[] = [
  { upToKobo: naira(100_000), stepKobo: naira(1_000) },
  { upToKobo: naira(1_000_000), stepKobo: naira(5_000) },
  { upToKobo: null, stepKobo: naira(50_000) },
];

describe('assertValidIncrementBands', () => {
  it('accepts a well formed table', () => {
    expect(() => assertValidIncrementBands(vehicleBands)).not.toThrow();
  });

  it('rejects an empty table', () => {
    expect(() => assertValidIncrementBands([])).toThrow(IncrementTableError);
  });

  it('rejects a table whose last band is bounded, which would leave a gap', () => {
    expect(() =>
      assertValidIncrementBands([{ upToKobo: naira(100_000), stepKobo: naira(1_000) }]),
    ).toThrow(/open ended/);
  });

  it('rejects bands that do not ascend', () => {
    expect(() =>
      assertValidIncrementBands([
        { upToKobo: naira(1_000_000), stepKobo: naira(5_000) },
        { upToKobo: naira(100_000), stepKobo: naira(1_000) },
        { upToKobo: null, stepKobo: naira(50_000) },
      ]),
    ).toThrow(/ascend/);
  });

  it('rejects a non-positive step, which would let a bid not raise the price', () => {
    expect(() => assertValidIncrementBands([{ upToKobo: null, stepKobo: 0n }])).toThrow(
      /non-positive step/,
    );
  });
});

describe('incrementFor', () => {
  it.each([
    [naira(50_000), naira(1_000)],
    [naira(99_999), naira(1_000)],
    [naira(100_000), naira(5_000)],
    [naira(999_999), naira(5_000)],
    [naira(1_000_000), naira(50_000)],
    [naira(80_000_000), naira(50_000)],
  ])('at %s the step is %s', (price, expected) => {
    expect(incrementFor(price, vehicleBands)).toBe(expected);
  });

  it('is defined for every non-negative price', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: naira(10_000_000_000) }), (price) => {
        expect(incrementFor(price, vehicleBands)).toBeGreaterThan(0n);
      }),
    );
  });
});

describe('minimumAcceptableKobo', () => {
  it('is the starting price for the very first bid', () => {
    expect(
      minimumAcceptableKobo({
        bidCount: 0,
        priceKobo: naira(50_000),
        startingPriceKobo: naira(50_000),
        bands: vehicleBands,
      }),
    ).toBe(naira(50_000));
  });

  it('is one increment above the price once bidding has started', () => {
    expect(
      minimumAcceptableKobo({
        bidCount: 1,
        priceKobo: naira(61_000),
        startingPriceKobo: naira(50_000),
        bands: vehicleBands,
      }),
    ).toBe(naira(62_000));
  });

  it('always strictly exceeds the current price after the first bid', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: naira(5_000_000) }),
        fc.integer({ min: 1, max: 10_000 }),
        (priceKobo, bidCount) => {
          const minimum = minimumAcceptableKobo({
            bidCount,
            priceKobo,
            startingPriceKobo: 0n,
            bands: vehicleBands,
          });
          expect(minimum).toBeGreaterThan(priceKobo);
        },
      ),
    );
  });
});

describe('quickBidAmounts', () => {
  it('offers ascending amounts starting at the next valid bid', () => {
    expect(
      quickBidAmounts({
        bidCount: 1,
        priceKobo: naira(61_000),
        startingPriceKobo: naira(50_000),
        bands: vehicleBands,
      }),
    ).toEqual([naira(62_000), naira(63_000), naira(64_000)]);
  });

  it('steps up correctly when it crosses a band boundary', () => {
    expect(
      quickBidAmounts({
        bidCount: 1,
        priceKobo: naira(98_000),
        startingPriceKobo: naira(50_000),
        bands: vehicleBands,
        count: 3,
      }),
    ).toEqual([naira(99_000), naira(100_000), naira(105_000)]);
  });

  it('is always strictly ascending', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: naira(50_000_000) }), (priceKobo) => {
        const amounts = quickBidAmounts({
          bidCount: 1,
          priceKobo,
          startingPriceKobo: 0n,
          bands: vehicleBands,
          count: 5,
        });
        for (let i = 1; i < amounts.length; i += 1) {
          expect(amounts[i]!).toBeGreaterThan(amounts[i - 1]!);
        }
      }),
    );
  });
});
