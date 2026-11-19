/**
 * Where Lua's own number formatting stops being safe for money.
 *
 * `prelude.lua` routes every amount through `fmt` (`string.format('%.0f', n)`)
 * rather than `tostring`. This test establishes the actual reason, because the
 * reason turned out to be narrower than the comment first claimed: Lua prints
 * with "%.14g", so `tostring` is exact to 14 digits and only then switches to
 * exponent form.
 *
 * 1e15 kobo is ₦10 trillion, which no lot will ever be worth — so `fmt` is a
 * guard against an unexpected magnitude, not a fix for a live bug. Keeping the
 * threshold in a test means the next person does not have to take either the
 * comment's or my word for it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { TEST_REDIS_URL } from './int-support.js';

let redis: Redis;

beforeAll(() => {
  redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 3 });
});

afterAll(() => {
  redis.disconnect();
});

async function formatInLua(value: string): Promise<{ plain: string; formatted: string }> {
  const reply: unknown = await redis.eval(
    "local n = tonumber(ARGV[1]) return { tostring(n), string.format('%.0f', n) }",
    0,
    value,
  );
  if (!Array.isArray(reply)) throw new Error('Unexpected reply');
  const [plain, formatted] = reply as [unknown, unknown];
  if (typeof plain !== 'string' || typeof formatted !== 'string') {
    throw new Error('Unexpected reply types');
  }
  return { plain, formatted };
}

describe('money formatting in Lua', () => {
  it.each([
    ['5000000', '₦50,000'],
    ['100000000000', '₦1 billion'],
    ['99999999999999', 'the largest amount tostring still prints in full'],
  ])('is identical either way at %s kobo (%s)', async (kobo) => {
    const { plain, formatted } = await formatInLua(kobo);
    expect(formatted).toBe(kobo);
    expect(plain).toBe(kobo);
  });

  it('diverges at 1e15 kobo (₦10 trillion), where tostring switches to exponent form', async () => {
    const { plain, formatted } = await formatInLua('1000000000000000');
    expect(plain).toBe('1e+15');
    expect(formatted).toBe('1000000000000000');
  });

  it('round-trips an amount through a Redis hash without losing a kobo', async () => {
    const key = `ojalive:test:format:${String(Date.now())}`;
    try {
      await redis.eval(
        "redis.call('HSET', KEYS[1], 'amount', string.format('%.0f', tonumber(ARGV[1]))) return 1",
        1,
        key,
        '123456789012345',
      );
      expect(await redis.hget(key, 'amount')).toBe('123456789012345');
      expect(BigInt((await redis.hget(key, 'amount')) ?? '0')).toBe(123456789012345n);
    } finally {
      await redis.del(key);
    }
  });
});
