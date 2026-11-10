# ADR-0005: Append-only bid log with a rebuildable projection

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

A bid is a financial commitment. We need to be able to answer, months later and
with evidence, "why did this person win this lot at this price?" We also need to
handle staff retracting a bid (shill bidding, error), and to recover a lot's
state if Redis is lost.

## Decision

`bid_events` is append-only: every bid, proxy raise, retraction, extension,
pause, resume and close is a row with a strictly increasing per-lot `seq`.
`lot_state` is a **projection** that can be deleted and rebuilt at any time by
replaying the log through the pure function in `packages/bid-engine`.

A retraction is itself an appended event. Applying it means replaying the lot's
log with the retracted bid excluded and writing the resulting state — not
hand-patching the current state.

## Why

- A retraction computed by replay is correct by construction. A retraction
  computed by patching live state is a bespoke piece of arithmetic that nobody
  will test as thoroughly, and it is exactly the kind of code that produces the
  wrong winner.
- Redis recovery becomes the same operation as a retraction, so the recovery path
  is exercised constantly instead of only in an emergency.
- It gives a complete audit trail with no extra bookkeeping.
- It lets us assert, after every load test, that replaying the log reproduces the
  final price and winner exactly — which is how we prove "zero lost or duplicated
  bids" rather than merely asserting it.

## Alternatives considered

- **Mutable `lots.current_price` with a separate bid history table.** Simpler,
  but the history is then decorative: it is not what the state is derived from,
  so the two can drift and nothing notices.
- **Full event sourcing across the whole domain.** Rejected as overkill. Bidding
  is event-sourced because its ordering and auditability are the product.
  Categories, users and invoices are ordinary mutable tables.

## Consequences

- `bid_events` grows without bound and will need partitioning by sale or by month
  once the demo has been running for a while.
- Replay must stay fast. The pure engine is linear in the lot's events, and lots
  have hundreds of bids rather than millions — acceptable, and measured.
- Nothing may ever `UPDATE` a bid event except to stamp a retraction, and that
  rule needs a test guarding it.
