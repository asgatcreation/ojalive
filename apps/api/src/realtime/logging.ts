/**
 * The logging this layer needs, and nothing more.
 *
 * Fastify hands out a `FastifyBaseLogger`, which is pino-shaped but not pino's
 * `Logger` type. Rather than cast one to the other, the real-time code asks for
 * the four methods it actually calls — so it works with Fastify's logger, a
 * plain pino instance, or a recording stub in a test, without any of them
 * having to match a type they do not control.
 */

type LogFn = (details: object, message?: string) => void;

export interface RealtimeLogger {
  readonly debug: LogFn;
  readonly info: LogFn;
  readonly warn: LogFn;
  readonly error: LogFn;
}
