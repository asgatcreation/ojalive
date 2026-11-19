/**
 * The bidding path: Redis decides, Postgres remembers.
 *
 * A bid takes one round trip to Redis. It does not touch Postgres at all on the
 * happy path — that is what keeps p95 where the service targets need it, and it
 * is why bidding survives a Postgres outage (design doc §8.4). Postgres is
 * consulted only when Redis has no state for a lot, which means either the lot
 * is cold or Redis was lost and restarted empty. Then the log is replayed and
 * the state reinstalled, and the bid proceeds.
 */

import type { Redis } from 'ioredis';
import type { EpochMillis, Kobo } from '@ojalive/shared';
import type { BidLimitReason, LotOutcome } from '@ojalive/bid-engine';
import {
  getLot,
  loadEngineState,
  rebuildLotState,
  recordClosure,
  type Database,
} from '@ojalive/db';
import { lotIdempotencyKey, lotStateKey, lotStreamKey } from './keys.js';
import { parseReply, seedPayload, type LiveResult, type LiveSnapshot } from './replies.js';
import type { ScriptRunner } from './scripts.js';
import { readLiveState } from './state.js';
import { markLotActive } from './stream.js';

export class LiveError extends Error {}

export interface LiveContext {
  readonly redis: Redis;
  readonly db: Database;
  readonly scripts: ScriptRunner;
  /**
   * How long an idempotency key is remembered in Redis. It only has to outlive
   * a client's retries; `UNIQUE (lot_id, user_id, idempotency_key)` in Postgres
   * is the permanent record.
   */
  readonly idempotencyTtlSeconds?: number;
}

export interface PlaceBidInput {
  readonly lotId: string;
  readonly userId: string;
  readonly maxKobo: Kobo;
  readonly idempotencyKey: string;
  readonly bidLimitKobo: Kobo;
  readonly limitReason: BidLimitReason;
  readonly source?: 'web' | 'api' | 'bot' | 'staff';
}

export interface BuyNowInput {
  readonly lotId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly bidLimitKobo: Kobo;
  readonly limitReason: BidLimitReason;
  readonly source?: 'web' | 'api' | 'bot' | 'staff';
}

const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86_400;

function lotKeys(lotId: string): string[] {
  return [lotStateKey(lotId), lotStreamKey(lotId), lotIdempotencyKey(lotId)];
}

/**
 * Install a lot's state in Redis from Postgres, if it is not there already.
 *
 * The rebuild replays `bid_events` through the pure engine, so extensions and
 * the leader's secret maximum are recomputed rather than restored — which is
 * also why this same path is what recovers from losing Redis entirely.
 */
export async function ensureLotState(
  ctx: LiveContext,
  lotId: string,
): Promise<'installed' | 'exists' | 'unknown_lot'> {
  // The common case by far: the state is already there, and this costs one
  // EXISTS. Without this check every close job and every cold-looking bid would
  // replay a lot's whole log for nothing.
  if ((await ctx.redis.exists(lotStateKey(lotId))) === 1) return 'exists';

  const lot = await getLot(ctx.db, lotId);
  if (lot === null) return 'unknown_lot';

  // Rebuild the projection from the log first, then take the lot's own status
  // and the freshly rebuilt numbers together: `loadEngineState` reads the lot
  // row, so a lot that is merely scheduled is not installed as open.
  await rebuildLotState(ctx.db, lotId);
  const state = await loadEngineState(ctx.db, lotId);
  if (state === null) return 'unknown_lot';

  const reply = await ctx.scripts.run('seedState', [lotStateKey(lotId)], [seedPayload(state)]);
  // The worker discovers streams from this set. It is written from here, not
  // from inside the script, so that every script keeps to the one hash slot it
  // declares and stays legal if this is ever sharded.
  await markLotActive(ctx.redis, lotId);
  const parsed: unknown = JSON.parse(reply);
  const outcome =
    typeof parsed === 'object' && parsed !== null && 'outcome' in parsed ? parsed.outcome : null;
  return outcome === 'installed' ? 'installed' : 'exists';
}

/**
 * Run a script, and if Redis has no state for the lot, install it and run once
 * more. Exactly once more: a second `no_state` means something is wrong (the
 * lot does not exist, or someone is flushing Redis while we work), and looping
 * would turn that into a hot loop instead of an error.
 */
async function withState(
  ctx: LiveContext,
  lotId: string,
  run: () => Promise<string>,
): Promise<LiveResult> {
  const first = parseReply(await run());
  if (first.kind !== 'no_state') return first;

  const installed = await ensureLotState(ctx, lotId);
  if (installed === 'unknown_lot') throw new LiveError(`No such lot: ${lotId}`);

  const second = parseReply(await run());
  if (second.kind === 'no_state') {
    throw new LiveError(`Lot ${lotId} has no live state even after a rebuild`);
  }
  return second;
}

export async function placeBid(
  ctx: LiveContext,
  input: PlaceBidInput,
  now: EpochMillis,
): Promise<LiveResult> {
  const args = [
    input.userId,
    input.maxKobo.toString(),
    input.idempotencyKey,
    input.bidLimitKobo.toString(),
    input.limitReason,
    now.toString(),
    input.source ?? 'web',
    (ctx.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS).toString(),
  ];
  return withState(ctx, input.lotId, () => ctx.scripts.run('placeBid', lotKeys(input.lotId), args));
}

export async function buyNow(
  ctx: LiveContext,
  input: BuyNowInput,
  now: EpochMillis,
): Promise<LiveResult> {
  const args = [
    input.userId,
    input.idempotencyKey,
    input.bidLimitKobo.toString(),
    input.limitReason,
    now.toString(),
    input.source ?? 'web',
    (ctx.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS).toString(),
  ];
  return withState(ctx, input.lotId, () => ctx.scripts.run('buyNow', lotKeys(input.lotId), args));
}

export type CloseResult =
  /** This call closed the lot. Exactly one caller ever sees this. */
  | { readonly kind: 'closed'; readonly snapshot: LiveSnapshot; readonly wroteClosure: boolean }
  /** Someone else closed it first; the Postgres closure was reconciled anyway. */
  | { readonly kind: 'already_closed'; readonly wroteClosure: boolean }
  /** The end time moved out from under the job. Reschedule for `endsAt`. */
  | { readonly kind: 'not_yet_due'; readonly endsAt: EpochMillis }
  | { readonly kind: 'unknown_lot' };

const CLOSURE_OUTCOMES = {
  sold: 'sold',
  unsold_no_bids: 'no_bids',
  unsold_reserve_not_met: 'unsold_reserve',
} as const satisfies Record<LotOutcome, 'sold' | 'no_bids' | 'unsold_reserve'>;

/**
 * Close a lot exactly once (design doc §8.5).
 *
 * All four layers are visible in this one function, in order:
 *
 * 1. the caller is a delayed BullMQ job, or the sweeper;
 * 2. **the database end time is re-read here** — if the soft close moved it, the
 *    job reschedules and does nothing else, because the schedule is not the
 *    authority;
 * 3. the Lua compare-and-set decides who actually closes it;
 * 4. `lot_closures.lot_id` is the primary key, so the closure row cannot be
 *    written twice even if layers 1–3 all went wrong at once.
 *
 * Layer 4 runs even when layer 3 says the lot was already closed, because
 * "Redis closed it and then the worker died before writing to Postgres" is a
 * real sequence of events, and the sweeper is how it gets finished.
 */
export async function closeLot(
  ctx: LiveContext,
  lotId: string,
  now: EpochMillis,
): Promise<CloseResult> {
  const lot = await getLot(ctx.db, lotId);
  if (lot === null) return { kind: 'unknown_lot' };

  const dbEndsAt = lot.endsAt.getTime();
  if (now < dbEndsAt) return { kind: 'not_yet_due', endsAt: dbEndsAt };

  const installed = await ensureLotState(ctx, lotId);
  if (installed === 'unknown_lot') return { kind: 'unknown_lot' };

  const reply = parseReply(
    await ctx.scripts.run(
      'closeLot',
      [lotStateKey(lotId), lotStreamKey(lotId)],
      [now.toString(), 'api'],
    ),
  );

  if (reply.kind === 'rejected') {
    if (reply.rejection.reason === 'not_yet_due') {
      return { kind: 'not_yet_due', endsAt: reply.endsAt ?? dbEndsAt };
    }
    if (reply.rejection.reason === 'auction_closed') {
      const state = await readLiveState(ctx.redis, lotId);
      if (state === null || state.outcome === null) {
        return { kind: 'already_closed', wroteClosure: false };
      }
      const written = await recordClosure(ctx.db, {
        lotId,
        closedAt: now,
        hammerPriceKobo: state.priceKobo,
        outcome: CLOSURE_OUTCOMES[state.outcome],
        winnerUserId: state.outcome === 'sold' ? state.leaderUserId : null,
        seq: state.seq,
      });
      return { kind: 'already_closed', wroteClosure: written.closed };
    }
    throw new LiveError(`Cannot close lot ${lotId}: ${reply.rejection.reason}`);
  }

  if (reply.kind === 'no_state') {
    throw new LiveError(`Lot ${lotId} has no live state even after a rebuild`);
  }

  const snapshot = reply.snapshot;
  const outcome = snapshot.lotOutcome;
  if (outcome === null) throw new LiveError(`Lot ${lotId} closed without an outcome`);

  const written = await recordClosure(ctx.db, {
    lotId,
    closedAt: now,
    hammerPriceKobo: snapshot.priceKobo,
    outcome: CLOSURE_OUTCOMES[outcome],
    winnerUserId: outcome === 'sold' ? snapshot.leaderUserId : null,
    seq: snapshot.seq,
  });

  return { kind: 'closed', snapshot, wroteClosure: written.closed };
}
