# ADR-0001: Redis Lua as the serialisation point, Postgres as the source of truth

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Thousands of people may bid on one lot within the same second. Two bids must
never both "win", the price must never skip an increment, and every accepted bid
needs a strictly increasing sequence number. We also need bid acknowledgement at
p95 under 150 ms from Nigeria.

A row lock in Postgres (`SELECT ... FOR UPDATE`) would be correct, but every bid
would then pay a database round trip plus lock contention on one hot row, and
under a few hundred bids per second on a single lot that queue becomes the
latency.

## Decision

Each lot's live state lives in Redis under one hash-tagged key, `{lot:<id>}`,
and is mutated **only** by a Lua script. Redis executes a script atomically on a
single thread, so concurrent bids become consecutive script runs — no
interleaving, and no lock for us to get wrong.

The same script appends the accepted event to a Redis Stream. A worker consumer
group persists those events into the append-only `bid_events` table in Postgres,
which is the **source of truth**. If the Redis projection and the Postgres log
ever disagree, the log wins.

## Why

- Atomicity without distributed locking. One script run per bid, per lot.
- Sub-millisecond state access, so the latency budget goes to the network
  between Lagos and London rather than to lock waits.
- The ordering decision and the durable record are produced by the same atomic
  step, so an accepted bid cannot exist without its event.
- It scales horizontally: any API instance can serve any bid on any lot, because
  the serialisation point is Redis, not the process.

## Alternatives considered

- **Postgres row locks.** Correct and simpler, but the hot-lot latency profile
  fails our target and a single hot row becomes the bottleneck.
- **Single-writer process per lot (actor model).** Correct and fast, but
  introduces lot-to-instance routing, failover of ownership and split-brain
  risk. More moving parts for the same guarantee.
- **Kafka or Redis Streams as the only ingress.** Great ordering, but the client
  cannot be told "accepted" until a consumer has processed the event, which adds
  latency to the one interaction that must feel instant.

## Consequences

- The bid rules exist twice: once in `packages/bid-engine` as pure TypeScript
  (the reference model) and once in Lua (the fast path). A differential test runs
  thousands of random command sequences through both and asserts identical
  results. Without that test this decision would be a liability.
- Redis durability is a real consideration, not an afterthought: AOF
  `appendfsync everysec` plus a replica, a stream-lag metric, and a
  feature-flagged strict mode that waits for the Postgres commit on high-value
  lots. The residual risk window is documented openly in the design doc §8.1.
- If Redis is lost entirely, lot state is rebuilt by replaying `bid_events`
  through the pure engine. See ADR-0005.
