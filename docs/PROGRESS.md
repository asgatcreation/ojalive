# Ojà Live — Progress

Read this and `CLAUDE.md` at the start of every session, then continue from "Next".

Last updated: **10 November 2026**

---

## Current state

**Milestone 1 (design & plan): complete and approved.**
**Milestone 2 (monorepo scaffold): built and verified locally, committed, NOT yet pushed.**

`pnpm verify` is green: Prettier, ESLint, `tsc -b`, **53 tests passing**, and all 6 packages
building. Local Postgres 18.6 and Redis 8.10.3 come up healthy with the settings the bid engine
depends on.

## Done

### Milestone 1 — design

- **Name check.** "OjaLive" / "Ojà Live" is not in use as an auction product, app or trademark.
  Near-misses noted: Ojawa (`ojawa.app`, a Nigerian P2P marketplace that includes live timed
  auctions) and Ojailu. Recommendation: proceed.
- **Stable versions confirmed** from the npm registry, the Node.js release index and Docker Hub.
- **Full design** in [`MILESTONE-1-DESIGN.md`](MILESTONE-1-DESIGN.md): stack, hosting, data model,
  category engine, bid engine with four worked examples, failure handling, and how each service
  target is measured.

### Milestone 2 — scaffold

- **Monorepo**: pnpm 12 workspaces + Turborepo 2.11.10. `apps/web`, `apps/api`, `apps/worker`,
  `packages/shared`, `packages/bid-engine`, `packages/payments`, `load-tests/`, `infra/`, `docs/`.
- **TypeScript 6.0.3**, strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `verbatimModuleSyntax`. Project references across packages; `pnpm typecheck` is `tsc -b`.
- **ESLint 10** flat config with type-aware rules. `no-explicit-any` and all the `no-unsafe-*` rules
  are **errors**, not warnings. `tsconfig.lint.json` covers every file including tests and configs,
  so the type-aware rules apply everywhere.
- **`packages/shared`**: money as integer kobo in `bigint` (`naira`, `koboFromDecimal`,
  `formatNaira`, `applyPercent` in basis points, rounding half up); clocks including a `fakeClock`
  for deterministic closing tests; countdown formatting; client-generated idempotency keys; zod
  environment parsing that fails loudly and never prints the values.
- **`packages/bid-engine`**: the vocabulary (`LotState`, commands, enumerated `RejectionReason`) and
  the increment-band table, with property-based tests. The engine itself is milestone 3.
- **`packages/payments`**: the `PaymentGateway` interface — initiate, verify, verify webhook, refund,
  payout. Webhooks are typed as raw bytes plus headers, so a signature is checked against what was
  actually signed.
- **`apps/api`**: Fastify 5 with helmet, CORS, rate limiting, pino with redaction (a bidder's secret
  maximum can never reach a log), per-request trace ids, `/health`, `/ready` and `/metrics`.
  Prometheus metrics are already shaped around the service targets, including `bid_stream_lag` for
  the durability risk window. Graceful shutdown drains before exiting.
- **`apps/worker`**: process, config, logging, shutdown, and the queue names with BullMQ defaults.
  Queues attach in milestone 4.
- **`apps/web`**: Next.js 16.4.3 App Router, React 19.3.1, Tailwind 4.3.3 with Ojà Live design
  tokens, light and dark, `prefers-reduced-motion` respected, security headers, holding page.
- **CI** (`.github/workflows/ci.yml`): three jobs — verify (format, lint, typecheck, test, build),
  gitleaks secret scanning, and `pnpm audit` failing on high or critical. Node 26.13.0.
- **Renovate**: weekly grouped non-major PRs, majors held for approval, no pre-releases ever.
- **`LICENSE`** (all rights reserved, CarHub style), **`SECURITY.md`**, **`.env.example`** with empty
  placeholders only, **`.gitignore`** that excludes `.env`, **`CLAUDE.md`**, **`README.md`**.
- **ADRs 0001–0006** in [`adr/`](adr).
- **`infra/docker-compose.yml`**: Postgres 18.6 and Redis 8.10.3, verified running —
  `maxmemory-policy noeviction`, `appendfsync everysec`, Lua and Streams working, Postgres on UTC
  with `pg_trgm` available.

## Next (finish milestone 2, then milestone 3)

1. **Browser check of the holding page** — phone and desktop widths, light and dark, no console
   errors. Not yet done; it is the one remaining Definition-of-Done item for milestone 2.
2. **Push to `main`** — blocked on the repo existing (see below). The scaffold is committed locally.
3. **Milestone 3 — `packages/bid-engine`**: the pure engine (proxy bidding, exact-tie breaking by
   earlier maximum, soft close, reserve, Buy Now), a simple reference model, and property tests —
   including the order-independence property from the design doc §7.4: for any shuffling of a set of
   maxima, the final leader and price are identical.

## Decisions waiting for Akanji

| #   | Decision                                                                                                                                                  | Default if he doesn't mind                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | **Create the empty public repo `ojalive`** (Public, no README, no .gitignore, no licence) and send the URL                                                | — blocks the push                                        |
| 2   | Domain and social handles: `ojalive.com` / `ojalive.ng` / `oja.live`, `@ojalive`                                                                          | Proceed with the name; tweak branding if `.com` is taken |
| 3   | Redis: self-run on a Fly machine (recommended) vs Redis Cloud Essentials ~$5/mo                                                                           | Self-run on Fly                                          |
| 4   | Neon free plan's current restore window — decides whether we pay $19/mo for Launch                                                                        | Start on Free, upgrade before the milestone 10 deploy    |
| 5   | **Node 26 LTS locally.** This machine has Node 24.16.0. CI runs 26.13.0 and `engines` allows 24.16+, so nothing is blocked, but local and CI should match | Install Node 26 LTS when convenient                      |

## Open issues / things to revisit

- **TypeScript 6, not 7.** `typescript-eslint@8.72.1` declares `typescript >=4.8.4 <6.1.0`, so TS 7
  would leave the linter unsupported. Revisit when it ships support (ADR-0004).
- **Postgres 19 is at `19rc1`** — revisit after its stable release.
- **`types: ["node"]` is set explicitly** in `tsconfig.base.json`. Automatic `@types` discovery did
  not work reliably through pnpm's symlinked store.
- **Vitest aliases workspace packages to their sources**, not `dist`, so a test can never pass
  against a stale build. Found the hard way.
- **Local ports are 55436 (Postgres) and 56386 (Redis)**, bound to 127.0.0.1 only. The obvious
  choices were already taken by other projects on this machine (`curavia` holds 55432 and 56379).
- **Postgres 18's image wants a single mount at `/var/lib/postgresql`**, not `/var/lib/postgresql/data`.
  With the old convention it refuses to start.
- **Durability window.** Acks happen after the Lua script and stream append, with AOF `everysec`. A
  Redis crash could in principle lose up to ~1 s of acknowledged-but-unpersisted bids. Mitigated by
  a replica, stream-lag alerting, and a feature-flagged strict mode that awaits the Postgres commit
  for high-value lots. Both modes get measured and published (design doc §8.1).
- **`@socket.io/redis-streams-adapter` is pre-1.0** — not used; revisit at 1.0 (ADR-0006).
- **Auth library** (`better-auth` 1.7.15 is the lean) is decided properly in milestone 7.
- **Regulatory.** Holding third-party funds in Nigeria may need CBN approval; the NDPA 2023 applies
  to ID and BVN handling. Documented openly; this build runs on sandbox keys only (design doc §10).
