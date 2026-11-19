// drizzle-kit reads this to generate migration SQL from the schema. Generating
// needs no database connection; `pnpm --filter @ojalive/db db:migrate` applies
// what it produces.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://ojalive:ojalive@localhost:55436/ojalive',
  },
  strict: true,
  verbose: true,
});
