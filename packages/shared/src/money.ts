/**
 * Money in Ojà Live is ALWAYS an integer number of kobo (1 naira = 100 kobo),
 * held in a `bigint`. There are no floating-point amounts anywhere in this
 * codebase, because a hammer price that is out by a fraction of a kobo is a
 * ledger that does not balance.
 */

export type Kobo = bigint;

export const KOBO_PER_NAIRA = 100n;

export class MoneyError extends Error {}

/** Build kobo from a whole number of naira. */
export function naira(amount: number): Kobo {
  if (!Number.isInteger(amount)) {
    throw new MoneyError(`naira() takes whole naira, got ${amount}. Use koboFromDecimal().`);
  }
  return BigInt(amount) * KOBO_PER_NAIRA;
}

/**
 * Parse a decimal naira string ("1234.56") into kobo. String input, not number,
 * so that "0.07" can never arrive here as 0.07000000000000001.
 */
export function koboFromDecimal(input: string): Kobo {
  const trimmed = input.trim().replace(/,/g, '');
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyError(`Not a valid naira amount: ${JSON.stringify(input)}`);
  }
  const [, sign, whole, fraction = '0'] = match;
  const kobo = BigInt(whole!) * KOBO_PER_NAIRA + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -kobo : kobo;
}

/** Format kobo for display: `₦1,234.56`, or `₦1,234` when it is a whole naira. */
export function formatNaira(amount: Kobo, options?: { alwaysShowKobo?: boolean }): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / KOBO_PER_NAIRA;
  const fraction = absolute % KOBO_PER_NAIRA;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const showKobo = options?.alwaysShowKobo === true || fraction !== 0n;
  const tail = showKobo ? `.${fraction.toString().padStart(2, '0')}` : '';
  return `${negative ? '-' : ''}₦${grouped}${tail}`;
}

/**
 * Apply a percentage (buyer's premium, commission, VAT) to an amount.
 *
 * `percentBasisPoints` is in basis points, so 7.5% is 750. Percentages are
 * never passed as floats, for the same reason amounts are not.
 *
 * Rounds half up, which is what an invoice a human will read should do.
 */
export function applyPercent(amount: Kobo, percentBasisPoints: number): Kobo {
  if (!Number.isInteger(percentBasisPoints)) {
    throw new MoneyError(`Basis points must be an integer, got ${percentBasisPoints}`);
  }
  const numerator = amount * BigInt(percentBasisPoints);
  const denominator = 10_000n;
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const roundsUp = remainder * 2n >= denominator;
  return roundsUp ? quotient + 1n : quotient;
}

/** Sum kobo amounts. Exists so no one is tempted to reach for `reduce` with `+`. */
export function sumKobo(amounts: readonly Kobo[]): Kobo {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return total;
}
