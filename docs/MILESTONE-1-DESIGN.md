# OjaLive — Milestone 1: Name check, stack, data model, bid engine design

**Nigeria's live auction house.** Designed and built by Akanji Oluwaseun Gabriel ([@asgatcreation](https://github.com/asgatcreation)).

Status: **awaiting your OK.** Nothing has been scaffolded or installed yet — this document is the decision record for Milestone 1. Date: 2 November 2026.

---

## 1. Name check — "OjaLive" / "Ojà Live"

**Verdict: clear enough to use. I recommend we go ahead.**

What I searched: the name as an auction product, as an app, and as a trademark.

| What I looked for                             | Result                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "OjaLive" / "Oja Live" as an auction platform | **Nothing found.** No product, company or app by that name.                                                                                               |
| "ojalive" as a registered trademark           | **Nothing found** in trademark search results.                                                                                                            |
| Nigerian auction platforms that already exist | eAuction Nigeria, Auction Master Nigeria, Main Auction House, and the Nigeria Customs Service e-Auction portal. All differently named; none is "OjaLive". |

**Two near-misses you should know about, neither of which blocks us:**

1. **Ojawa** (`ojawa.app`) — a Nigerian peer-to-peer commerce platform that _does_ include "live timed auctions" alongside fixed-price deals. This is the closest thing to a competitor _and_ the closest-sounding name. "Ojawa" vs "OjaLive" are clearly different words, but it means we are not the only "Oja…" commerce brand in Nigeria.
2. **Ojailu** (Google Play) — a Nigerian AI-powered marketplace app. Different product, no auctions mentioned.

**Why near-misses are unavoidable:** "Ọjà" is the ordinary Yoruba word for _market_. Nobody owns it, and several Nigerian startups have built names on it. That is a mild downside (less distinctive in search) and a strong upside (instantly meaningful to Nigerians). "OjaLive" is the specific pairing, and that pairing appears to be free.

**One thing I cannot do for you:** domain and social handle availability, and a formal trademark search at the Nigerian Trade Marks Registry, both need live lookups on sites that will want a sign-in or a payment.

**Your action (5 minutes, before we commit to the name):**

1. Go to any registrar (Namecheap, Porkbun, or Whogohost for `.ng`) and search for `ojalive.com`, `ojalive.ng`, `ojalive.com.ng`, `oja.live`.
2. Check `@ojalive` on X, Instagram and TikTok.
3. Tell me what is free and I will adjust branding if `ojalive.com` is taken (`oja.live` is a nice fallback and reads well).

The engineering plan below does not depend on the answer — the repo and all code use `ojalive` regardless.

---

## 2. Versions — what I checked and what I chose

I queried the npm registry, the Node.js release index and Docker Hub **today** rather than trusting memory. Everything below is a current **stable** release. No beta, canary or RC.

### Runtime and database

| Thing      | Chosen                      | Why                                                                                                                                                                                |
| ---------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js    | **26.13.0 LTS ("Lithium")** | Entered Active LTS on 28 October 2026, supported to 30 April 2029. Node 24 dropped to Maintenance on the same date, so starting a new project on 24 would start it already ageing. |
| pnpm       | **12.16.1**                 | Workspaces + strict `node_modules`.                                                                                                                                                |
| Turborepo  | **2.11.10**                 | Task caching across the monorepo.                                                                                                                                                  |
| PostgreSQL | **18.6**                    | Current stable. **Not 19** — Postgres 19 is at `19rc1` on Docker Hub, which is a release candidate and breaks our stability rule.                                                  |
| Redis      | **8.10.3**                  | Current stable. Lua scripting, Streams, pub/sub, `WAIT`, functions.                                                                                                                |

### Language and tooling — one deliberate downgrade

| Thing          | Chosen                         | Why                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript     | **6.0.3**                      | **Not 7.0.2, even though 7.0.2 is the "latest" stable tag.** `typescript-eslint@8.72.1` declares `"typescript": ">=4.8.4 <6.1.0"`. On TypeScript 7 our linter would be running unsupported. Your stability rules say stable _and_ working; a version the lint toolchain refuses is not stable for us. ADR-0004 records this, with a review trigger: we move to TS 7 the week `typescript-eslint` ships support. |
| ESLint         | **10.14.0**                    | Flat config.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Vitest         | **5.0.5**                      | Unit + integration runner.                                                                                                                                                                                                                                                                                                                                                                                      |
| fast-check     | **4.10.2**                     | Property-based tests for the bid engine.                                                                                                                                                                                                                                                                                                                                                                        |
| Playwright     | **1.64.1**                     | Multi-browser end-to-end bidding.                                                                                                                                                                                                                                                                                                                                                                               |
| Testcontainers | **12.2.1**                     | Real Postgres + Redis in tests and CI.                                                                                                                                                                                                                                                                                                                                                                          |
| k6             | **binary via Docker**, not npm | The `k6` npm package is an abandoned 2017 stub (`0.0.0`). The real k6 is a Go binary; we run `grafana/k6` in Docker.                                                                                                                                                                                                                                                                                            |

### API, worker and real-time

| Thing                              | Chosen                      | Why                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fastify                            | **5.12.7**                  | HTTP server.                                                                                                                                                                                                                                   |
| Socket.IO                          | **4.8.4** (server + client) | Real-time transport.                                                                                                                                                                                                                           |
| `@socket.io/redis-adapter`         | **8.3.0**                   | Shares rooms across API instances via pub/sub. Last published March 2024 — that is maturity, not abandonment; it is the officially supported adapter.                                                                                          |
| `@socket.io/redis-streams-adapter` | **0.3.1**                   | **Rejected for now.** It gives at-least-once delivery between servers, but it is pre-1.0. We get the same guarantee more strongly from our own sequence-number resync (§7.6), which works for client _and_ server failures. Noted in ADR-0006. |
| BullMQ                             | **6.5.3**                   | Delayed jobs (lot closing), settlement, notifications, bots.                                                                                                                                                                                   |
| ioredis                            | **6.0.0**                   | Redis client; Lua `EVALSHA`, pipelines, Streams.                                                                                                                                                                                               |
| zod                                | **4.6.7**                   | Validation at every boundary: HTTP, sockets, jobs, webhooks.                                                                                                                                                                                   |
| Drizzle ORM / Kit                  | **0.45.4 / 0.31.11**        | See §3 for why Drizzle over Prisma.                                                                                                                                                                                                            |
| pino                               | **10.4.0**                  | Structured logs with request and bid IDs.                                                                                                                                                                                                      |
| Sentry                             | **11.10.0**                 | Errors in api, worker and web.                                                                                                                                                                                                                 |
| prom-client                        | **15.1.3**                  | Metrics endpoint for the internal dashboard.                                                                                                                                                                                                   |

### Web

| Thing        | Chosen                  | Why                                                                                        |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------ |
| Next.js      | **16.4.3** (App Router) | Server-rendered lot and category pages for SEO. Requires Node >= 20.9, so Node 26 is fine. |
| React        | **19.3.1**              | Peer-matched to Next 16.                                                                   |
| Tailwind CSS | **4.3.3**               | Design tokens as CSS variables.                                                            |
| shadcn CLI   | **4.23.0**              | Components copied into the repo, not a dependency.                                         |
| sharp        | **0.35.5**              | Image pipeline for lot photos.                                                             |

Every one of these gets **pinned exactly** (no `^`), with `pnpm-lock.yaml` committed, plus Renovate for weekly grouped PRs that only merge when CI is green.

---

## 3. Stack — agreements, and the places I would argue

Your proposed stack is sound and I am adopting almost all of it. Three changes and one confirmation:

### 3.1 Fastify + Socket.IO — confirmed, no change

You asked me to argue if I disagreed. I don't. The temptation is uWebSockets.js for raw socket throughput, but it would be the wrong trade here: Socket.IO gives us reconnection with backoff, rooms, the Redis adapter for multi-instance, and a battle-tested client — and **none of our correctness lives in the transport**. Order, validity and time are decided by an atomic Redis script and an append-only Postgres log (§7). The socket layer only _delivers_ decisions. That means we can swap transports later without touching the bid engine, which is exactly the architecture I want to show off.

### 3.2 Drizzle, not Prisma — my recommendation

|                                          | Drizzle                               | Prisma                            |
| ---------------------------------------- | ------------------------------------- | --------------------------------- |
| Partial / expression / GIN indexes       | Plain SQL, easy                       | Awkward, often raw escape hatches |
| JSONB querying (our category attributes) | Native, typed                         | Weak                              |
| Append-only table with no updates        | Natural                               | Fights the ORM model              |
| Runtime weight in the hot bid path       | Thin                                  | Heavier client                    |
| Migration style                          | Generated SQL files you read and edit | More magic                        |

Our schema is deliberately SQL-shaped: an append-only event log, JSONB attributes with GIN indexes, trigram search, partial indexes on `status='open'`. Drizzle lets me write those honestly. **Decision: Drizzle. ADR-0003.**

### 3.3 Web hosting: Fly.io, not Vercel — and the reason is Nigeria

This is the most important infrastructure finding of Milestone 1, so it is in its own section below.

### 3.4 Auth: `better-auth` 1.7.15, not NextAuth

`next-auth` is stuck at 4.24.15 and its successor is not on a stable tag — that fails our stability rule. `better-auth` is on a stable 1.x, has a Drizzle adapter, and supports exactly what we need: email/phone OTP, Google, sessions with a device list, 2FA for staff, and **short-lived tokens we can hand to Socket.IO**. Decided properly in Milestone 7; flagged now so you aren't surprised.

---

## 4. Hosting — and the Nigeria latency finding

### 4.1 The finding

The instinct is "put it close to Nigeria", so: Fly.io's Johannesburg region (`jnb`). I checked, and that is the wrong answer.

1. **Neon has no African region at all.** Its regions are US (Virginia, Ohio, Oregon), Europe (**London `aws-eu-west-2`**, Frankfurt), Asia-Pacific (Singapore, Sydney) and São Paulo. Its Azure regions are deprecated.
2. **Fly has `jnb`, but no managed Postgres there**, and Fly staff have said there are no plans to add it this year.
3. **Lagos → London is a better-connected path than Lagos → Johannesburg.** Nigeria's subsea cables run north to Europe. Traffic from Lagos to Johannesburg very often _routes through Europe anyway_, so "closer on the map" is slower on the wire.

So an API in `jnb` would sit ~130–180 ms from its own database in London, and **every bid pays that twice**. Our p95 target is 150 ms end to end. That configuration cannot hit it.

### 4.2 The recommendation

**Put everything in one place: London.** Web, two API instances, the worker, Redis and Postgres all in `lhr` / `aws-eu-west-2`. Then put Cloudflare in front for CDN, caching and TLS, so static assets and images are served from Cloudflare's **Lagos edge** — which is where the bytes that matter for page speed actually come from.

```
            Nigerian bidder (phone, 4G)
                      |
          Cloudflare  |  (Lagos edge: static assets, images, cached pages)
                      v
   +---------- Fly.io London (lhr) -----------+
   |  web (Next.js 16, SSR)                   |
   |  api-1  api-2   (Fastify + Socket.IO)    |  <- 2+ instances, proves scaling
   |  worker (BullMQ: closing, settlement)    |
   |  redis  (8.10, AOF + volume)             |
   +------------------+-----------------------+
                      v
     Neon Postgres  aws-eu-west-2 (London) — source of truth, PITR
                      +
     Cloudflare R2 (private) — lot media, signed URLs
```

Expected Lagos → London round trip: **~90–120 ms**. Inside London, API → Redis is sub-millisecond and API → Neon is a few milliseconds. That is the only layout where p95 < 150 ms for a bid acknowledgement is physically achievable from Nigeria, and I will measure it rather than claim it.

**Why Fly for web too, instead of Vercel:** the web app renders lot pages from the API and database. On Vercel those functions default to US regions, which would add a transatlantic hop to _every_ server-rendered lot page. On Fly in `lhr` the SSR fetch is a local call. It is also one deploy pipeline instead of two, one region to reason about, and a better story for "I can run production infrastructure." Cloudflare gives us the CDN that Vercel would otherwise be providing. ADR-0002.

### 4.3 Redis host — the honest answer

Our requirements are specific: Lua scripts, pub/sub, Streams, and **BullMQ**. BullMQ's production guide requires `maxmemory-policy noeviction` and recommends AOF persistence.

| Option                                                               | Verdict                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Upstash free**                                                     | **No.** 500K commands/month and 10,000 commands/sec caps. One hot lot with 300 bids/sec plus fan-out would blow the monthly quota in an afternoon, and its eviction model conflicts with BullMQ's `noeviction` requirement. |
| **Redis Cloud free (30 MB)**                                         | **No.** 30 MB, 30 connections, ~100 ops/sec. We need 10,000 sockets.                                                                                                                                                        |
| **Redis Cloud Essentials (~$5/mo, London)**                          | Viable. Managed, configurable policy. Good fallback if you'd rather not operate Redis.                                                                                                                                      |
| **Redis 8.10 on a Fly machine in `lhr`, AOF on a persistent volume** | **Recommended.** Full control of `maxmemory-policy`, `appendfsync`, Lua and Streams. Costs a few dollars. Same host as the API, so sub-millisecond. And load tests run against _our own_ Redis, as you required.            |

The single-Redis risk is real and I am not going to hide it: Redis is a **cache and a serialisation point, never the source of truth**. §8 explains exactly what happens when it dies and why we lose no committed bid.

### 4.4 What this costs you, honestly

| Service                                     | Plan                                                                                                            | Monthly      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| Fly.io                                      | ~5 small machines (web, api×2, worker, redis) + 10 GB volume                                                    | **~$15–25**  |
| Neon                                        | Free to start (small storage, short restore window) → **Launch ~$19** when we want a 7-day point-in-time window | **$0 → $19** |
| Cloudflare                                  | Free plan + R2 (free tier covers demo media)                                                                    | **$0**       |
| Sentry, Brevo, Termii, Paystack/Flutterwave | Free / sandbox tiers                                                                                            | **$0**       |

**~$15–25/month to start.** You asked for Neon with point-in-time restore from day one: we create the project on Neon from day one, and I need you to tell me from the pricing page what restore window the free plan currently gives — if it is only ~24 hours, upgrading to Launch is the one spend I would argue for, because "I never rely on a host's local disk" is part of the story you want to tell.

---

## 5. Service targets, and how each is actually measured

A target without a measurement method is marketing. For each one: what we measure, where, and how it is published.

| #   | Target                                                       | Measured how                                                                                                                                                                                                                                                                                   | Published where                                              |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Bid ack **p95 < 150 ms**, **p99 < 300 ms** (server side)     | Histogram timer around the whole accept path: zod parse → rate-limit → Lua `EVALSHA` → stream append → ack emit. `prom-client` summary, labelled by outcome. Excludes client network time.                                                                                                     | `/metrics`, internal dashboard, README chart from the k6 run |
| 2   | **Zero lost or duplicated accepted bids**                    | After every race and load test, a reconciliation script asserts: the count of client idempotency keys that got ACCEPTED equals the number of rows in `bid_events`; `seq` is a gap-free 1..N run; replaying the log through `packages/bid-engine` reproduces the final price and winner exactly | CI job output + README                                       |
| 3   | **Lots close exactly once**                                  | `lot_closures` has a unique constraint on `lot_id`; the chaos test kills an instance during the closing window and asserts exactly one closure row and exactly one invoice                                                                                                                     | CI + README                                                  |
| 4   | Live update reaches watchers **within 500 ms p95**           | Every broadcast carries the server timestamp of acceptance; k6 socket clients record `receivedAt - acceptedAt` and report the distribution                                                                                                                                                     | k6 summary, README chart                                     |
| 5   | Lot page **LCP < 2.5 s** on a mid-range Android over slow 4G | Lighthouse CI in GitHub Actions with Moto-G-class throttling; plus a hard JavaScript budget that **fails the build** when the lot-page bundle grows                                                                                                                                            | CI badge + README                                            |

Every number in the README will say which commit, which load profile and which hardware produced it.

---

## 6. Data model

Source of truth: Postgres 18. All money is **`bigint` kobo**. All timestamps are `timestamptz` stored in **UTC**; Africa/Lagos is a display concern only.

### 6.1 Identity and trust

```
users              id, display_name, email, phone, password_hash?, is_bot,
                   age_confirmed_at, verification_tier (0..3), status, created_at
user_verifications user_id, kind (phone_otp|id_document|bvn), status, provider_ref,
                   payload_encrypted, reviewed_by, reviewed_at
user_devices       user_id, device_fingerprint, ip_first_seen, ip_last_seen, user_agent
sessions           id, user_id, device_id, expires_at, revoked_at
staff_roles        user_id, role (admin|operations|moderator|finance), granted_by
```

`verification_tier` drives the **bid limit**: tier 0 can browse, tier 1 (phone OTP) can bid to a low cap, tier 2 (ID) much higher, tier 3 (BVN) highest. ID and BVN payloads are encrypted at rest and masked everywhere in logs and admin views.

### 6.2 The category engine

```
categories               id, parent_id, slug, path (materialised), name, icon,
                         seo_title, seo_description, sort, is_active
category_schema_versions id, category_id, version, status (draft|published|retired),
                         fields JSONB, published_at, published_by
category_rules           id, category_id, version, rules JSONB, effective_from
```

### 6.3 Sales and lots

```
sales      id, slug, title, kind (timed|live|sealed), opens_at,
           first_lot_closes_at, stagger_seconds, status, is_demo
lots       id, sale_id, category_id, schema_version_id, seller_id,
           lot_number, title, slug, description,
           lot_type (single|bulk|mixed), quantity,
           attributes JSONB,              -- validated against schema_version
           condition_grade,
           starting_price_kobo, reserve_price_kobo (nullable = no reserve),
           buy_now_price_kobo (nullable),
           opens_at, ends_at, original_ends_at, extension_count,
           status (draft|submitted|approved|scheduled|open|closing|sold|unsold|cancelled),
           rules_snapshot JSONB,          -- frozen copy of category_rules at scheduling
           is_demo, created_at
lot_media     lot_id, kind (image|spin|video), r2_key, width, height,
              credit, licence, sort
lot_documents lot_id, kind (inspection|certificate|customs|title),
              r2_key, uploaded_by, visibility
```

**`rules_snapshot` is the quiet hero.** Increments, deposit %, buyer's premium, VAT and the anti-sniping window are copied onto the lot when it is scheduled. Staff can change a category's rules at 3 pm without changing the rules of a lot that is mid-auction. An auction's terms must not move under the bidders.

### 6.4 Bids — append-only

```
bid_events   id BIGSERIAL,
             lot_id, seq,                   -- UNIQUE (lot_id, seq)
             user_id,
             kind (bid|proxy_raise|retraction|buy_now|close|pause|resume|extend),
             max_amount_kobo,               -- the bidder's secret maximum
             price_after_kobo,              -- visible price after this event
             leader_after_user_id,
             idempotency_key,               -- UNIQUE (lot_id, user_id, idempotency_key)
             accepted_at,                   -- server clock, authoritative
             source (web|api|bot|staff), ip, device_id,
             retracted_by, retracted_reason, retracted_at
lot_state    lot_id PRIMARY KEY, seq, price_kobo, leader_user_id,
             leader_max_kobo, leader_max_set_seq, bid_count,
             ends_at, reserve_met, updated_at   -- a PROJECTION, rebuildable
lot_closures lot_id UNIQUE, closed_at, winning_bid_event_id,
             hammer_price_kobo, outcome (sold|unsold_reserve|no_bids|cancelled)
```

No `UPDATE` ever runs on `bid_events` except to mark a retraction, and a retraction is itself appended as an event. `lot_state` can be deleted entirely and rebuilt by replaying `bid_events` through `packages/bid-engine` — and a test asserts that on every lot after every load test.

`lot_closures.lot_id UNIQUE` is the last line of defence that makes closing exactly-once at the database level.

### 6.5 Money and settlement

```
deposits        id, user_id, sale_id (nullable = standing balance),
                amount_kobo, status, provider, provider_ref, refunded_at
invoices        id, lot_id, user_id, hammer_price_kobo, premium_kobo, vat_kobo,
                deposit_applied_kobo, total_due_kobo, due_at, status,
                second_chance_from_invoice_id
payments        id, invoice_id, amount_kobo, method (card|transfer|ussd),
                provider, provider_ref, status, verified_with_provider_at
webhook_events  id, provider, provider_event_id UNIQUE, signature_valid,
                payload JSONB, processed_at, attempts, dead_lettered_at
ledger_accounts id, kind (bidder_deposit|platform_revenue|vat_payable|
                seller_payable|provider_clearing), owner_id
ledger_entries  id, txn_id, account_id, direction (debit|credit), amount_kobo,
                occurred_at, memo       -- SUM(debit) = SUM(credit) per txn_id, enforced
payouts         id, seller_id, amount_kobo, status, provider_ref, statement_id
```

Double-entry, and a scheduled job that asserts the whole ledger balances. `webhook_events.provider_event_id UNIQUE` makes webhook processing idempotent for free; failures retry and then dead-letter rather than silently vanishing.

### 6.6 Engagement, staff and safety

```
watchlist, saved_searches (+ alert cadence), notifications,
notification_prefs (push|email|sms per event type),
audit_log  (actor_id, action, target_type, target_id, before JSONB,
            after JSONB, reason, ip, at)   -- append-only, every staff action
fraud_flags (user_id|lot_id, kind, score, evidence JSONB, status, reviewed_by)
```

### 6.7 Search

- `tsvector` column on lots (title + description + selected attributes), GIN indexed.
- `pg_trgm` GIN index for fuzzy matching ("toyta corola" should find Toyota Corolla).
- GIN index on `lots.attributes` for JSONB containment, so facets come straight from the category schema.
- Partial index `WHERE status = 'open'` for the hot "ending soon" queries.

---

## 7. The bid engine — the heart of the project

### 7.1 Principles

1. **Server-authoritative.** The server owns time, order and validity. The client displays and nothing more.
2. **One serialisation point per lot.** All state for a lot lives under one Redis hash-tagged key `{lot:<id>}`, mutated only by a Lua script. Redis runs the script atomically, so there is no interleaving and no lock to get wrong. Two bids in the same microsecond are simply two consecutive script runs.
3. **Append-only truth.** Every accepted event is appended with a strictly increasing `seq`. State is a projection. If the projection and the log ever disagree, the log wins.
4. **Pure logic, separately testable.** `packages/bid-engine` is a pure function `(state, command, now) => (newState, events, rejection?)` with no Redis, no clock and no I/O. The Lua script is a faithful port, and a differential test runs thousands of random command sequences through **both** and asserts identical results. That is how I prove the fast path matches the reference model.

### 7.2 The rules, precisely

Let `inc(p)` be the increment for price band `p` (from `rules_snapshot`).

Minimum acceptable maximum:

- no bids yet → `starting_price`
- otherwise → `price + inc(price)`

On a bid of secret maximum `M` from user `U` at server time `t`:

```
if lot not open or t >= ends_at      -> REJECT "Auction closed"
if M < minimum_acceptable            -> REJECT "Bid below next increment"
if M > bid_limit(U)                  -> REJECT "Deposit required" / "Verification required"
if idempotency_key already seen      -> return the ORIGINAL outcome (not a new bid)

if no leader:
    leader = U; leader_max = M; price = starting_price

else if M > leader_max:                          # challenger wins
    price  = min(M, leader_max + inc(leader_max))
    leader = U; leader_max = M

else:                                            # challenger loses, incl. exact tie
    price = min(leader_max, M + inc(M))
    leader unchanged                             # EARLIER maximum wins at equal amounts
    tell U: "Outbid by a higher maximum"

seq += 1
if t > ends_at - soft_close_window:
    ends_at = min(t + extension_seconds, original_ends_at + max_total_extension)
reserve_met = reserve is null or price >= reserve
```

A maximum is **never** revealed — not in events, not in the API, not in the admin UI except to finance staff on a closed lot, and every such view is written to `audit_log`.

### 7.3 Worked example A — proxy bidding, ties and increments

Phone lot. Start **₦50,000**. Reserve **₦58,000** (hidden). Band: under ₦100,000 → increment ₦1,000.

| #   | Who   | Secret max | What the engine does                                                                                                            | Visible price | Leader | Reserve |
| --- | ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------ | ------- |
| 1   | Ada   | ₦60,000    | First bid. Price opens at the starting price, not at her max.                                                                   | **₦50,000**   | Ada    | not met |
| 2   | Bola  | ₦55,000    | 55,000 ≤ 60,000 → Bola loses. `min(60,000, 55,000+1,000)`                                                                       | **₦56,000**   | Ada    | not met |
| 3   | Chidi | ₦60,000    | **Exact tie.** Ada's maximum was set earlier, so Ada keeps the lead. `min(60,000, 60,000+1,000)` capped at the leader's maximum | **₦60,000**   | Ada    | **met** |
| 4   | Dapo  | ₦75,000    | 75,000 > 60,000 → Dapo takes the lead. `min(75,000, 60,000+1,000)`                                                              | **₦61,000**   | Dapo   | met     |

Note what the bidders see: Ada never learns Dapo's maximum. Bola is told "outbid by a higher maximum" — not _how much_ higher. And Ada's ₦60,000 maximum only spent what it had to.

### 7.4 Worked example B — two bids in the same millisecond

Continuing: price ₦61,000, leader Dapo (max ₦75,000). Emeka submits max **₦80,000** and Funke submits max **₦78,000**, and both land in the same millisecond on **different API instances**.

The Lua script serialises them. There are only two possible orders, and here is the point:

**Order 1 — Emeka (seq 5) then Funke (seq 6):**

- Emeka: 80,000 > 75,000 → leader Emeka, price `min(80,000, 75,000+1,000)` = **₦76,000**
- Funke: 78,000 ≤ 80,000 → loses, price `min(80,000, 78,000+1,000)` = **₦79,000**
- Final: **Emeka leads at ₦79,000**

**Order 2 — Funke (seq 5) then Emeka (seq 6):**

- Funke: 78,000 > 75,000 → leader Funke, price `min(78,000, 75,000+1,000)` = **₦76,000**
- Emeka: 80,000 > 78,000 → leader Emeka, price `min(80,000, 78,000+1,000)` = **₦79,000**
- Final: **Emeka leads at ₦79,000**

**Same winner, same price, either way.** The highest maximum wins and pays one increment above the second-highest, regardless of arrival order. This is a property, not a coincidence, and `fast-check` will assert it on thousands of random permutations: _for any shuffling of a set of maxima, the final leader and price are identical._ It is the single clearest proof that the engine is correct under concurrency, and it goes in the README.

What neither bidder can ever do is both "win". There is one script run at a time per lot; `seq` 5 and 6 exist, 5-and-5 cannot.

### 7.5 Worked example C — anti-sniping soft close

Lot scheduled to end **14:00:00**. Rules: window **120 s**, extension **120 s**, cap **+30 minutes**.

| Server time  | Event                 | New end time                                             |
| ------------ | --------------------- | -------------------------------------------------------- |
| 13:57:10     | bid                   | 14:00:00 (outside the window, no change)                 |
| 13:59:58     | snipe attempt         | **14:01:58** (inside the window → `ends_at = t + 120 s`) |
| 14:01:57     | counter-bid           | **14:03:57**                                             |
| 14:03:50     | counter-bid           | **14:05:50**                                             |
| …            | bidding war continues | capped at **14:30:00**, never later                      |
| 14:30:00.001 | bid                   | **REJECTED — "Auction closed"**                          |

Every extension is broadcast immediately with its `seq`, so all watchers see the same new end time within our 500 ms target. Sniping stops working: you cannot win by being last, only by bidding more. And the cap means a lot cannot be held open forever by two stubborn people.

Each lot in a sale is staggered (one closing per minute by default), so extensions on lot 14 do not shove lot 15.

### 7.6 Clock fairness

The client cannot be trusted and does not need to be. On connect, and every 60 seconds after, the client runs an NTP-style exchange: it sends `t0`, the server replies with its own `t1`, and the client takes the median offset over 5 samples. The countdown on screen is then drawn against _server_ time. When a countdown hits zero the client shows "closing…" and **waits for the server's close event** — it never declares a winner itself.

### 7.7 Worked example D — retraction, and why append-only pays off

Staff retract Emeka's ₦80,000 bid (shill suspicion, reason recorded, `audit_log` written).

We do **not** try to patch `lot_state`. We append a `retraction` event, then **replay the lot's entire log through `packages/bid-engine` with that event excluded**:

- Dapo max ₦75,000 and Funke max ₦78,000 remain
- Funke is now highest → price `min(78,000, 75,000+1,000)` = **₦76,000**, leader **Funke**

The new state is written, everyone watching gets the correction with a fresh `seq`, Funke is notified she now leads, Emeka is notified and flagged. Because the log is the truth and the engine is a pure function, a retraction is just "replay without that event" — not a hand-written correction that could be subtly wrong. This is the same mechanism that recovers from a Redis loss (§8.2), which is why it gets tested constantly rather than only in an emergency.

### 7.8 Idempotency

The client generates a UUID per bid attempt and sends it with the bid. The Lua script keeps a per-lot map of recent keys. A retry, a double tap, or a reconnect that replays the bid returns the **original outcome** — never a second bid. The database backs this with `UNIQUE (lot_id, user_id, idempotency_key)`, so even a path that bypassed Redis could not duplicate.

### 7.9 Reserve, Buy Now, no-reserve

- **Reserve** is hidden. The UI shows only "reserve not met" / "reserve met". At close, below reserve → `unsold_reserve`, and the seller gets an option to accept the high bid.
- **Buy Now** is available while `bid_count = 0` (configurable per category: some categories keep it until the price reaches a given % of the Buy Now). The first bid removes it, atomically, inside the same script — so Buy Now and a first bid cannot both succeed.
- **No reserve** lots say so loudly. They sell for whatever the top bid is.

### 7.10 Rejection reasons the bidder actually sees

Typed, enumerated, translated, never a generic error: `Auction closed` · `Bid below next increment — next is ₦62,000` · `Outbid by a higher maximum` · `Deposit required to bid this high` · `Verify your ID to bid above ₦2,000,000` · `Too many bids, slow down` · `Bidding is paused by staff` · `You already lead this lot`.

---

## 8. Failure handling — the honest version

### 8.1 What exactly is guaranteed

When the server sends `ACCEPTED`, that bid has been written atomically into the Redis state **and** appended to the Redis Stream, both inside one Lua script. A worker consumer group then persists it to Postgres, typically within milliseconds.

**The honest gap:** if Redis dies _and_ loses its last AOF window (we run `appendfsync everysec`, so up to ~1 second) _and_ the worker had not yet persisted those events, acknowledged bids in that window could be lost. I am not going to write "no bid is ever lost" and leave it there.

**What we do about it:**

1. AOF `everysec` plus a Redis replica, so a crash of the primary is not a data loss.
2. The persisting worker runs continuously, and a metric tracks **stream lag** (events accepted minus events persisted). An alert fires past a threshold.
3. **Strict mode** (feature-flagged, on for lots above a configurable hammer value): the ack waits for the Postgres commit as well. It costs a few milliseconds of p95 and buys an absolute durability guarantee. We measure both modes and publish both numbers. Choosing per-lot-value is the right engineering answer, and showing the trade-off measured is better than pretending it doesn't exist.

### 8.2 Redis dies entirely

Postgres is the source of truth, so recovery is a rebuild, not a restore:

1. New Redis starts empty. Every lot key is missing.
2. The first bid or page view for a lot finds no state → the API takes a short per-lot lock, reads **all** `bid_events` for the lot, replays them through `packages/bid-engine`, and writes the resulting state back to Redis.
3. Bidding continues with `seq` carrying on from the log's maximum.

This is lazy, so recovery is instant for the lots people are actually looking at, and the sweeper warms the rest. **The chaos test in Milestone 11 does exactly this mid-auction: `docker kill redis`, restart empty, assert the rebuilt price, winner and `seq` match what they were before.**

### 8.3 An API instance dies mid-bid

- Bids already accepted are in Redis and the stream — untouched by the loss of an instance.
- A bid in flight gets no ack; the client retries with **the same idempotency key**, lands on another instance, and either places the bid once or learns it was already placed.
- Sockets reconnect to a surviving instance, send `resync { lotId, fromSeq }`, and receive every event they missed from the stream plus a current snapshot. No gap, no duplicate.
- Shutdown is graceful: stop accepting new connections, finish in-flight scripts, tell clients to reconnect, drain, exit.

### 8.4 Postgres is unavailable

Bidding **continues** — the hot path is Redis. Events queue in the stream; the persisting worker retries with backoff. Settlement and invoicing pause. If the outage outlasts the stream retention we stop accepting bids rather than risk losing them: refusing a bid is recoverable, losing one is not.

### 8.5 Closing exactly once, across restarts and instances

Four layers, so a single failure cannot leave a lot open forever or close it twice:

1. **Delayed BullMQ job** at `ends_at`. On extension, the old job is replaced.
2. **The job re-checks the database.** If `ends_at` has moved later, it reschedules and exits — the database end time, not the job, is the authority.
3. **Atomic compare-and-set** in Lua: `open → closing` only if `now >= ends_at`. A second worker running the same job loses the swap and exits.
4. **`lot_closures.lot_id UNIQUE`.** Even if layers 1–3 all failed, the second insert fails and the duplicate closure cannot exist.

Plus a **sweeper** every 30 seconds: `status = 'open' AND ends_at < now() - 5s` → enqueue the close. That is what catches a job lost to a Redis flush or a worker crash, and it is why the system heals itself rather than waiting for someone to notice.

### 8.6 Payment provider outage

Webhooks are verified, stored in `webhook_events`, then **re-checked against the provider's API** before any money is believed. Processing is idempotent on `provider_event_id`. Failures retry with backoff and then dead-letter with an alert. If a provider is down, invoice deadlines are automatically extended rather than people losing deposits to someone else's downtime.

### 8.7 Emergency pause

Staff can pause one lot, one sale, or everything. Pausing appends a `pause` event, rejects bids with "Bidding is paused by staff", and **extends every affected end time by the pause duration** when bidding resumes, so nobody loses time they were entitled to. The whole thing is audited.

---

## 9. The flexible category engine

The goal: you add "Industrial Sewing Machines" from the admin console on a Tuesday, with its own fields, filters, increments and deposit rules, and no developer touches the code.

### 9.1 A schema is data

A `category_schema_versions.fields` document looks like this:

```json
{
  "groups": [
    { "key": "identity", "label": "Vehicle identity" },
    { "key": "condition", "label": "Condition & history" }
  ],
  "fields": [
    {
      "key": "vin",
      "type": "text",
      "label": "VIN",
      "group": "identity",
      "required": true,
      "validation": { "pattern": "^[A-HJ-NPR-Z0-9]{17}$" },
      "sensitive": false,
      "showOnCard": false,
      "filterable": false
    },
    {
      "key": "mileage",
      "type": "number",
      "unit": "km",
      "label": "Mileage",
      "group": "condition",
      "required": true,
      "validation": { "min": 0, "max": 2000000 },
      "filterable": true,
      "filterStyle": "range",
      "showOnCard": true
    },
    {
      "key": "year",
      "type": "number",
      "label": "Year of manufacture",
      "group": "identity",
      "required": true,
      "validation": { "min": 1960, "max": 2027 },
      "filterable": true,
      "filterStyle": "range",
      "showOnCard": true
    },
    {
      "key": "transmission",
      "type": "select",
      "label": "Transmission",
      "options": ["Automatic", "Manual"],
      "group": "identity",
      "required": true,
      "filterable": true,
      "filterStyle": "chips",
      "showOnCard": true
    },
    {
      "key": "customs_papers",
      "type": "boolean",
      "label": "Customs papers available",
      "group": "condition",
      "required": true,
      "filterable": true
    }
  ]
}
```

Field types: `text`, `longtext`, `number` (with an optional unit: km, GB, cm, kVA, kg, hours), `select`, `multiselect`, `boolean`, `date`. Each field declares whether it is required, how it validates, whether it is a filter and in what style, whether it shows on the lot card, and which group it sits in on the lot page.

### 9.2 One schema, four things generated

From that single document we generate, with no per-category code:

1. **A zod schema** (compiled and cached) that validates `lots.attributes` on submit — the same validator on the client for instant feedback and on the server as the real gate.
2. **The seller's submission form** — grouped, labelled, unit-aware, with the right input for each type.
3. **The category page's filters** — range sliders for numbers, chips for selects, toggles for booleans — translated into JSONB containment and range queries against the GIN index.
4. **The lot page's spec table** and the lot card's summary line.

### 9.3 Versioning, so live lots never break

A schema version is `draft` → `published` → `retired`. Every lot stores the `schema_version_id` it was created under. Changing a category's fields **publishes a new version**; existing lots keep rendering and validating against theirs.

- Adding an optional field: safe, immediate.
- Adding a required field: allowed only on a new version; old lots stay valid, and the admin UI shows how many lots are on each version so you can decide whether to backfill.
- Removing or re-typing a field: the old version is retired, never mutated. This is expand-then-contract, applied to user-defined schemas rather than database columns.

### 9.4 Per-category rules

`category_rules.rules` carries the commercial and auction behaviour, and is **snapshotted onto each lot** when it is scheduled (§6.3):

```json
{
  "increment_bands_kobo": [
    { "upTo": 10000000, "step": 100000 },
    { "upTo": 100000000, "step": 500000 },
    { "upTo": null, "step": 5000000 }
  ],
  "deposit_percent": 10,
  "buyers_premium_percent": 7.5,
  "seller_commission_percent": 10,
  "vat_percent": 7.5,
  "soft_close": {
    "window_seconds": 120,
    "extension_seconds": 120,
    "max_total_extension_seconds": 1800
  },
  "inspection_required": true,
  "required_documents": ["inspection", "customs"],
  "condition_template": "vehicles_v1",
  "delivery_options": ["pickup_lagos", "pickup_abuja", "partner_delivery"],
  "prohibited_checklist": "vehicles_v1"
}
```

### 9.5 Launch categories

Seeded with real, considered schemas: **Vehicles** (cars, SUVs, buses & trucks, motorcycles, tricycles/keke — VIN, mileage, year, customs papers, accident history, structured inspection report, 360 photos, video; reusing what we learned in CarHub) · **Phones & tablets** (brand, model, storage, battery health, IMEI with a format check and stored encrypted, iCloud/Google lock status, accessories, warranty) · **Computers & laptops** (CPU, RAM, storage, GPU, screen, battery cycles, OS licence) · **Electronics** (TVs, audio, cameras, consoles, drones, smart home) · **Home appliances** (fridges, freezers, ACs, washing machines, cookers, inverters & solar kits) · **Generators, power & machinery** (generators by kVA and hours run, industrial & agricultural equipment, tools) · **Art & collectibles** (artist, title, year, medium, dimensions, edition, provenance, certificate of authenticity, condition report; coins, stamps, memorabilia) · **Jewellery & watches** (metal, purity, stones, weight, brand, reference number, box & papers, authenticity certificate) · **Luxury fashion** (bags, sneakers, designer clothing; authenticity checks) · **Furniture & home decor** · **Corporate & government asset disposals** (fleet vehicles, office equipment, bank repossessions, end-of-project assets; bulk and mixed lots) · **Charity auctions** (cause page, donation receipts).

**Real estate and land is Phase 2**, deliberately — it needs title verification and a different legal footing. But the engine is already shaped for it: it is just another category with its own schema, its own required documents and its own rules. Nothing about it needs new code, which is the whole point of building the engine this way.

### 9.6 Condition grading

Templates (New / Like new / Grade A / B / C / For parts) with **photo requirements per grade** — a "Grade C" phone must show the damage it is being graded for before the lot can be approved.

---

## 10. Regulatory honesty

This goes in the README and the terms, not buried:

OjaLive as designed is the **auction house and merchant of record**: it collects bidder deposits, collects the winner's payment, and pays the seller after commission. **Holding third-party funds in Nigeria can require regulatory approval** — depending on structure, that can touch CBN payment-service licensing, and the Nigeria Data Protection Act 2023 governs the ID and BVN handling. A real commercial launch would need legal advice, a licensed partner or an escrow arrangement, and proper NDPA registration.

This build is a **portfolio demonstration running entirely on sandbox payment keys with demo data**. Saying so plainly is more impressive to a serious client than pretending the question doesn't exist.

---

## 11. Milestone plan

Each milestone is a vertical slice that works end to end, and each ends with the full Definition of Done: tests green, CI green, checked in the browser at phone and desktop widths in light and dark with no console errors (or a real run for backend-only work), docs updated, pushed to main, and a plain-English summary to you.

| #     | Milestone                         | What exists at the end                                                                                                                                                                                                                            | Needs from you                                      |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **1** | **Design & plan** (this document) | Decisions recorded, ADRs 0001–0006                                                                                                                                                                                                                | **Your OK**, plus the domain check                  |
| 2     | Monorepo scaffold                 | pnpm + Turborepo, all 7 packages, CLAUDE.md, PROGRESS.md, ADRs, CI (lint, typecheck, test, build, gitleaks, audit, bundle budget), LICENSE, `.env.example`, Docker Compose (Postgres 18 + Redis 8), first push to main                            | Create the empty public repo `ojalive`              |
| 3     | `packages/bid-engine`             | Pure engine + reference model + property tests (order-independence, increments, ties, soft close, reserve)                                                                                                                                        | —                                                   |
| 4     | Atomic acceptance                 | Lua script, differential test against the pure engine, `seq`, idempotency, Postgres outbox, exactly-once closing scheduler, **1,000-bid race test**                                                                                               | —                                                   |
| 5     | Real-time layer                   | Socket.IO + Redis adapter, rooms, delta events, resync, presence, clock sync, two local instances behind a proxy, Playwright multi-browser bidding                                                                                                | —                                                   |
| 6     | Category engine                   | Schema editor, generated forms/filters/pages, per-category rules, launch categories seeded                                                                                                                                                        | —                                                   |
| 7     | Web app                           | Home, categories, search, lot pages, live bidding UI, watchlist, my bids, auth + verification tiers. **Visual direction shown to you before the full build**                                                                                      | Review the designs                                  |
| 8     | Payments & settlement             | naija-pay integration, deposits, invoices, webhook inbox, double-entry ledger, second chance, payouts, notifications                                                                                                                              | Paystack + Flutterwave **test** keys, Brevo, Termii |
| 9     | Seller & staff                    | Consignment flows, CSV bulk upload, staff console, live monitoring, retractions, fraud flags, audit log, emergency pause                                                                                                                          | —                                                   |
| 10    | Demo & deploy                     | Seeded sales, **bot bidders keeping auctions live 24/7**, one-click demo logins, deployed to Fly `lhr` with 2+ API instances, RUNBOOK.md                                                                                                          | Neon, Fly, Cloudflare R2, Sentry sign-ups           |
| 11    | **Prove it**                      | Load (10k sockets), race, chaos (kill an instance, flush Redis) and fake-clock closing tests, with published charts against every target. Security, accessibility (WCAG 2.2 AA) and performance passes. README with screenshots, GIF and diagrams | Final review                                        |
| 12    | Phase 2                           | Live hybrid auctions + auctioneer console + video, sealed-bid tenders, real estate, WhatsApp, native app                                                                                                                                          | Your go-ahead                                       |

### ADRs written in Milestone 2

| ADR  | Decision                                                                               |
| ---- | -------------------------------------------------------------------------------------- |
| 0001 | Redis Lua as the serialisation point, Postgres as the source of truth                  |
| 0002 | Single-region London deployment, with the Lagos latency reasoning                      |
| 0003 | Drizzle over Prisma                                                                    |
| 0004 | TypeScript 6, not 7 (`typescript-eslint` support), with a review trigger               |
| 0005 | Append-only event log with a rebuildable projection                                    |
| 0006 | Socket.IO redis-adapter plus our own sequence resync, over the pre-1.0 streams adapter |

---

## 12. What I need from you to start Milestone 2

1. **"Go"** on this document — or tell me what to change.
2. **The domain check** from §1 (5 minutes; tells us if branding needs a tweak).
3. **Create the repo**: go to [github.com/new](https://github.com/new), name it exactly `ojalive`, make it **Public**, add **no** README, **no** .gitignore and **no** licence, then click _Create repository_. Paste me the URL and I will add the remote and push.
4. **Redis**: confirm you are happy with me running Redis on a Fly machine (recommended, a few dollars, full control) rather than paying for Redis Cloud.
5. **Neon**: when you create the project, tell me what restore window the free plan shows, so we can decide about the $19 Launch plan.

Nothing in 2–5 blocks me from starting Milestone 2 except #3. Say the word and I will scaffold.
