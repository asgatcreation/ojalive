# ADR-0009: Broadcast deltas by tailing each lot's stream, and emit locally

- **Status:** Accepted
- **Date:** 2026-11-20
- **Amends:** ADR-0006, which assumed the adapter would carry lot deltas

## Context

Several API instances serve the same auction, and a bid accepted on one has to
reach watchers on all of them within the 500 ms target. The obvious Socket.IO
design is: the instance that accepted the bid emits it, and
`@socket.io/redis-adapter` fans that emit out to the other instances.

That design has a hole, and it is not an edge case. **The API is not the only
thing that changes a lot.** The worker closes lots — through a delayed BullMQ
job or the sweeper (design doc §8.5) — and the worker is not a Socket.IO server.
A lot closing is the single most important event a watcher can receive, and
under the obvious design it is the one event with no path to them.

## Decision

Deltas are not emitted by whoever caused them. Every API instance **tails the
Redis Stream** of each lot its own sockets are watching, and emits what it reads
to those sockets. One tailer per lot per instance, reference counted, started by
the first watcher and stopped after the last one leaves.

Because each instance reads the stream for itself, every emit is `io.local`.
Emitting through the adapter as well would deliver one copy per instance.

The adapter is still mounted, and still earns its place: watcher counts come
from `io.in(room).fetchSockets()`, which the adapter makes cluster-wide.

Stream entry ids are the lot's own sequence numbers, `<seq>-0`, rather than
Redis timestamps. The stream is therefore an index on `seq`: a reconnecting
client that says "I last saw 412" is served by `XRANGE (412-0 +`.

## Why

- **One path for every change.** Whoever appends to the stream — an API instance
  accepting a bid, the worker closing a lot — is broadcast automatically. There
  is no second delivery mechanism that could disagree with `seq`, and no event
  type that someone has to remember to also emit.
- **A delta cannot exist without a record.** The entry in the stream is what
  makes a bid real, so a broadcast cannot describe a bid that was not stored.
  Under emit-on-accept, a successful emit and a failed append are two
  independent outcomes.
- **Live and catch-up are the same mechanism.** The deltas a watcher receives
  and the ones a reconnecting client is sent come from the same entries, read
  the same way. Resync is not a parallel implementation that can drift.
- **Cost scales with lots, not watchers.** A thousand watchers of one lot cost
  one blocking Redis connection on that instance, not a thousand.
- **The duplicate risk is tested, not reasoned about.** Changing the delta emit
  from `io.local.to(...)` to `io.to(...)` makes the two-instance test fail with
  the sequence `[1, 2, 3, 1, 2, 3, 4, 5]`, which is what verified that the local
  emit is load-bearing rather than a stylistic choice.

## Alternatives considered

- **Emit on accept, fan out through the adapter.** Rejected on the worker
  problem above. It would need a second channel for worker-originated events —
  the worker publishing to Redis pub/sub and the API re-emitting — which is the
  tailer, built worse.
- **A single global stream for all lots.** Rejected in ADR-0008 for persistence,
  and the same reasoning applies here: hash tags keep one lot's keys in one slot,
  and one hot lot must not delay another's broadcasts.
- **Sticky sessions so a bidder always returns to the instance holding their
  lot.** Rejected in ADR-0006 and still rejected: it makes deploys and instance
  loss worse, and it undermines the horizontal scaling the project is meant to
  demonstrate.

## Consequences

- Each watched lot holds one extra Redis connection per instance. At demo scale
  this is nothing; at thousands of simultaneous lots it would need a shared
  multi-stream `XREAD`, which is a known change rather than a redesign.
- Streams are trimmed to a reconnect window (2,000 events per lot). A client
  that was away longer is sent a snapshot instead of deltas, and both the socket
  and the REST paths make that decision the same way, with a test for each side
  of the boundary.
- The first delta after a watch includes the tailer's connection handshake:
  measured at 21–274 ms depending on how warm the machine is, against 4–23 ms
  for the ones after it. That is published in `timing.int.test.ts` rather than
  averaged away.
- **Browser-level testing moves to milestone 7.** The milestone plan called for
  Playwright across several browsers here, but there is no bidding UI to drive
  yet, so a browser would only prove that `socket.io-client` works inside
  Chromium. The claim — a bid reaches every watcher, in order, once, inside
  500 ms — is a server claim, and it is tested with two real instances and real
  socket clients. The browser pass lands with the interface that needs it.
