# ADR-0003: Drizzle, not Prisma

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

We need a TypeScript data layer for Postgres 18. The schema is deliberately
SQL-shaped: an append-only event log, JSONB attribute documents with GIN
indexes, trigram search, partial indexes on `status = 'open'`, and a double-entry
ledger with a balance assertion.

## Decision

Drizzle ORM with Drizzle Kit for migrations.

## Why

- Partial, expression and GIN indexes are ordinary declarations in Drizzle. In
  Prisma they usually mean dropping to raw SQL in a migration the ORM then does
  not understand.
- JSONB querying is first class, and the category engine's filters are JSONB
  containment and range queries generated at runtime from a schema document.
- An append-only table that is never updated fits a query builder better than an
  ORM built around entity mutation.
- Thin at runtime, which matters on the bid path.
- Migrations are plain SQL files we read, review and can reverse. That suits the
  expand-then-contract rule for changes on live data.

## Alternatives considered

- **Prisma.** Better scaffolding and a nicer client for simple CRUD, but it
  fights every one of the specific things this schema needs.
- **Kysely.** Excellent query builder, but no migration story of its own, so we
  would be assembling two tools instead of one.
- **Raw `pg` with hand-written SQL.** Maximum control, no type safety across the
  boundary, and a lot of repetition.

## Consequences

- We write more SQL-like code, which is the point.
- Migrations are reviewed by hand. They must be reversible where possible, and
  seed and reset scripts must never touch real users.
