import { describe, expect, it } from 'vitest';
import { applyPercent, formatNaira, koboFromDecimal, MoneyError, naira, sumKobo } from './money.js';

describe('naira', () => {
  it('converts whole naira to kobo', () => {
    expect(naira(50_000)).toBe(5_000_000n);
  });

  it('refuses fractional input, which would mean someone has a float', () => {
    expect(() => naira(1.5)).toThrow(MoneyError);
  });
});

describe('koboFromDecimal', () => {
  it('parses whole and fractional naira', () => {
    expect(koboFromDecimal('1234.56')).toBe(123_456n);
    expect(koboFromDecimal('1234')).toBe(123_400n);
    expect(koboFromDecimal('1234.5')).toBe(123_450n);
  });

  it('accepts thousands separators and surrounding space', () => {
    expect(koboFromDecimal(' 8,200,000 ')).toBe(820_000_000n);
  });

  it('handles negatives, for refunds and ledger credits', () => {
    expect(koboFromDecimal('-10.25')).toBe(-1025n);
  });

  it.each(['', 'abc', '1.234', '1..2', '₦100'])('rejects %j', (input) => {
    expect(() => koboFromDecimal(input)).toThrow(MoneyError);
  });
});

describe('formatNaira', () => {
  it('groups thousands and hides kobo when whole', () => {
    expect(formatNaira(820_000_000n)).toBe('₦8,200,000');
  });

  it('shows kobo when there is a fraction', () => {
    expect(formatNaira(123_456n)).toBe('₦1,234.56');
  });

  it('can be forced to show kobo', () => {
    expect(formatNaira(5_000_000n, { alwaysShowKobo: true })).toBe('₦50,000.00');
  });

  it('formats negatives', () => {
    expect(formatNaira(-1025n)).toBe('-₦10.25');
  });
});

describe('applyPercent', () => {
  it('applies 7.5% buyers premium', () => {
    // ₦8,200,000 hammer -> ₦615,000 premium
    expect(applyPercent(820_000_000n, 750)).toBe(61_500_000n);
  });

  it('rounds half up rather than truncating', () => {
    // 1 kobo at 50% is exactly half a kobo.
    expect(applyPercent(1n, 5000)).toBe(1n);
  });

  it('rounds down below half', () => {
    expect(applyPercent(1n, 4999)).toBe(0n);
  });

  it('refuses fractional basis points', () => {
    expect(() => applyPercent(100n, 7.5)).toThrow(MoneyError);
  });
});

describe('sumKobo', () => {
  it('sums, including the empty case', () => {
    expect(sumKobo([])).toBe(0n);
    expect(sumKobo([100n, 250n, -50n])).toBe(300n);
  });
});
