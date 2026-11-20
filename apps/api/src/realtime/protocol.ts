/**
 * The socket protocol, validated with zod like any other boundary.
 *
 * Sockets are **read-only** in this milestone. A client can watch a lot, catch
 * up after a reconnect, and ask the server what time it is. Bids go over HTTP,
 * because a bid needs an authenticated caller and real authentication arrives
 * in milestone 7 — accepting bids from a socket that merely claims a user id
 * would be a hole, not a shortcut.
 */

import { z } from 'zod';
import type { PublicLotEvent, PublicLotSnapshot } from '@ojalive/live';

/** Client to server. */
export const CLIENT_EVENTS = {
  watch: 'lot:watch',
  unwatch: 'lot:unwatch',
  resync: 'lot:resync',
  time: 'clock:time',
} as const;

/** Server to client. */
export const SERVER_EVENTS = {
  /** One accepted bid, buy-now or close. Carries `seq`. */
  delta: 'lot:delta',
  /** The whole lot: on watch, and whenever deltas cannot bridge the gap. */
  snapshot: 'lot:snapshot',
  /** How many people are watching this lot right now. */
  watchers: 'lot:watchers',
  /** Something the client asked for that cannot be done. */
  problem: 'lot:problem',
} as const;

export const watchPayloadSchema = z.object({
  lotId: z.string().uuid(),
  /** The last seq this client has already applied, if it is reconnecting. */
  fromSeq: z.number().int().nonnegative().optional(),
});

export const unwatchPayloadSchema = z.object({ lotId: z.string().uuid() });

export const resyncPayloadSchema = z.object({
  lotId: z.string().uuid(),
  fromSeq: z.number().int().nonnegative(),
});

export const timePayloadSchema = z.object({
  /** The client's clock when it sent this, echoed back untouched. */
  t0: z.number().int().nonnegative(),
});

export type WatchPayload = z.infer<typeof watchPayloadSchema>;
export type ResyncPayload = z.infer<typeof resyncPayloadSchema>;
export type TimePayload = z.infer<typeof timePayloadSchema>;

/**
 * The reply to a clock exchange (design doc §7.6).
 *
 * The client sends `t0`, notes `t3` when the reply lands, and takes the median
 * offset over several samples. It then draws its countdown against server time.
 * It never decides that a lot has closed — it waits to be told.
 */
export interface TimeReply {
  readonly t0: number;
  readonly t1: number;
}

export type ResyncReply =
  /** Here are the events you missed. */
  | { readonly kind: 'deltas'; readonly events: readonly PublicLotEvent[] }
  /**
   * You were away longer than the stream's retention window, so start again
   * from this snapshot. Cheaper for the client than thousands of deltas, and
   * the only honest answer when the events are genuinely gone from Redis.
   */
  | { readonly kind: 'snapshot'; readonly snapshot: PublicLotSnapshot }
  | { readonly kind: 'unknown_lot' };

export function lotRoom(lotId: string): string {
  return `lot:${lotId}`;
}
