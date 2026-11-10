# ADR-0004: TypeScript 6, not 7

- **Status:** Accepted
- **Date:** 2026-11-02
- **Review trigger:** when `typescript-eslint` ships TypeScript 7 support

## Context

TypeScript 7.0.2 is the current `latest` tag on npm and is a stable release.
The project's stability rules say: use stable production releases only.

However, `typescript-eslint@8.72.1` declares a peer range of
`typescript >=4.8.4 <6.1.0`. On TypeScript 7 the linter would be running against
a compiler version it does not support — which means the type-aware lint rules
this project depends on (`no-unsafe-assignment`, `no-floating-promises`,
`switch-exhaustiveness-check`) would be in undefined territory.

## Decision

Pin TypeScript **6.0.3** across the monorepo.

## Why

"Stable" has to mean stable _for this toolchain_, not merely tagged stable
upstream. A compiler the linter refuses to support is not a stable choice for a
project whose lint rules are part of its correctness story.

## Alternatives considered

- **TypeScript 7 with lint rules disabled.** Rejected: the type-aware rules are
  load-bearing here, particularly around floating promises in the bid path.
- **TypeScript 7 with a peer-dependency override.** Rejected: that is pretending
  a compatibility problem away rather than waiting a few weeks.
- **TypeScript 5.9.** Unnecessarily far back; 6.0.3 is stable and supported.

## Consequences

- We do not get TypeScript 7's compile-speed improvements yet.
- Renovate is configured to require manual approval for TypeScript major
  updates, so this stays a deliberate decision.
- Revisit as soon as `typescript-eslint` supports TypeScript 7; the migration
  should be a one-line version bump plus a CI run.
