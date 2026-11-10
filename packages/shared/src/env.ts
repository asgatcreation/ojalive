/**
 * Environment parsing.
 *
 * Every boundary is validated with zod, and the process environment is a
 * boundary. A missing DATABASE_URL should stop the process at startup with a
 * clear message, not surface as a null pointer during someone's bid.
 */

import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .or(z.boolean());

/**
 * A required environment variable.
 *
 * `z.string().min(1, msg)` only reports `msg` when the value is present but
 * empty — a missing variable gets zod's generic "expected string, received
 * undefined". Both cases are the same mistake to whoever is reading the error,
 * so both get the same message.
 */
function requiredString(message: string) {
  return z.string({ error: message }).min(1, message);
}

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: requiredString('DATABASE_URL is required — see .env.example'),
  REDIS_URL: requiredString('REDIS_URL is required — see .env.example'),
  SENTRY_DSN: z.string().optional(),
  FEATURE_STRICT_DURABILITY: booleanFromString.default(false),
  FEATURE_DEMO_BOTS: booleanFromString.default(false),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/**
 * Parse an environment object, failing loudly and readably.
 *
 * Note what this never does: print the values. A thrown error here must not leak
 * a database password into a log aggregator.
 */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}
