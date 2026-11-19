/**
 * Apply pending migrations. Run with `pnpm --filter @ojalive/db db:migrate`.
 *
 * Drizzle records what it has applied in `drizzle.__drizzle_migrations`, so this
 * is safe to run on every deploy and safe to run twice.
 */

import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const handle = createDb({ url, max: 1 });
  try {
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    // eslint-disable-next-line no-console
    console.log('Migrations applied.');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  // Never print the connection string: it carries the password.
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
