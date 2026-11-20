# Ojà Live — Progress

Read this and `CLAUDE.md` at the start of every session, then continue from "Next".

Last updated: **20 November 2026**

---

## Current state

**Milestone 1 (design & plan): complete and approved.**
**Milestone 2 (monorepo scaffold): complete. Pushed to `main` and CI is green.**
**Milestone 3 (the pure bid engine): complete. 96 tests, including the order-independence property.**
**Milestone 4 (atomic bid acceptance on Redis and Postgres): complete. 125 unit tests plus 23
integration tests against real Postgres, Redis and Lua.**

`pnpm verify` is green: Prettier, ESLint, `tsc -b`, **134 unit tests passing**, and all 8 packages
building. `pnpm test:int` is green too: **42 integration tests** covering 300 simultaneous bids on
one lot, idempotency, exactly-once closing, recovery from losing Redis entirely, and delta delivery
across two API instances. Local Postgres 18.6 and Redis 8.10.3 come up healthy with the settings the bid engine
depends on. The holding page was checked in the browser at phone and desktop widths in light and
dark. **GitHub Actions run #9 on commit `6d0420c` passed all four jobs**: verify (43 s), integration
tests against real Postgres, Redis and Lua (47 s), secret scanning (16 s) and dependency audit
(38 s). Repository: https://github.com/asgatcreation/ojalive

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

### Milestone 4 — atomic bid acceptance (19 November 2026)

- **`packages/db`**: Drizzle schema for the bidding slice — `users`, `sales`, `lots`, the
  append-only `bid_events`, the rebuildable `lot_state` projection, and `lot_closures`. Money is
  `bigint` kobo throughout; timestamps are `timestamptz` in UTC. Migration `0000_bidding_slice`.
- **`packages/live`**: the Lua scripts (`src/lua/place-bid.lua`, `buy-now.lua`, `close-lot.lua`,
  `seed-state.lua`, with a shared `prelude.lua`), loaded as `EVALSHA` with an `EVAL` fallback; the
  Redis read path; the per-lot event stream; and the four-layer close.
- **The differential test** is the centrepiece: random command sequences run through both the Lua
  script and the pure engine, with state compared field by field after every command. The Lua
  script is what decides real bids, so "it matches the reference model" has to be a test, not a
  claim.
- **300 simultaneous bids on one lot**: sequence numbers come out 1..n with no gaps and no repeats,
  the price never falls, one winner, and the order Redis chose replays through the pure engine to
  exactly the state Redis holds.
- **Idempotency**: twenty copies of one bid arriving at once produce one accepted bid and nineteen
  replays of the original outcome. The database backstop is tested separately by persisting the same
  stream entries twice — the second pass writes nothing.
- **Exactly-once closing**: twenty workers closing the same lot simultaneously produce one closure
  row and one close event. A lot whose end time moved reschedules instead of closing. A closure that
  Redis completed but whose worker died is finished by the sweeper.
- **Losing Redis entirely** (design doc §8.2): every key for a lot is deleted mid-auction, and the
  next bid rebuilds the state from `bid_events`, recomputes the extensions from the soft-close rule,
  and carries on at the right sequence number.
- **`apps/worker`** now runs for real: the persistence loop, the delayed close job, and the 30-second
  sweeper, with an end-to-end test that places bids and lets the real BullMQ job close the lot on
  time.
- **CI** gained an `integration` job that brings up `infra/docker-compose.yml` — the same Redis
  config as local, because the engine depends on `noeviction` — applies migrations and runs
  `pnpm test:int`.
- **ADR-0008** records why persistence goes through one Redis Stream per lot.
- **Mutation testing again, and this time it found two gaps in my own tests.** Breaking the Lua
  tie-break rule did _not_ fail the differential test, because the wide generator drew maximums from
  256 values and two bidders almost never picked the same one; a tie-prone generator was added and
  now catches it. Breaking the money formatter did not fail either — and that one turned out to be
  honest: Lua prints with `%.14g`, so `tostring` is exact below 1e15 kobo (₦10 trillion), which no
  lot will reach. The threshold is now pinned in `money-format.int.test.ts` and the comment says
  what the helper is really for.

### Milestone 5 — the real-time layer (20 November 2026)

- **Socket.IO on `apps/api`**, attached to the port Fastify already listens on, with
  `@socket.io/redis-adapter` for cross-instance watcher counts. Sockets are **read-only**: watch,
  resync, and the clock exchange. There is deliberately no bid endpoint yet — a bid needs an
  authenticated caller, and authentication is milestone 7. An endpoint that took a user id on trust
  would be a hole, and shipping one "just for the demo" is how holes become permanent.
- **Deltas arrive by tailing each lot's event stream**, not by emitting on accept. The reason is the
  worker: it closes lots, it is not a Socket.IO server, and a closing lot is the most important event
  a watcher gets. Tailing means whoever appends to the stream is broadcast, through one path.
  **ADR-0009**, which amends ADR-0006.
- **Stream entry ids are now the lot's `seq`** (`<seq>-0`), so the stream is an index on `seq` and a
  reconnecting client is served by a seek rather than a scan. Streams are trimmed to a 2,000-event
  reconnect window.
- **Resync**: a client sends its last `seq` and gets the events it missed — or, if the stream no
  longer reaches that far, a snapshot. Both sides of that boundary are tested, on the socket path and
  the REST path.
- **A REST fallback** (`GET /lots/:id/state`, `GET /lots/:id/events?fromSeq=`, `GET /time`) returns
  the same facts for connections where WebSockets never establish — a real condition on Nigerian
  mobile networks, not a theoretical one. Both are `cache-control: no-store`: a cached price is a
  price somebody would bid against.
- **Secrecy is enforced in one place.** `toPublicEvent` and `toPublicSnapshot` in `packages/live` are
  the only gate between a stream entry (which carries the bidder's secret maximum, because the
  persisting worker needs it) and anything a watcher sees. A reserve is reported as "exists" and
  "met or not", never as an amount.
- **Two instances, real socket clients, measured**: a bid accepted anywhere reaches watchers on both
  instances, in sequence order, exactly once each. Delta latency measured at **21 ms for the first
  (it includes the tailer's connection handshake) and 4–23 ms after that**, against a 500 ms target.
  Published by `timing.int.test.ts` rather than averaged into a pass.
- **Mutation testing earned its place again.** Changing the delta emit from `io.local.to(...)` to
  `io.to(...)` makes the two-instance test fail with the sequence `[1, 2, 3, 1, 2, 3, 4, 5]` — so the
  local emit is load-bearing, not a stylistic choice, and the test proves it.
- **Two of my own tests were weak and were rewritten.** One asserted
  `expect(['deltas', 'snapshot']).toContain(reply.kind)`, which is true whatever happens; it now
  trims the stream deliberately and asserts a snapshot. Another polled a variable nothing updated.
- **Two findings while verifying**: Fastify 5.12 deprecates the `disableRequestLogging` option we
  passed (we passed its default, so it was removed), and two integration tests that looked like
  five-second delivery failures turned out to be Postgres seeding and cleanup around the assertions —
  which is why the timings are now measured on their own.

## Next (milestone 6 — the category engine)

1. **`categories`, `category_schema_versions`, `category_rules`**: the tables from design doc §6.2,
   with versioned JSONB attribute schemas.
2. **zod validators generated from a published schema version**, so a lot's attributes are validated
   against the version it was created under and never against a later one.
3. **`rules_snapshot` written at scheduling**, from `category_rules` — the mechanism already exists
   and is already honoured by the engine; milestone 6 is what fills it from a real category.
4. **The launch categories seeded**: vehicles, phones, electronics, computers, appliances, art,
   jewellery and watches, luxury fashion, furniture, generators and machinery, and corporate or
   government asset disposals.
5. **A test that a new category can be added with no code change**, which is the whole claim.

## Decisions waiting for Akanji

| #   | Decision                                                                                                                                                  | Default if he doesn't mind                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | Domain and social handles: `ojalive.com` / `ojalive.ng` / `oja.live`, `@ojalive`                                                                          | Proceed with the name; tweak branding if `.com` is taken |
| 2   | Redis: self-run on a Fly machine (recommended) vs Redis Cloud Essentials ~$5/mo                                                                           | Self-run on Fly                                          |
| 3   | Neon free plan's current restore window — decides whether we pay $19/mo for Launch                                                                        | Start on Free, upgrade before the milestone 10 deploy    |
| 4   | **Node 26 LTS locally.** This machine has Node 24.16.0. CI runs 26.13.0 and `engines` allows 24.16+, so nothing is blocked, but local and CI should match | Install Node 26 LTS when convenient                      |

## Open issues / things to revisit

- **Browser-level Playwright testing moved from milestone 5 to milestone 7.** There is no bidding UI
  to drive yet, so a browser test would only prove that `socket.io-client` works inside Chromium. The
  server claim is tested with two real instances and real socket clients instead. ADR-0009.
- **One Redis connection per watched lot per instance**, because each tailer blocks on `XREAD`. Fine
  at demo scale; thousands of simultaneous lots would want a shared multi-stream read. A known
  change, not a redesign.
- **Stream retention is 2,000 events per lot.** A client away longer than that gets a snapshot. The
  number is a guess at "a very busy lot's last few minutes" and should be revisited with real load
  figures in milestone 11.
- **Sockets carry no identity yet.** They are read-only, so there is nothing to authorise; milestone 7
  adds authentication and with it the bid endpoint.

- **The Lua script and the TypeScript engine are two implementations of one set of rules.** They are
  kept in step by the differential test, not by discipline. Any change to `packages/bid-engine` must
  be made in `packages/live/src/lua` as well, and `pnpm test:int` is what catches it if not.
- **Idempotency lives in two places on purpose.** Redis remembers keys for 24 hours (long enough for
  any client retry) and `UNIQUE (lot_id, user_id, idempotency_key)` remembers them forever. The Redis
  copy is for answering fast; the constraint is for being right.
- **The engine's idempotency check runs BEFORE the rules**, which is a deliberate departure from the
  order in design doc §7.2. A retry of an accepted bid must get the original answer; if the rules ran
  first, the leader retrying their own bid would be told "you already lead this lot".
- **`lot_closures.winning_bid_event_id` references `bid_events` with RESTRICT**, so anything deleting
  a lot's history must remove the closure first. Found by the integration tests' own cleanup failing.
- **Stream trimming is not implemented yet.** Each lot's stream grows without bound. It is harmless
  at demo scale and belongs with resync in milestone 5, where the retention window is decided.

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
