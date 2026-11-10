# ADR-0002: Deploy everything in London, not Johannesburg

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The bidders are in Nigeria. The obvious choice is the nearest region, which on a
map is Fly.io's Johannesburg (`jnb`).

Three facts, checked rather than assumed:

1. Neon has no African region at all. Its nearest is London (`aws-eu-west-2`).
2. Fly has `jnb`, but no managed Postgres there, and no stated plans to add it.
3. Nigeria's subsea cables run north to Europe. Lagos-to-Johannesburg traffic
   frequently routes _through Europe_, so Johannesburg is not actually closer in
   network terms.

An API in Johannesburg would therefore sit roughly 130–180 ms from its own
database in London, and every bid would pay that round trip.

## Decision

Deploy the web app, two or more API instances, the worker and Redis to Fly.io
London (`lhr`), and the Postgres database to Neon `aws-eu-west-2` (London).
Put Cloudflare in front, so static assets and images are served from its Lagos
edge.

## Why

- Expected Lagos-to-London round trip is ~90–120 ms, against ~130–180 ms for
  Johannesburg once routing is taken into account.
- API to Redis becomes sub-millisecond and API to Postgres a few milliseconds,
  because they are co-located. Co-locating the app with its database matters more
  than the app's distance from the user, because one user request causes several
  database interactions.
- It is the only layout in which p95 under 150 ms for a bid acknowledgement is
  physically achievable from Nigeria.
- Cloudflare's Lagos edge handles the traffic that genuinely benefits from being
  close to the user: images, CSS, JavaScript and cached pages.

## Alternatives considered

- **Fly `jnb` + Neon London.** Rejected: 130–180 ms between the app and its own
  database on every query.
- **Fly `jnb` + unmanaged Postgres on Fly.** Rejected: it breaks the rule that we
  never rely on a host's local disk, and gives up point-in-time restore.
- **Vercel for the web app.** Rejected: its functions default to US regions,
  which would add a transatlantic hop to every server-rendered lot page. Fly in
  `lhr` makes the SSR data fetch a local call, and it is one deploy pipeline
  instead of two.

## Consequences

- Nigerian users pay one ~100 ms round trip to London for interactive actions.
  The real-time design hides this well: optimistic "placing bid…" feedback, and
  broadcasts that carry the server's acceptance timestamp.
- We must measure and publish the real figures rather than these estimates.
- If Neon or Fly later opens an African region with managed Postgres, revisit.
