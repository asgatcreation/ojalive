/**
 * Parsing what the Lua scripts return, and building what they are given.
 *
 * A reply from Redis is a boundary like any other, so it is parsed with zod
 * rather than trusted. Amounts cross as strings and become `bigint` kobo here —
 * the one place where "money arrived from somewhere else" is handled.
 */

import { z } from 'zod';
import type { EpochMillis, Kobo } from '@ojalive/shared';
import type { LotState, Rejection, RejectionReason } from '@ojalive/bid-engine';

export class ReplyError extends Error {}

const kobo = z
  .string()
  .regex(/^-?\d+$/, 'expected an integer amount in kobo')
  .transform((value) => BigInt(value));

const nullableKobo = z.union([kobo, z.null()]);

const rejectionReason: z.ZodType<RejectionReason> = z.enum([
  'auction_closed',
  'auction_not_open',
  'bidding_paused',
  'below_next_increment',
  'deposit_required',
  'verification_required',
  'already_leading',
  'buy_now_unavailable',
  'not_yet_due',
  'rate_limited',
]);

const snapshotSchema = z.object({
  outcome: z.enum(['accepted', 'replayed']),
  status: z.enum(['scheduled', 'open', 'paused', 'closing', 'closed']),
  seq: z.number().int().nonnegative(),
  priceKobo: kobo,
  leaderUserId: z.union([z.string(), z.null()]),
  leaderMaxKobo: nullableKobo,
  leaderMaxSetSeq: z.union([z.number().int(), z.null()]),
  bidCount: z.number().int().nonnegative(),
  buyNowKobo: nullableKobo,
  endsAt: z.number().int(),
  originalEndsAt: z.number().int(),
  extensionCount: z.number().int().nonnegative(),
  reserveMet: z.boolean(),
  extended: z.boolean(),
  lotOutcome: z.union([z.enum(['sold', 'unsold_no_bids', 'unsold_reserve_not_met']), z.null()]),
  buyNowWithdrawn: z.boolean().optional(),
});

const rejectedSchema = z.object({
  outcome: z.literal('rejected'),
  reason: rejectionReason,
  nextAcceptableKobo: kobo.optional(),
  endsAt: z.number().int().optional(),
});

const noStateSchema = z.object({ outcome: z.literal('no_state') });

const replySchema = z.union([snapshotSchema, rejectedSchema, noStateSchema]);

export type LiveSnapshot = z.infer<typeof snapshotSchema>;

export type LiveResult =
  /** The command was applied now. */
  | { readonly kind: 'accepted'; readonly snapshot: LiveSnapshot }
  /** This idempotency key was seen before; this is the ORIGINAL outcome. */
  | { readonly kind: 'replayed'; readonly snapshot: LiveSnapshot }
  | { readonly kind: 'rejected'; readonly rejection: Rejection; readonly endsAt?: EpochMillis }
  /** Redis holds no state for this lot. The caller rebuilds it from Postgres. */
  | { readonly kind: 'no_state' };

export function parseReply(json: string): LiveResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ReplyError(`Script returned text that is not JSON: ${json.slice(0, 120)}`);
  }

  const parsed = replySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ReplyError(`Script returned an unexpected shape: ${parsed.error.message}`);
  }

  const reply = parsed.data;
  if (reply.outcome === 'no_state') return { kind: 'no_state' };
  if (reply.outcome === 'rejected') {
    const rejection: Rejection =
      reply.nextAcceptableKobo === undefined
        ? { reason: reply.reason }
        : { reason: reply.reason, nextAcceptableKobo: reply.nextAcceptableKobo };
    return reply.endsAt === undefined
      ? { kind: 'rejected', rejection }
      : { kind: 'rejected', rejection, endsAt: reply.endsAt };
  }
  return { kind: reply.outcome === 'replayed' ? 'replayed' : 'accepted', snapshot: reply };
}

/** Empty string, never null: a Redis hash field cannot hold null. */
function field(value: Kobo | number | string | null): string {
  if (value === null) return '';
  return typeof value === 'string' ? value : value.toString();
}

/**
 * The state as `seed-state.lua` expects it: every value a string, because a Lua
 * number on its way through a Redis hash can come back in exponent form.
 */
export function seedPayload(state: LotState): string {
  return JSON.stringify({
    lotId: state.lotId,
    status: state.status,
    seq: field(state.seq),
    priceKobo: field(state.priceKobo),
    startingPriceKobo: field(state.startingPriceKobo),
    reservePriceKobo: field(state.reservePriceKobo),
    buyNowPriceKobo: field(state.buyNowPriceKobo),
    leaderUserId: field(state.leaderUserId),
    leaderMaxKobo: field(state.leaderMaxKobo),
    leaderMaxSetSeq: field(state.leaderMaxSetSeq),
    bidCount: field(state.bidCount),
    endsAt: field(state.endsAt),
    originalEndsAt: field(state.originalEndsAt),
    extensionCount: field(state.extensionCount),
    outcome: field(state.outcome),
    rules: {
      incrementBands: state.rules.incrementBands.map((band) => ({
        upToKobo: band.upToKobo === null ? null : band.upToKobo.toString(),
        stepKobo: band.stepKobo.toString(),
      })),
      softClose: {
        windowMillis: state.rules.softClose.windowMillis,
        extensionMillis: state.rules.softClose.extensionMillis,
        maxTotalExtensionMillis: state.rules.softClose.maxTotalExtensionMillis,
      },
    },
  });
}

/**
 * The snapshot as a `LotState`, so a Lua result can be compared with the pure
 * engine's result field by field. That comparison is the differential test.
 */
export function snapshotToState(snapshot: LiveSnapshot, base: LotState): LotState {
  return {
    ...base,
    status: snapshot.status,
    seq: snapshot.seq,
    priceKobo: snapshot.priceKobo,
    leaderUserId: snapshot.leaderUserId,
    leaderMaxKobo: snapshot.leaderMaxKobo,
    leaderMaxSetSeq: snapshot.leaderMaxSetSeq,
    bidCount: snapshot.bidCount,
    buyNowPriceKobo: snapshot.buyNowKobo,
    endsAt: snapshot.endsAt,
    originalEndsAt: snapshot.originalEndsAt,
    extensionCount: snapshot.extensionCount,
    outcome: snapshot.lotOutcome,
  };
}
