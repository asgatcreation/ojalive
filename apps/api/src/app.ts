import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import { newTraceId } from '@ojalive/shared';
import type { ApiEnv } from './env.js';
import { registry } from './lib/metrics.js';

export interface BuildAppOptions {
  readonly env: ApiEnv;
  /** Set by the readiness probe once dependencies are reachable. */
  readonly isReady: () => boolean;
}

/**
 * Build the Fastify app.
 *
 * Kept separate from starting it so tests can build an app, inject requests and
 * never open a port.
 */
export async function buildApp({ env, isReady }: BuildAppOptions) {
  // Pretty logs in development only. Built conditionally rather than set to
  // `undefined`, because `exactOptionalPropertyTypes` treats those differently.
  const transport =
    env.NODE_ENV === 'development'
      ? ({
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        } as const)
      : undefined;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Logs are structured, and must never carry a secret or a bidder's maximum.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-paystack-signature"]',
          'req.body.password',
          'req.body.maxKobo',
          'maxKobo',
          'leaderMaxKobo',
        ],
        censor: '[redacted]',
      },
      ...(transport ? { transport } : {}),
    },
    // Every request — and so every bid — carries an id that appears in each log line.
    genReqId: () => newTraceId(),
    trustProxy: true,
    bodyLimit: 1_000_000,
    disableRequestLogging: false,
  });

  await app.register(sensible);
  await app.register(helmet, {
    // The API serves JSON, not pages; the web app sets its own CSP.
    contentSecurityPolicy: false,
  });
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Per-user and per-lot bid limits are enforced in the engine, not here.
    keyGenerator: (request) => request.ip,
  });

  app.get('/health', () => ({
    status: 'ok',
    service: 'ojalive-api',
    time: new Date().toISOString(),
  }));

  app.get('/ready', (_request, reply) => {
    if (!isReady()) {
      return reply.code(503).send({ status: 'not_ready' });
    }
    return { status: 'ready' };
  });

  app.get('/metrics', (_request, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  return app;
}

/** The concrete app type, so tests and plugins do not have to restate the generics. */
export type OjaLiveApp = Awaited<ReturnType<typeof buildApp>>;
