/**
 * Redis keys.
 *
 * Every key for one lot carries the same `{lot:<id>}` hash tag. In a Redis
 * Cluster that forces them into the same slot, which is what lets one Lua
 * script touch the state, the stream and the idempotency map together. Without
 * the tag the scripts would be illegal the day we shard — so the braces are
 * load-bearing punctuation, not decoration.
 */

export function lotTag(lotId: string): string {
  return `{lot:${lotId}}`;
}

/** The lot's live state: one hash, mutated only by the Lua scripts. */
export function lotStateKey(lotId: string): string {
  return `${lotTag(lotId)}:state`;
}

/** The lot's accepted events: a Redis Stream, read by the persisting worker. */
export function lotStreamKey(lotId: string): string {
  return `${lotTag(lotId)}:events`;
}

/** Recent idempotency keys for the lot, so a retry gets the original answer. */
export function lotIdempotencyKey(lotId: string): string {
  return `${lotTag(lotId)}:idem`;
}

/** The consumer group the persisting worker reads the stream with. */
export const PERSIST_GROUP = 'persist';
