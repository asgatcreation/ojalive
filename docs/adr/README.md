# Architecture Decision Records

One short file per decision that would be expensive to reverse or confusing to
inherit. Format: context, decision, why, alternatives considered, consequences.

| ADR                                                    | Decision                                                              | Status   |
| ------------------------------------------------------ | --------------------------------------------------------------------- | -------- |
| [0001](0001-redis-lua-serialisation-postgres-truth.md) | Redis Lua as the serialisation point, Postgres as the source of truth | Accepted |
| [0002](0002-single-region-london.md)                   | Deploy everything in London, not Johannesburg                         | Accepted |
| [0003](0003-drizzle-over-prisma.md)                    | Drizzle, not Prisma                                                   | Accepted |
| [0004](0004-typescript-6-not-7.md)                     | TypeScript 6, not 7                                                   | Accepted |
| [0005](0005-append-only-log-rebuildable-projection.md) | Append-only bid log with a rebuildable projection                     | Accepted |
| [0006](0006-socketio-redis-adapter-own-resync.md)      | Socket.IO redis-adapter plus our own sequence resync                  | Accepted |
