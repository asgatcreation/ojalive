# ADR-0006: Socket.IO redis-adapter plus our own sequence resync

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

Several API instances must share Socket.IO rooms, and a client that drops its
connection — a Nigerian phone switching from 4G to Wi-Fi mid-auction — must come
back without missing or duplicating a bid.

Socket.IO offers two adapters: `@socket.io/redis-adapter` (8.3.0, pub/sub based,
the long-standing official one) and `@socket.io/redis-streams-adapter` (0.3.1,
Streams based, with at-least-once delivery between servers).

## Decision

Use `@socket.io/redis-adapter` 8.3.0 for cross-instance room fan-out, and
implement message recovery ourselves: every broadcast carries the lot's `seq`,
clients remember the last `seq` they saw, and on reconnect they send
`resync { lotId, fromSeq }` and receive the events they missed plus a current
snapshot. A REST endpoint provides the same data if sockets fail entirely.

## Why

- The streams adapter is pre-1.0, and the stability rules rule it out.
- The streams adapter only protects the hop _between servers_. Our own resync
  protects against client disconnects, server crashes, deploys and a dead Redis —
  a strictly larger set of failures.
- `seq` already exists and is already the authority for ordering, so resync
  reuses the mechanism that makes the bid engine correct instead of adding a
  second, parallel delivery guarantee.
- It gives us a REST fallback for free, which matters on a slow 3G connection
  where WebSockets sometimes simply do not establish.

## Alternatives considered

- **The streams adapter now.** Rejected on maturity, and it would not remove the
  need for client resync anyway.
- **Sticky sessions, so clients always return to the same instance.** Rejected:
  it makes deploys and instance loss worse, not better, and it undermines the
  horizontal-scaling demonstration that is the point of the project.

## Consequences

- We own the resync code and must test it: Playwright tests that drop connections
  mid-auction, and a chaos test that kills an instance.
- Broadcast payloads must stay small and carry `seq`, and the per-lot event stream
  must be retained long enough to serve a realistic reconnect window.
- Revisit when the streams adapter reaches 1.0.
