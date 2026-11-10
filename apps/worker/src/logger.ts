import { pino, type Logger } from 'pino';
import type { WorkerEnv } from './env.js';

export function createLogger(env: WorkerEnv): Logger {
  // Pretty output in development only. Built conditionally rather than set to
  // `undefined`, because `exactOptionalPropertyTypes` treats those differently.
  const transport =
    env.NODE_ENV === 'development'
      ? ({
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        } as const)
      : undefined;

  return pino({
    level: env.LOG_LEVEL,
    base: { app: 'ojalive-worker' },
    redact: {
      paths: ['maxKobo', 'leaderMaxKobo', 'bvn', 'imei', 'secret', 'token'],
      censor: '[redacted]',
    },
    ...(transport ? { transport } : {}),
  });
}
