# ADR-0008: One Redis Stream per lot, drained by a consumer group

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

A bid is accepted by a Lua script inside Redis. It then has to reach Postgres,
which is the source of truth. Between those two moments the bid is
acknowledged to the bidder but not yet durable — the honest caveat in design
doc §8.1 — so how it travels matters.

The options for the hop were: write to Postgres inside the request (before the
ack); push onto a BullMQ queue; append to one global Redis Stream; or append to
a stream per lot. The append has to happen **inside the same Lua script** as the
state change, or an accepted bid and its record could come apart.

## Decision

One Redis Stream per lot, `{lot:<id>}:events`, appended to by the same atomic
script that accepts the bid. A worker drains every active lot's stream with a
consumer group (`persist`) and writes rows into `bid_events`.

`UNIQUE (lot_id, seq)` on `bid_events` is what makes the delivery guarantee
usable: a consumer group gives **at least once**, and the unique constraint
turns that into **exactly once** stored. An entry is acknowledged only after its
row is written, so a worker that dies mid-batch simply has its entries
redelivered.

Which lots have live state is tracked in a plain set, `ojalive:lots:active`,
written from TypeScript rather than from inside a script, so that every script
touches only the one hash slot it declares and stays legal if this is ever
sharded across a cluster.

## Why

- **The hash tag.** All of a lot's keys carry `{lot:<id>}`, so the state hash,
  the stream and the idempotency map are in the same Redis slot and one script
  can touch all three. A single global stream could not be written by the same
  script in a cluster, because it would be a different slot. This decision is
  therefore what keeps the atomic accept-and-record possible at all.
- **Resync comes free.** A client that reconnects sends the last `seq` it saw,
  and the lot's own stream is exactly the list of what it missed. A global
  stream would have to be filtered; a BullMQ queue cannot be read historically
  at all.
- **Back-pressure is per lot.** One hot lot's backlog does not delay the
  persistence of a quiet one, and `XPENDING` per lot gives the stream-lag metric
  the alert watches — the exact number of accepted-but-not-durable bids.
- **No Postgres on the bid path.** Bidding continues through a Postgres outage
  (design doc §8.4): entries queue in the stream and the worker retries. Writing
  to Postgres before the ack would have made the database a dependency of every
  bid, trading the p95 target and that resilience for a durability window of
  about a second.

## Alternatives considered

- **Commit to Postgres before acknowledging.** Rejected as the default, kept as
  a feature flag: `FEATURE_STRICT_DURABILITY` with a kobo threshold, so a
  high-value lot can buy an absolute guarantee for a few milliseconds of p95.
  Both modes get measured and both numbers published in milestone 11.
- **BullMQ for bid persistence.** Rejected: a job queue is not a log. It cannot
  be replayed for a reconnecting client, it cannot be appended from inside the
  accepting script, and it would add a second ordering authority next to `seq`.
- **One global stream.** Rejected on the hash-tag argument above, and because
  one lot's traffic would then throttle every other lot's persistence.

## Consequences

- The worker has to discover streams, hence `ojalive:lots:active`, and has to
  remove a lot from that set once it is closed and fully drained.
- Stream retention must outlive a realistic reconnect window; trimming is a
  milestone 5 concern, when resync is actually wired up.
- Every persistence path must stay idempotent. It is tested directly: the same
  stream entries are persisted twice and the second pass must write nothing.
- The durability window is real and measured rather than denied. If stream lag
  grows, the alert fires before anyone loses a bid.
