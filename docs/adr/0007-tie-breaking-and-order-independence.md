# ADR-0007: Tie-breaking by arrival order, and the exact scope of order independence

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

The headline correctness claim of this project is that the bid engine is
order-independent: for any arrival order of a set of secret maximums, the same
bidder wins at the same price (design doc §7.4). Milestone 3 implemented the
engine and asserted that claim with `fast-check`, which forced the claim to be
made exact. It is not true for every set of maximums.

Two cases break it, and both come from the same rule — a bid must be at least
one increment above the current price:

1. **An exact tie.** Two bidders choose the same maximum to the kobo. One of
   them has to lead.
2. **Maximums inside one increment of each other.** With ₦1,000 increments, a
   ₦61,000 maximum is acceptable against a price of ₦60,000 but not against a
   price of ₦61,000. So whether it is recorded at all can depend on when it
   arrives. The same applies to a maximum equal to the starting price: it is
   acceptable as the very first bid and never afterwards.

A related question arose while implementing: may the current leader bid again to
raise their own maximum?

## Decision

1. **At an exact tie, the earlier maximum keeps the lead.** `lot_state` stores
   `leader_max_set_seq`, the sequence number at which the leading maximum was
   set, and the engine compares challengers with `>`, never `>=`.
2. **The order-independence property is asserted over maximums that are pairwise
   more than one increment apart and at least two increments above the starting
   price.** That condition is stated in the property test, in the README and
   here, rather than being quietly encoded in a generator.
3. **For arbitrary maximums — tight spacing, repeats, amounts below the starting
   price — correctness is established differently:** against an independent
   reference model (`packages/bid-engine/src/reference.ts`) that computes the
   winner and price from the set of accepted maximums using the economic rule of
   a proxy auction, with no state machine. The engine and the model must agree on
   price, leader, bid count and which bids were refused.
4. **The leader may not bid again on their own lot.** They are told "you already
   lead this lot" (`already_leading`).

## Why

- Arrival order is the only fair arbiter available. The server's sequence number
  is monotonic, assigned inside the one atomic script per lot, and recorded in
  the append-only log — so "who was first" is a fact we can show a bidder or an
  auditor, not an opinion. Any other tie-break (random, by account age, by
  deposit size) would be less explicable and no fairer.
- Pretending the property is universal would be the worse kind of dishonesty in
  a project whose point is provable correctness. Stating the condition costs two
  sentences and makes the claim checkable.
- Rejecting a self-raise avoids a real asymmetry. A raise cannot change the
  price, because nobody has challenged the leader; it would only give the leader
  a higher hidden ceiling and, under rule 1, a maximum timestamped earlier than
  any later tie. The visible auction would not change, so the bidder gains
  nothing they can see and something they cannot — exactly the sort of
  invisible advantage an auction house should not offer.

## Alternatives considered

- **Split a tie in favour of the later maximum** (so the most recent action
  wins). Rejected: it rewards sniping, which the soft close exists to defeat.
- **Accept any bid above the current price, rather than above price + increment**,
  which would make the property universal. Rejected: it allows ₦1 ladder bidding
  that makes a hot lot unreadable and generates enormous event traffic — the
  increment table exists to prevent exactly that.
- **Allow the leader to raise their maximum, keeping the original
  `leader_max_set_seq`.** Rejected for now as described above; if sellers or
  bidders ask for it, it returns as an explicit product decision with the
  tie-break consequence written down.

## Consequences

- `leader_max_set_seq` must survive every projection rebuild and every replay,
  or ties would be re-decided differently after a recovery. The replay tests
  cover it.
- The Lua script in milestone 4 must use `>` and must carry
  `leader_max_set_seq`, and the differential test against this engine will catch
  it if it does not.
- The README's headline claim carries its condition wherever it is repeated,
  including in the milestone 11 published results.
