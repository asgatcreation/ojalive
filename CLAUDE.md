# CLAUDE.md — Ojà Live

**Read this file and `docs/PROGRESS.md` first, at the start of every session, then
continue from "Next" in PROGRESS.md.**

This project spans many sessions. These notes are the handover.

---

## Working rules (non-negotiable)

- **No AI attribution, anywhere.** Never add `Co-Authored-By: Claude`,
  "Generated with Claude Code", or any similar line to a commit message, a PR
  description, a code comment or a document. Commits are authored by Akanji
  Oluwaseun Gabriel only. Commit messages are plain and clear.
- **Never commit or print secrets.** Only sandbox/test payment keys exist in this
  project. Secrets live in `.env` (gitignored); `.env.example` holds empty
  placeholders. Do not read the contents of `.env` back to the user.
- **Windows 11.** The user sometimes runs their own dev servers on ports 8000 and
  3000 — never kill a process you did not start. The web app here uses port
  **3001** and the API **4000** for exactly that reason. Use the app's preview
  tools for your own servers.
- **Ask before deleting anything substantial or doing anything irreversible.**
- **Accounts and keys** (GitHub, Neon, Redis, Fly, Cloudflare, Paystack,
  Flutterwave, Brevo, Termii, Sentry): give exact, step-by-step instructions for
  what to click and what to paste where. The user does every sign-up and enters
  every secret themselves.
- **Do not sign in to the live site with tools.** Verify the live site
  anonymously; the user tests signed-in flows.
- **Explain in simple, clear English.** Show a plan, wait for approval, then build
  in vertical slices.
- **`gh` is not installed.** The user creates repositories at github.com/new; you
  add the remote and push to `main`.

## Stability rules

- Stable production releases only. No beta, canary, RC or experimental features.
- Exact pinned versions (`save-exact=true` in `.npmrc`), `pnpm-lock.yaml`
  committed, Renovate for weekly grouped updates that only land when CI is green.
- TypeScript strict mode everywhere. **No `any`** — ESLint enforces it as an
  error, along with the `no-unsafe-*` rules.
- Validate every input at every boundary (HTTP, sockets, jobs, webhooks) with
  zod. The process environment is a boundary too.
- Money is **integer kobo in `bigint`**, never a float. Use
  `@ojalive/shared`'s `money.ts`.
- Time is **UTC in storage**, **Africa/Lagos for display**. The server clock
  decides when a lot closes.
- Migrations are reviewed, reversible where possible, expand-then-contract on
  live data. Seed and reset scripts never touch real users.
- Feature flags for anything unfinished, so `main` is always deployable.

## Definition of done (every milestone)

1. All tests pass locally and CI is green; new code has tests.
2. Checked in the browser preview at phone and desktop widths, in light and dark,
   with no console errors — or a real run for backend-only work.
3. Docs updated: README section, `docs/PROGRESS.md`, and an ADR if a decision was
   made.
4. Committed and pushed to `main`.
5. A short plain-English summary to the user: what was done, how it was verified,
   and anything they need to do.

---

## Architecture in one page

```
            Nigerian bidder (phone, 4G)
                      |
          Cloudflare  |  (Lagos edge: static assets, images, cached pages)
                      v
   +---------- Fly.io London (lhr) -----------+
   |  apps/web     Next.js 16, SSR            |
   |  apps/api x2  Fastify + Socket.IO        |
   |  apps/worker  BullMQ: closing, settle    |
   |  redis 8.10   AOF, noeviction            |
   +------------------+-----------------------+
                      v
     Neon Postgres  aws-eu-west-2 (London) — source of truth
                      +
     Cloudflare R2 (private) — lot media via signed URLs
```

**Why London and not Johannesburg:** Neon has no African region, Fly has no
managed Postgres in `jnb`, and Lagos-to-Johannesburg traffic often routes through
Europe anyway. Co-locating the API with its database beats being geographically
nearer the user. See `docs/adr/0002-single-region-london.md`.

### Workspace layout

| Path                  | What it is                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`            | Next.js 16 App Router. Server-rendered lot and category pages for SEO, Socket.IO client for live bidding, installable PWA. Port **3001**. |
| `apps/api`            | Fastify 5 + Socket.IO 4. HTTP API and the real-time layer. Port **4000**.                                                                 |
| `apps/worker`         | BullMQ: lot closing, the stuck-lot sweeper, bid persistence, settlement, notifications, demo bots.                                        |
| `packages/shared`     | Types, zod schemas, money (integer kobo), time and clocks, ids. No I/O.                                                                   |
| `packages/bid-engine` | **Pure** bidding logic. No Redis, no database, no `Date.now()`. The reference model the Lua script is tested against.                     |
| `packages/payments`   | The `PaymentGateway` interface. Implemented with naija-pay in milestone 8.                                                                |
| `load-tests/`         | k6 scripts (run as a Docker container, not an npm package).                                                                               |
| `infra/`              | Docker Compose for local Postgres + Redis, and the Redis config.                                                                          |
| `docs/`               | Design doc, PROGRESS, ADRs, RUNBOOK (milestone 10).                                                                                       |

### The three ideas that matter

1. **Redis Lua is the serialisation point; Postgres is the truth.** All of a lot's
   live state sits under one hash-tagged key `{lot:<id>}` and is mutated only by
   an atomic Lua script, so concurrent bids become consecutive script runs. The
   same script appends the event to a Redis Stream; a worker persists it to the
   append-only `bid_events` table. ADR-0001.
2. **The log is the truth; state is a projection.** `lot_state` can be deleted and
   rebuilt by replaying `bid_events` through `packages/bid-engine`. That is how
   retractions work, and how we recover from losing Redis. ADR-0005.
3. **Closing happens exactly once**, through four independent layers: a delayed
   BullMQ job, the job re-reading the database end time, an atomic
   compare-and-set in Lua, and a unique constraint on `lot_closures.lot_id`. Plus
   a sweeper every 30 seconds for anything missed. Design doc §8.5.

### Service targets

p95 bid acknowledgement under 150 ms and p99 under 300 ms (server side); zero
lost or duplicated accepted bids; lots close exactly once; live updates reach
watchers within 500 ms at p95; lot-page LCP under 2.5 s on a mid-range Android.
How each is measured: design doc §5.

---

## Commands

```bash
pnpm install                 # install everything (pnpm 12, Node 24.16+ / 26 LTS preferred)

pnpm docker:up               # start local Postgres 18.6 + Redis 8.10
pnpm docker:down             # stop them, keep the data
pnpm docker:reset            # stop them and DELETE the volumes

pnpm dev                     # run web + api + worker in watch mode
pnpm --filter @ojalive/api dev

pnpm verify                  # format:check + lint + typecheck + test + build — run before every commit
pnpm lint
pnpm typecheck               # tsc -b across the project references
pnpm test                    # vitest, unit tests
pnpm test:coverage
pnpm build                   # turbo run build
pnpm format                  # prettier --write .
```

Local ports are deliberately non-standard so nothing collides with the user's own
servers: **Postgres 55436**, **Redis 56386**, **web 3001**, **API 4000**.

## Conventions

- ESM throughout (`"type": "module"`). Relative imports inside a package carry the
  `.js` extension, because `moduleResolution` is `NodeNext`.
- `import type` for type-only imports (ESLint enforces it).
- Workspace packages are imported as `@ojalive/shared`, `@ojalive/bid-engine`,
  `@ojalive/payments`.
- Tests sit next to the code as `*.test.ts`. Integration tests that need real
  Postgres or Redis are named `*.int.test.ts` and are excluded from `pnpm test`.
- Logs are structured (pino), carry a request/bid id, and **redact** a bidder's
  maximum, tokens, BVN and IMEI. A bidder's secret maximum must never reach a log,
  an API response or a broadcast.
- Rejection reasons are an enumerated union, never free text — the bidder reads
  them and we count them as a metric.
- Commit messages: plain imperative, no scope prefixes required, no AI attribution.

## Deliberate choices worth not re-litigating

- **TypeScript 6.0.3, not 7.0.2** — `typescript-eslint` does not support TS 7 yet
  (`<6.1.0`). ADR-0004. Revisit when it does.
- **Postgres 18.6, not 19** — 19 is still a release candidate.
- **Drizzle, not Prisma** — ADR-0003.
- **`@socket.io/redis-adapter`, not the pre-1.0 streams adapter**, with our own
  sequence resync — ADR-0006.
- **Fly for the web app, not Vercel** — Vercel's functions default to US regions,
  which would add a transatlantic hop to every SSR lot page. ADR-0002.
- **Redis on our own Fly machine, not Upstash** — BullMQ requires
  `maxmemory-policy noeviction`, and Upstash's free tier caps commands far below
  what one hot lot needs. Design doc §4.3.

## Honest caveats to keep in the docs

- Acks happen after the Lua script and stream append, with AOF `everysec`. A Redis
  crash could in principle lose up to ~1 second of acknowledged-but-unpersisted
  bids. Mitigated by a replica, a stream-lag metric and a feature-flagged strict
  mode that waits for the Postgres commit on high-value lots. Both modes get
  measured and published. Design doc §8.1.
- Holding third-party funds in Nigeria may require regulatory approval, and the
  NDPA 2023 governs the ID and BVN handling. This build runs on sandbox keys with
  demo data only, and says so publicly. Design doc §10.
