import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env.js';

const minimal = {
  DATABASE_URL: 'postgresql://ojalive:ojalive@localhost:55436/ojalive',
  REDIS_URL: 'redis://localhost:56386',
};

describe('worker env', () => {
  it('applies defaults', () => {
    const env = loadWorkerEnv(minimal);
    expect(env.NODE_ENV).toBe('development');
    expect(env.SWEEPER_INTERVAL_MS).toBe(30_000);
    expect(env.FEATURE_STRICT_DURABILITY).toBe(false);
  });

  it('refuses to start without a database url, loudly', () => {
    expect(() => loadWorkerEnv({ REDIS_URL: 'redis://localhost:56386' })).toThrow(
      /DATABASE_URL is required/,
    );
  });

  it('parses feature flags from strings', () => {
    const env = loadWorkerEnv({ ...minimal, FEATURE_STRICT_DURABILITY: 'true' });
    expect(env.FEATURE_STRICT_DURABILITY).toBe(true);
  });

  it('never puts the secret values in the error message', () => {
    try {
      loadWorkerEnv({ ...minimal, SWEEPER_INTERVAL_MS: '10' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('ojalive:ojalive');
    }
  });
});
