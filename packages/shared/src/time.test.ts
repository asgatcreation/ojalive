import { describe, expect, it } from 'vitest';
import { fakeClock, formatCountdown, MINUTE, SECOND } from './time.js';

describe('fakeClock', () => {
  it('only moves when told to, so closing tests are deterministic', () => {
    const clock = fakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, 'Closed'],
    [-1, 'Closed'],
    [12 * SECOND, '12s'],
    [4 * MINUTE + 9 * SECOND, '4m 09s'],
    [6 * 3_600_000 + 12 * MINUTE, '6h 12m'],
    [2 * 86_400_000 + 4 * 3_600_000, '2d 4h'],
  ])('formats %i as %s', (millis, expected) => {
    expect(formatCountdown(millis)).toBe(expected);
  });
});
