/**
 * The stored form of a lot's frozen rules.
 *
 * `lots.rules_snapshot` is JSONB, and JSON has no integers wider than a double
 * — `JSON.stringify` refuses a `bigint` outright. So amounts are stored as
 * decimal strings and converted at the edge, exactly as they are on the way in
 * and out of the Lua scripts. The alternative, storing kobo as JSON numbers,
 * would work until a lot was worth more than ₦90,071,992,547,409 and then fail
 * silently, which is the worst way for money to break.
 */

import type { IncrementBand, LotRules, SoftCloseRules } from '@ojalive/bid-engine';

export interface StoredIncrementBand {
  readonly upToKobo: string | null;
  readonly stepKobo: string;
}

export interface StoredLotRules {
  readonly incrementBands: readonly StoredIncrementBand[];
  readonly softClose: SoftCloseRules;
}

export function toStoredRules(rules: LotRules): StoredLotRules {
  return {
    incrementBands: rules.incrementBands.map((band) => ({
      upToKobo: band.upToKobo === null ? null : band.upToKobo.toString(),
      stepKobo: band.stepKobo.toString(),
    })),
    softClose: rules.softClose,
  };
}

export function fromStoredRules(stored: StoredLotRules): LotRules {
  const incrementBands: IncrementBand[] = stored.incrementBands.map((band) => ({
    upToKobo: band.upToKobo === null ? null : BigInt(band.upToKobo),
    stepKobo: BigInt(band.stepKobo),
  }));
  return { incrementBands, softClose: stored.softClose };
}
