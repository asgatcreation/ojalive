# Ojà Live — Progress

Read this and `CLAUDE.md` at the start of every session, then continue from "Next".

Last updated: **17 November 2026**

---

## Current state

**Milestone 1 (design & plan): complete and approved.**
**Milestone 2 (monorepo scaffold): complete. Pushed to `main` and CI is green.**
**Milestone 3 (the pure bid engine): complete. 96 tests, including the order-independence property.**

`pnpm verify` is green: Prettier, ESLint, `tsc -b`, **96 tests passing**, and all 6 packages
building. Local Postgres 18.6 and Redis 8.10.3 come up healthy with the settings the bid engine
depends on. The holding page was checked in the browser at phone and desktop widths in light and
dark. **GitHub Actions run #7 on commit `d6cafdd` passed all three jobs** (verify, secret scanning,
dependency audit) in 48 s. Repository: https://github.com/asgatcreation/ojalive

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

### Browser verification (11 November 2026)

- **Desktop, light** — renders correctly; green accent, readable hierarchy.
- **Desktop, dark** — renders correctly; gold accent on the deep green ground.
- **Phone, 375 x 812, dark** — no horizontal overflow (`scrollWidth === clientWidth === 375`).
- `prefers-color-scheme` is honoured: `color-scheme` resolves to `dark` under dark emulation.
- Money renders server-side from the `bigint` kobo value: **₦8,200,000**.
- Completed milestones carry a screen-reader-only "(done)", so the status is not colour-only.

### CI (11 November 2026)

Runs #1–#4 failed, each for a real reason now fixed and recorded below. Run **#5 is green**.

| Run    | Failed on          | Cause                                                                                                                                                | Fix                                                                             |
| ------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| #1, #2 | install, both jobs | pnpm 12 refuses to install while a dependency's install scripts are undeclared                                                                       | `allowBuilds:` in `pnpm-workspace.yaml`                                         |
| #3, #4 | lint               | CI lints **before** it builds, so `@ojalive/*` resolved to `dist` types that did not exist yet, and every `no-unsafe-*` rule fired across `apps/api` | `paths` in `tsconfig.lint.json` mapping the workspace packages to their sources |

The lesson for future milestones: **a clean checkout is not the same as this machine.** Reproduce a
CI failure locally by deleting every `dist`, `.turbo` and `.next` directory first, then running
`pnpm verify`.

### Milestone 3 — the pure bid engine (17 November 2026)

- **`apply(state, command, now)` is the whole engine** — `packages/bid-engine/src/engine.ts`. No
  clock, no Redis, no `await`. Proxy bidding, exact-tie breaking by the earlier maximum, the
  anti-sniping soft close, hidden reserves, Buy Now, and closing with an outcome (`sold`,
  `unsold_no_bids`, `unsold_reserve_not_met`).
- **`replay(state, log)`** rebuilds a lot from its log. Worked example D from the design doc is a
  test: drop Emeka's retracted bid, replay, and Funke leads at ₦76,000 — no hand-written correction.
- **Events are typed and `seq`-stamped.** One accepted command advances `seq` exactly once and every
  event it produces carries that `seq`, which is what a reconnecting client resyncs against.
  `bid_placed` is the only event that carries a secret maximum; it is persisted, never broadcast.
- **A reference model** (`reference.ts`) computes the winner and price from the _set_ of accepted
  maximums using the economic rule of a proxy auction — no state machine. Two independent
  formulations that must agree.
- **Property tests** (`properties.test.ts`): order independence over 2,000 random arrival orders;
  engine versus reference over 3,000 random sequences including repeats, tight spacing and bids
  below the starting price; and per-command invariants — the price never falls, never exceeds the
  leader's maximum, the leader always holds the highest accepted maximum, a refused bid changes
  nothing at all.
- **Fake-clock soft-close tests** (`soft-close.test.ts`) reproduce design doc §7.5 to the
  millisecond: outside the window, inside the window, the window edge, successive extensions, the
  30-minute cap, bids after the capped end, and closing at the extended end rather than the original.
- **ADR-0007** records what the order-independence claim actually says, why ties go to the earlier
  maximum, and why the leader may not raise their own maximum.
- **The tests were themselves tested.** Three deliberate mutations of the engine — a losing bid not
  raising the price, an exact tie handed to the later maximum, and the soft close extending from the
  end time instead of the bid time — were each caught (6, 4 and 2 failures). A suite that passes
  first time is worth that check.

## Next (milestone 4 — atomic bid acceptance on Redis and Postgres)

1. **The Lua script**: a faithful port of `apply`, all state under one hash-tagged key `{lot:<id>}`,
   appending to a Redis Stream in the same atomic run.
2. **A differential test**: thousands of random command sequences through both the TypeScript engine
   and the real Lua script in Redis, asserting identical state. `test-support.ts` and `reference.ts`
   exist for this.
3. **Drizzle schema and migrations**: `bid_events` append-only, `lot_state` as a projection,
   `lot_closures` with the unique constraint, `UNIQUE (lot_id, user_id, idempotency_key)`.
4. **Idempotency** in Lua plus the database constraint — a retry returns the original outcome.
5. **Exactly-once closing**: the delayed BullMQ job, the job re-reading the database end time, the
   compare-and-set in Lua, the unique constraint, and the 30-second sweeper.
6. **Race tests** against real Redis and Postgres: N concurrent bidders on one lot, asserting one
   winner, no lost or duplicated bids, and exactly one closure.

## Decisions waiting for Akanji

| #   | Decision                                                                                                                                                  | Default if he doesn't mind                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Domain and social handles: `ojalive.com` / `ojalive.ng` / `oja.live`, `@ojalive`                                                                          | Proceed with the name; tweak branding if `.com` is taken |
| 2   | Redis: self-run on a Fly machine (recommended) vs Redis Cloud Essentials ~$5/mo                                                                           | Self-run on Fly                                          |
| 3   | Neon free plan's current restore window — decides whether we pay $19/mo for Launch                                                                        | Start on Free, upgrade before the milestone 10 deploy    |
| 4   | **Node 26 LTS locally.** This machine has Node 24.16.0. CI runs 26.13.0 and `engines` allows 24.16+, so nothing is blocked, but local and CI should match | Install Node 26 LTS when convenient                      |

## Open issues / things to revisit

- **Order independence is not universal, and the claim now says so.** It holds for maximums more
  than one increment apart and at least two increments above the starting price. Inside one
  increment — and for a maximum equal to the starting price, which is only acceptable as the very
  first bid — arrival order can decide whether a bid is accepted at all, so the price can differ.
  Found while writing the property test, not after. Arbitrary sequences are covered by the reference
  model instead. ADR-0007, and the claim carries its condition in the README.
- **The leader cannot raise their own maximum** (`already_leading`). A raise cannot move the price,
  so it would only buy an invisible advantage in a later tie. Revisit if real bidders ask for it —
  ADR-0007 records the consequence to handle if we do.
- **Idempotency is not in the pure engine.** It has no memory of previous keys by design; the Lua
  script and `UNIQUE (lot_id, user_id, idempotency_key)` own it in milestone 4. What the engine
  guarantees is determinism, which is what makes a replayed retry safe.

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
- **pnpm 12 refuses to install while a dependency's install scripts are undeclared.** This failed
  both CI jobs at the install step on the first two runs. Allowed scripts are declared in
  `pnpm-workspace.yaml` under **`allowBuilds:`** — note the key, not `onlyBuiltDependencies`, which
  is the pnpm 10 name and is silently ignored. Use `pnpm approve-builds <pkg> --yes` to add one; it
  writes the file itself.
- **`apps/web/next-env.d.ts` is no longer tracked.** Next generates it, and writes a different
  version for `next dev` than for `next build`, so tracking it meant a permanently dirty tree.
- **Two console errors in `next dev`.** `Uncaught TypeError: Failed to execute 'getComputedStyle'`,
  thrown from an eval'd `<anonymous>` script. `getComputedStyle` does not appear anywhere in our
  source — only inside Next's own vendor chunks — so this is development tooling, not our code.
  Confirm against a production build (`next build && next start`) during the milestone 7 browser
  pass before calling the page console-clean.
- **`pnpm/action-setup@v4` and `gitleaks/gitleaks-action@v2` still target Node 20**, so GitHub
  prints a deprecation warning on every run. Warnings only, not failures. Revisit when those
  actions publish Node 24 releases.
- **Regulatory.** Holding third-party funds in Nigeria may need CBN approval; the NDPA 2023 applies
  to ID and BVN handling. Documented openly; this build runs on sandbox keys only (design doc §10).
