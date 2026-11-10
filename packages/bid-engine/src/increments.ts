import type { Kobo } from '@ojalive/shared';
import type { IncrementBand } from './types.js';

export class IncrementTableError extends Error {}

/**
 * Validate an increment table once, at the point it is configured, rather than
 * discovering a gap in it during a live auction.
 *
 * Bands must be ordered, have positive steps, and the last band must be open
 * ended (`upToKobo: null`) so that there is always an answer for any price.
 */
export function assertValidIncrementBands(bands: readonly IncrementBand[]): void {
  if (bands.length === 0) {
    throw new IncrementTableError('An increment table needs at least one band');
  }

  let previousBound: Kobo | null = null;
  for (const [index, band] of bands.entries()) {
    if (band.stepKobo <= 0n) {
      throw new IncrementTableError(`Band ${index} has a non-positive step: ${band.stepKobo}`);
    }
    const isLast = index === bands.length - 1;
    if (isLast) {
      if (band.upToKobo !== null) {
        throw new IncrementTableError(
          'The last increment band must be open ended (upToKobo: null), ' +
            'otherwise there is no increment for a high enough price',
        );
      }
      continue;
    }
    if (band.upToKobo === null) {
      throw new IncrementTableError(`Only the last band may be open ended; band ${index} is not`);
    }
    if (band.upToKobo <= 0n) {
      throw new IncrementTableError(`Band ${index} has a non-positive bound: ${band.upToKobo}`);
    }
    if (previousBound !== null && band.upToKobo <= previousBound) {
      throw new IncrementTableError(
        `Increment bands must ascend; band ${index} bound ${band.upToKobo} ` +
          `does not exceed the previous bound ${previousBound}`,
      );
    }
    previousBound = band.upToKobo;
  }
}

/** The increment that applies at `priceKobo`. */
export function incrementFor(priceKobo: Kobo, bands: readonly IncrementBand[]): Kobo {
  for (const band of bands) {
    if (band.upToKobo === null || priceKobo < band.upToKobo) {
      return band.stepKobo;
    }
  }
  // Unreachable while the table is valid; assertValidIncrementBands enforces that.
  throw new IncrementTableError(`No increment band covers ${priceKobo}`);
}

/**
 * The smallest maximum the engine will accept next.
 *
 * Before any bid, that is the starting price — a lot opens AT its start price,
 * it does not open one increment above it.
 */
export function minimumAcceptableKobo(args: {
  readonly bidCount: number;
  readonly priceKobo: Kobo;
  readonly startingPriceKobo: Kobo;
  readonly bands: readonly IncrementBand[];
}): Kobo {
  if (args.bidCount === 0) return args.startingPriceKobo;
  return args.priceKobo + incrementFor(args.priceKobo, args.bands);
}

/**
 * The amounts behind the quick-bid buttons: the next valid bid and a couple of
 * steps beyond it, so a bidder on a phone does not have to type.
 */
export function quickBidAmounts(args: {
  readonly bidCount: number;
  readonly priceKobo: Kobo;
  readonly startingPriceKobo: Kobo;
  readonly bands: readonly IncrementBand[];
  readonly count?: number;
}): Kobo[] {
  const count = args.count ?? 3;
  const amounts: Kobo[] = [];
  let next = minimumAcceptableKobo(args);
  for (let i = 0; i < count; i += 1) {
    amounts.push(next);
    next += incrementFor(next, args.bands);
  }
  return amounts;
}
