/**
 * The Postgres connection.
 *
 * node-postgres with a pool, not Neon's serverless driver: the API and worker
 * are long-lived processes in the same region as the database (ADR-0002), so a
 * warm pool beats a connection per query.
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  readonly db: Database;
  readonly pool: Pool;
  /** Close every connection. Called on SIGTERM, and by every test teardown. */
  readonly close: () => Promise<void>;
}

export interface DbOptions {
  readonly url: string;
  readonly max?: number;
  /** Fail fast rather than hanging a request behind an exhausted pool. */
  readonly connectionTimeoutMillis?: number;
}

export function createDb(options: DbOptions): DbHandle {
  const pool = new Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    // Postgres is UTC and so are we; this makes it explicit per session rather
    // than depending on the server's configured default.
    options: '-c timezone=UTC',
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
