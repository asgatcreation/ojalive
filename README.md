<div align="center">

# Ojà Live

**Nigeria's live auction house.**

Real-time online auctions for anything valuable — vehicles, phones, electronics, computers,
appliances, art, jewellery and watches, luxury fashion, furniture, generators and machinery,
and corporate or government asset disposals.

[![CI](https://github.com/asgatcreation/ojalive/actions/workflows/ci.yml/badge.svg)](https://github.com/asgatcreation/ojalive/actions/workflows/ci.yml)
[![License: All rights reserved](https://img.shields.io/badge/license-all%20rights%20reserved-red)](LICENSE)
[![Node](https://img.shields.io/badge/node-26%20LTS-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-6.0-blue)](https://www.typescriptlang.org/)

</div>

> **Status: in development.** Milestone 2 of 11. The live demo, demo logins, screenshots and the
> published load, race and chaos results arrive in milestones 10 and 11. Progress is tracked in
> [`docs/PROGRESS.md`](docs/PROGRESS.md).

---

## What this project is proving

Anyone can build a form that saves a bid. The hard part — and the point of this project — is being
**correct under race conditions**:

- thousands of people bidding on one lot in the same second,
- every bid processed in order, exactly once, with a strictly increasing sequence number,
- the right winner every time, and the right price,
- closing times that are fair to everyone, including the person on a slow phone in Lagos,
- and none of it lost when a server dies, a deploy happens, or Redis is restarted empty.

Proven with unit tests, property-based tests, race tests, load tests and chaos tests — with the
results published here rather than claimed.

## The three ideas that make it correct

**1. Redis Lua is the serialisation point; Postgres is the truth.**
All of a lot's live state sits under one hash-tagged Redis key and is mutated only by an atomic Lua
script. Redis runs a script on a single thread, so two bids arriving in the same microsecond become
two _consecutive_ script runs. There is no interleaving, and no lock for us to get wrong. Two bids
can never both win, and the price can never skip an increment.
→ [ADR-0001](docs/adr/0001-redis-lua-serialisation-postgres-truth.md)

**2. The log is the truth; state is a projection.**
Every accepted bid, proxy raise, extension, retraction, pause and close is appended to
`bid_events` with a per-lot sequence number. The live state can be deleted entirely and rebuilt by
replaying that log through a pure function. That is how a staff retraction is applied — replay
without the retracted bid, rather than hand-patching live state — and it is how the system recovers
from losing Redis. The recovery path is therefore exercised constantly, not only in an emergency.
→ [ADR-0005](docs/adr/0005-append-only-log-rebuildable-projection.md)

**3. Lots close exactly once.**
Four independent layers: a delayed job at the end time; the job re-reading the database end time
(the database is the authority, not the job); an atomic compare-and-set in Lua; and a unique
constraint on `lot_closures.lot_id`. Plus a sweeper every 30 seconds that catches anything missed,
so the system heals itself instead of waiting for someone to notice.

### A worked example: two bids in the same millisecond

Price ₦61,000, leader Dapo with a secret maximum of ₦75,000. Emeka submits a maximum of ₦80,000 and
Funke submits ₦78,000 — in the same millisecond, on **different API instances**.

|            | Order 1: Emeka then Funke  | Order 2: Funke then Emeka           |
| ---------- | -------------------------- | ----------------------------------- |
| First bid  | Emeka leads at ₦76,000     | Funke leads at ₦76,000              |
| Second bid | Funke loses; price ₦79,000 | Emeka takes the lead; price ₦79,000 |
| **Final**  | **Emeka at ₦79,000**       | **Emeka at ₦79,000**                |

Same winner, same price, either way. The highest maximum wins and pays one increment above the
second-highest, regardless of arrival order. That is a property, not a coincidence, and it is
asserted over thousands of random permutations with `fast-check`.

More worked examples — proxy bidding with exact ties, the anti-sniping soft close, and a retraction
replayed from the log — are in [the design document](docs/MILESTONE-1-DESIGN.md#7-the-bid-engine--the-heart-of-the-project).

## Features

**Bidding**
Server-authoritative time and ordering · atomic bid acceptance · append-only bid log ·
idempotent bids (a double tap can never create two) · proxy/maximum bidding with private maximums
and earlier-maximum-wins tie breaking · increments by price band, configurable per category ·
hidden reserve with "reserve met / not met" · Buy Now that disappears on the first bid ·
anti-sniping soft close with a cap · staggered closing across a sale · NTP-style client clock sync ·
clear, enumerated rejection reasons.

**Real-time**
Socket.IO rooms per lot, sale, user and staff · Redis adapter so several API instances share rooms ·
small delta events carrying sequence numbers · resync from the last sequence on reconnect, with a
REST fallback · presence counts · broadcast coalescing so slow phones are not flooded.

**Flexible category engine**
Staff define each category's attribute schema in the admin console — field types, validation, which
fields are filters, which show on cards. Forms, filters, lot pages and the zod validators are all
generated from that schema. Schemas are versioned, so changing a category never breaks a lot that is
already live. Per-category rules cover increments, deposits, buyer's premium, VAT, the anti-sniping
window, required documents and condition grading. New categories need no code.

**Settlement**
Deposits · invoices with buyer's premium and VAT · payments via card, bank transfer and USSD ·
webhooks verified and then re-checked against the provider's API · idempotent webhook processing with
a dead-letter queue · second-chance offers to the runner-up · seller payouts · a double-entry ledger
with a scheduled check that it balances.

**Operations**
Staff console with live monitoring · pause, extend or cancel a lot · audited bid retraction ·
shill-bidding and fraud flags · immutable audit log of every staff action · an emergency
"pause all bidding" switch that extends end times when bidding resumes.

## Architecture

```
            Nigerian bidder (phone, 4G)
                      |
          Cloudflare  |  (Lagos edge: static assets, images, cached pages)
                      v
   +---------- Fly.io London (lhr) -----------+
   |  apps/web     Next.js 16, SSR            |
   |  apps/api x2  Fastify + Socket.IO        |   2+ instances, sharing rooms
   |  apps/worker  BullMQ: closing, settle    |     via the Redis adapter
   |  redis 8.10   AOF, noeviction            |
   +------------------+-----------------------+
                      v
     Neon Postgres  aws-eu-west-2 (London) — source of truth, point-in-time restore
                      +
     Cloudflare R2 (private) — lot media via signed URLs
```

**Why London, not Johannesburg?** The instinct is to deploy near the users. But Neon has no African
region, Fly has no managed Postgres in Johannesburg, and Lagos-to-Johannesburg traffic frequently
routes through Europe anyway. An API in Johannesburg would sit 130–180 ms from its own database in
London and pay that on every bid. Co-locating the API with its database, and putting Cloudflare's
Lagos edge in front for the assets, is the only layout that can hit p95 under 150 ms from Nigeria.
→ [ADR-0002](docs/adr/0002-single-region-london.md)

### Workspace

| Path                                         | What it is                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`apps/web`](apps/web)                       | Next.js 16 App Router. Server-rendered lot and category pages for SEO, live bidding UI, installable PWA.               |
| [`apps/api`](apps/api)                       | Fastify 5 + Socket.IO 4. HTTP API and the real-time layer.                                                             |
| [`apps/worker`](apps/worker)                 | BullMQ: lot closing, the stuck-lot sweeper, bid persistence, settlement, notifications, demo bots.                     |
| [`packages/shared`](packages/shared)         | Types, zod schemas, money as integer kobo, clocks, ids. No I/O.                                                        |
| [`packages/bid-engine`](packages/bid-engine) | **Pure** bidding logic — no Redis, no database, no `Date.now()`. The reference model the Lua script is tested against. |
| [`packages/payments`](packages/payments)     | The `PaymentGateway` interface, implemented with [naija-pay](https://github.com/asgatcreation/naija-pay).              |
| [`load-tests/`](load-tests)                  | k6 scripts for the load and race tests.                                                                                |
| [`infra/`](infra)                            | Docker Compose for local Postgres and Redis, and the Redis configuration.                                              |
| [`docs/`](docs)                              | Design document, progress log and architecture decision records.                                                       |

## Service targets

| Target                                                       | How it is measured                                                                                                                                                                              | Status       |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Bid acknowledgement p95 < 150 ms, p99 < 300 ms (server side) | Histogram around the whole accept path, exported to Prometheus                                                                                                                                  | Milestone 11 |
| Zero lost or duplicated accepted bids                        | Reconciliation after every race and load test: accepted idempotency keys equal rows in `bid_events`, sequence numbers are gap-free, and replaying the log reproduces the final price and winner | Milestone 11 |
| Lots close exactly once                                      | Unique constraint plus a chaos test that kills an instance mid-close                                                                                                                            | Milestone 11 |
| Live update reaches watchers within 500 ms p95               | Broadcasts carry the server acceptance timestamp; socket clients report the delta                                                                                                               | Milestone 11 |
| Lot page LCP < 2.5 s on a mid-range Android over slow 4G     | Lighthouse CI with device throttling, plus a JavaScript budget that fails the build                                                                                                             | Milestone 11 |

How each is measured, in detail: [design document §5](docs/MILESTONE-1-DESIGN.md#5-service-targets-and-how-each-is-actually-measured).

## Tech stack

| Layer            | Choice                                                                             | Version                          |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| Runtime          | Node.js LTS                                                                        | 26.13.0                          |
| Language         | TypeScript, strict, no `any`                                                       | 6.0.3                            |
| Monorepo         | pnpm workspaces + Turborepo                                                        | 12.10.1 / 2.11.10                |
| Web              | Next.js App Router, React, Tailwind CSS                                            | 16.4.3 / 19.3.1 / 4.3.3          |
| API              | Fastify, Socket.IO, Redis adapter                                                  | 5.12.7 / 4.8.4 / 8.3.0           |
| Worker           | BullMQ, ioredis                                                                    | 6.5.3 / 6.0.0                    |
| Database         | PostgreSQL (Neon), Drizzle ORM                                                     | 18.6 / 0.45.4                    |
| Cache & hot path | Redis with Lua scripts and Streams                                                 | 8.10.3                           |
| Validation       | zod, at every boundary                                                             | 4.6.7                            |
| Tests            | Vitest, fast-check, Testcontainers, Playwright, k6                                 | 5.0.5 / 4.10.2 / 12.2.1 / 1.64.1 |
| Observability    | Sentry, pino, prom-client                                                          | 11.10.0 / 10.4.0 / 15.1.3        |
| Payments         | [naija-pay](https://github.com/asgatcreation/naija-pay) — Paystack and Flutterwave | sandbox keys only                |

Every version is pinned exactly, with the lockfile committed. Only stable releases: no beta, canary
or release candidates. Two deliberate choices against the newest tag are recorded as ADRs —
[TypeScript 6 rather than 7](docs/adr/0004-typescript-6-not-7.md) (the linter does not support 7
yet) and Postgres 18 rather than 19 (still a release candidate).

## Running it locally

**You need:** Node.js 26 LTS (24.16+ works), pnpm 12, and Docker.

```bash
git clone https://github.com/asgatcreation/ojalive.git
cd ojalive
pnpm install

cp .env.example .env     # then fill it in — see the comments in the file
pnpm docker:up           # starts Postgres 18.6 on :55436 and Redis 8.10 on :56386

pnpm dev                 # web on :3001, API on :4000, worker attached
```

Ports are deliberately non-standard so this never collides with anything else you are running.

```bash
pnpm verify          # format, lint, typecheck, test and build — everything CI runs
pnpm test            # unit and property-based tests
pnpm test:coverage
pnpm typecheck
pnpm lint
```

## Documentation

- **[Design document](docs/MILESTONE-1-DESIGN.md)** — the full engineering design: data model,
  category engine, bid engine with worked examples, failure handling, service targets. Start here.
- **[Progress](docs/PROGRESS.md)** — what is done, what is next, open issues.
- **[Architecture decision records](docs/adr)** — why each significant choice was made, and what was
  rejected.
- **[Security policy](SECURITY.md)** — how to report a vulnerability, and how sensitive data is
  handled.

## Honest caveats

Two things this README will not pretend about.

**Durability.** A bid is acknowledged after the atomic Lua script has written it and appended it to
a Redis Stream, with AOF `appendfsync everysec`. If Redis died _and_ lost its last second _and_ the
persisting worker had not caught up, acknowledged bids in that window could be lost. Mitigations: a
replica, a stream-lag metric with alerting, and a feature-flagged strict mode that waits for the
Postgres commit on high-value lots. Both modes are measured and both numbers published.
→ [design document §8.1](docs/MILESTONE-1-DESIGN.md#8-failure-handling--the-honest-version)

**Regulation.** As designed, Ojà Live is the auction house and merchant of record: it holds bidder
deposits and pays sellers. Holding third-party funds in Nigeria can require regulatory approval, and
the Nigeria Data Protection Act 2023 governs the ID and BVN handling. A real commercial launch would
need legal advice, a licensed partner or an escrow arrangement, and NDPA registration. **This build
is a portfolio demonstration running entirely on sandbox payment keys with demo data.**

## Licence

**All rights reserved.** This code is published publicly so that clients, employers and reviewers
can read it and try the demo. Publishing it does not grant a licence to use it. See
[LICENSE](LICENSE).

---

<div align="center">

**Designed and built by [Akanji Oluwaseun Gabriel](https://github.com/asgatcreation) (@asgatcreation).**

Also by me: [CarHub](https://github.com/asgatcreation/carhub) ·
[naija-pay](https://github.com/asgatcreation/naija-pay) · naija-data

</div>
