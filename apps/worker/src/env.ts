import { baseEnvSchema, parseEnv } from '@ojalive/shared';
import { z } from 'zod';

const workerEnvSchema = baseEnvSchema.extend({
  /** How often the stuck-lot sweeper runs. See design doc §8.5. */
  SWEEPER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  /** Grace period before the sweeper considers an open, past-due lot stuck. */
  SWEEPER_GRACE_MS: z.coerce.number().int().min(0).default(5_000),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
