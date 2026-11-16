/**
 * @ojalive/bid-engine — the pure bidding logic.
 *
 * `apply(state, command, now)` is the whole engine; `replay(state, log)` rebuilds
 * a lot from its append-only log, which is how retractions and recovery work.
 *
 * `reference.ts` and `test-support.ts` are deliberately not re-exported: they
 * exist for the tests, and for milestone 4's differential tests against the Lua
 * script, which import them by path.
 */

export * from './types.js';
export * from './increments.js';
export * from './engine.js';
