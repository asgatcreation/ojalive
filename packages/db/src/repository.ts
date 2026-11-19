/**
 * Every query the bidding path makes, in one place.
 *
 * The important property of this file: the only writes to `bid_events` are
 * inserts, and every insert is guarded by a unique constraint rather than by a
 * check-then-write. Two instances racing is not a scenario to avoid here, it is
 * the normal case, so the database decides and the loser finds out.
 */

import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { EpochMillis, Kobo } from '@ojalive/shared';
import { replay, type LotState, type TimedCommand } from '@ojalive/bid-engine';
import type { Database } from './client.js';
import { atTime, initialStateForReplay, millis, toEngineState } from './mapping.js';
import {
  bidEvents,
  lotClosures,
  lotState,
  lots,
  sales,
  users,
  type BidEventRow,
  type LotClosureRow,
  type LotRow,
  type LotStateRow,
  type NewBidEventRow,
} from './schema.js';

export async function getLot(db: Database, lotId: string): Promise<LotRow | null> {
  const rows = await db.select().from(lots).where(eq(lots.id, lotId)).limit(1);
  return rows[0] ?? null;
}

/** The engine's view of a lot: the lot row plus its projection. */
export async function loadEngineState(db: Database, lotId: string): Promise<LotState | null> {
  const rows = await db
    .select({ lot: lots, state: lotState })
    .from(lots)
    .leftJoin(lotState, eq(lotState.lotId, lots.id))
    .where(eq(lots.id, lotId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;
  return toEngineState(row.lot, row.state);
}

/** Every event for a lot, oldest first. Retracted events are included. */
export async function bidEventsForLot(db: Database, lotId: string): Promise<BidEventRow[]> {
  return db.select().from(bidEvents).where(eq(bidEvents.lotId, lotId)).orderBy(asc(bidEvents.seq));
}

/** The original outcome of a bid that has already been accepted, if there is one. */
export async function findByIdempotencyKey(
  db: Database,
  lotId: string,
  userId: string,
  idempotencyKey: string,
): Promise<BidEventRow | null> {
  const rows = await db
    .select()
    .from(bidEvents)
    .where(
      and(
        eq(bidEvents.lotId, lotId),
        eq(bidEvents.userId, userId),
        eq(bidEvents.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** The projection row as stored, for callers that want it verbatim. */
export async function getLotStateRow(db: Database, lotId: string): Promise<LotStateRow | null> {
  const rows = await db.select().from(lotState).where(eq(lotState.lotId, lotId)).limit(1);
  return rows[0] ?? null;
}

/** The closure row, if this lot has been closed. */
export async function getClosure(db: Database, lotId: string): Promise<LotClosureRow | null> {
  const rows = await db.select().from(lotClosures).where(eq(lotClosures.lotId, lotId)).limit(1);
  return rows[0] ?? null;
}

export interface AcceptedBidRecord {
  readonly lotId: string;
  readonly seq: number;
  readonly userId: string;
  readonly kind: NewBidEventRow['kind'];
  readonly maxAmountKobo: Kobo | null;
  readonly priceAfterKobo: Kobo;
  readonly leaderAfterUserId: string | null;
  readonly idempotencyKey: string | null;
  readonly acceptedAt: EpochMillis;
  readonly source: NewBidEventRow['source'];
  readonly endsAt: EpochMillis;
  readonly extensionCount: number;
  readonly leaderMaxKobo: Kobo | null;
  readonly leaderMaxSetSeq: number | null;
  readonly bidCount: number;
  readonly reserveMet: boolean;
}

/**
 * Persist one accepted bid: append the event, then move the projection forward.
 *
 * Returns the row that was written, or `null` when `(lot_id, seq)` already
 * existed — which is what makes this safe to run twice. The persisting worker
 * reads from a Redis Stream with a consumer group, and a consumer group gives
 * at-least-once delivery, so running twice is not an edge case, it is Tuesday.
 *
 * The projection update is conditional on `seq`, so an event that arrives late
 * can never drag the state backwards.
 */
export async function persistAcceptedBid(
  db: Database,
  record: AcceptedBidRecord,
): Promise<BidEventRow | null> {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(bidEvents)
      .values({
        lotId: record.lotId,
        seq: record.seq,
        userId: record.userId,
        kind: record.kind,
        maxAmountKobo: record.maxAmountKobo,
        priceAfterKobo: record.priceAfterKobo,
        leaderAfterUserId: record.leaderAfterUserId,
        idempotencyKey: record.idempotencyKey,
        acceptedAt: atTime(record.acceptedAt),
        source: record.source,
      })
      .onConflictDoNothing()
      .returning();

    const row = inserted[0];
    if (row === undefined) return null;

    await tx
      .insert(lotState)
      .values({
        lotId: record.lotId,
        seq: record.seq,
        priceKobo: record.priceAfterKobo,
        leaderUserId: record.leaderAfterUserId,
        leaderMaxKobo: record.leaderMaxKobo,
        leaderMaxSetSeq: record.leaderMaxSetSeq,
        bidCount: record.bidCount,
        endsAt: atTime(record.endsAt),
        reserveMet: record.reserveMet,
        updatedAt: atTime(record.acceptedAt),
      })
      .onConflictDoUpdate({
        target: lotState.lotId,
        set: {
          seq: record.seq,
          priceKobo: record.priceAfterKobo,
          leaderUserId: record.leaderAfterUserId,
          leaderMaxKobo: record.leaderMaxKobo,
          leaderMaxSetSeq: record.leaderMaxSetSeq,
          bidCount: record.bidCount,
          endsAt: atTime(record.endsAt),
          reserveMet: record.reserveMet,
          updatedAt: atTime(record.acceptedAt),
        },
        setWhere: sql`${lotState.seq} < ${record.seq}`,
      });

    // The lot row carries the authoritative end time, because the closing job
    // trusts the database and not its own schedule (design doc §8.5).
    await tx
      .update(lots)
      .set({ endsAt: atTime(record.endsAt), extensionCount: record.extensionCount })
      .where(and(eq(lots.id, record.lotId), lt(lots.endsAt, atTime(record.endsAt))));

    return row;
  });
}

export interface ClosureRecord {
  readonly lotId: string;
  readonly closedAt: EpochMillis;
  readonly hammerPriceKobo: Kobo;
  readonly outcome: 'sold' | 'unsold_reserve' | 'no_bids' | 'cancelled';
  readonly winnerUserId: string | null;
  readonly seq: number;
}

/**
 * Close a lot, once and for all.
 *
 * `lot_closures.lot_id` is the primary key, so a second attempt inserts
 * nothing and returns `false`. That is the fourth and last layer of the
 * exactly-once closing described in design doc §8.5 — the one that still holds
 * when the other three have all failed.
 */
export async function recordClosure(
  db: Database,
  record: ClosureRecord,
): Promise<{ readonly closed: boolean }> {
  return db.transaction(async (tx) => {
    const winningEvent =
      record.winnerUserId === null
        ? []
        : await tx
            .select({ id: bidEvents.id })
            .from(bidEvents)
            .where(
              and(
                eq(bidEvents.lotId, record.lotId),
                eq(bidEvents.leaderAfterUserId, record.winnerUserId),
                isNull(bidEvents.retractedAt),
              ),
            )
            .orderBy(sql`${bidEvents.seq} desc`)
            .limit(1);

    const inserted = await tx
      .insert(lotClosures)
      .values({
        lotId: record.lotId,
        closedAt: atTime(record.closedAt),
        hammerPriceKobo: record.hammerPriceKobo,
        outcome: record.outcome,
        winningBidEventId: winningEvent[0]?.id ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) return { closed: false };

    await tx
      .insert(bidEvents)
      .values({
        lotId: record.lotId,
        seq: record.seq,
        kind: 'close',
        priceAfterKobo: record.hammerPriceKobo,
        leaderAfterUserId: record.winnerUserId,
        acceptedAt: atTime(record.closedAt),
        source: 'api',
      })
      .onConflictDoNothing();

    await tx.update(lots).set({ status: 'closed' }).where(eq(lots.id, record.lotId));

    return { closed: true };
  });
}

/**
 * Lots that should have closed and have not (design doc §8.5).
 *
 * This is the sweeper's query: it is what catches a delayed job lost to a Redis
 * flush or a worker that died holding it. The grace period keeps it from
 * racing the job that is probably already running.
 */
export async function lotsDueToClose(
  db: Database,
  now: EpochMillis,
  graceMillis: number,
  limit = 100,
): Promise<LotRow[]> {
  return db
    .select()
    .from(lots)
    .where(
      and(
        or(eq(lots.status, 'open'), eq(lots.status, 'closing')),
        lt(lots.endsAt, atTime(now - graceMillis)),
      ),
    )
    .orderBy(asc(lots.endsAt))
    .limit(limit);
}

/** The commands a lot's log represents, ready to replay through the engine. */
export function toCommands(lot: LotRow, events: readonly BidEventRow[]): TimedCommand[] {
  const commands: TimedCommand[] = [];

  for (const event of events) {
    // A retracted event is simply not replayed. That is the whole mechanism:
    // no correction is written, the history is just re-read without it.
    if (event.retractedAt !== null) continue;

    const at = millis(event.acceptedAt);
    if (event.kind === 'bid' && event.userId !== null && event.maxAmountKobo !== null) {
      commands.push({
        command: {
          kind: 'place_bid',
          lotId: lot.id,
          userId: event.userId,
          maxKobo: event.maxAmountKobo,
          idempotencyKey: event.idempotencyKey ?? `replay_${String(event.seq)}`,
          // The bidder's limit was checked when the bid was accepted. The log
          // records what WAS accepted, so replay must not re-judge it against a
          // limit that may since have changed.
          bidLimitKobo: event.maxAmountKobo,
          limitReason: 'deposit_required',
        },
        at,
      });
      continue;
    }
    if (event.kind === 'buy_now' && event.userId !== null) {
      commands.push({
        command: {
          kind: 'buy_now',
          lotId: lot.id,
          userId: event.userId,
          idempotencyKey: event.idempotencyKey ?? `replay_${String(event.seq)}`,
          bidLimitKobo: event.priceAfterKobo,
          limitReason: 'deposit_required',
        },
        at,
      });
      continue;
    }
    if (event.kind === 'close') {
      commands.push({ command: { kind: 'close_lot', lotId: lot.id }, at });
    }
    // pause / resume / extend / proxy_raise arrive with the staff console in
    // milestone 9 and are deliberately not invented here.
  }

  return commands;
}

/**
 * Rebuild `lot_state` from `bid_events` (design doc §8.2 and §7.7).
 *
 * This is the recovery path, the retraction path and a test assertion all at
 * once: the projection is deleted and recomputed from the log, extensions and
 * all. If this ever disagreed with the live state, the log would win.
 */
export async function rebuildLotState(
  db: Database,
  lotId: string,
): Promise<{ readonly state: LotState; readonly commands: number } | null> {
  const lot = await getLot(db, lotId);
  if (lot === null) return null;

  const events = await bidEventsForLot(db, lotId);
  const commands = toCommands(lot, events);
  const result = replay(initialStateForReplay(lot), commands);

  await db
    .insert(lotState)
    .values({
      lotId,
      seq: result.state.seq,
      priceKobo: result.state.priceKobo,
      leaderUserId: result.state.leaderUserId,
      leaderMaxKobo: result.state.leaderMaxKobo,
      leaderMaxSetSeq: result.state.leaderMaxSetSeq,
      bidCount: result.state.bidCount,
      endsAt: atTime(result.state.endsAt),
      reserveMet:
        result.state.reservePriceKobo === null ||
        result.state.priceKobo >= result.state.reservePriceKobo,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: lotState.lotId,
      set: {
        seq: result.state.seq,
        priceKobo: result.state.priceKobo,
        leaderUserId: result.state.leaderUserId,
        leaderMaxKobo: result.state.leaderMaxKobo,
        leaderMaxSetSeq: result.state.leaderMaxSetSeq,
        bidCount: result.state.bidCount,
        endsAt: atTime(result.state.endsAt),
        reserveMet:
          result.state.reservePriceKobo === null ||
          result.state.priceKobo >= result.state.reservePriceKobo,
        updatedAt: new Date(),
      },
    });

  return { state: result.state, commands: commands.length };
}

/**
 * Delete a demo lot and everything hanging off it, in foreign-key order.
 *
 * Used by the integration tests and by the milestone 10 reset script. It
 * REFUSES a lot that is not marked `is_demo`, because a reset script that can
 * touch real sales is a reset script that eventually will. The guard is here,
 * in the only function that can do the damage, rather than in each caller.
 */
export async function deleteDemoLot(
  db: Database,
  target: {
    readonly lotId: string;
    readonly saleId?: string;
    readonly userIds?: readonly string[];
  },
): Promise<void> {
  const lot = await getLot(db, target.lotId);
  if (lot === null) return;
  if (!lot.isDemo) {
    throw new Error(`Refusing to delete lot ${target.lotId}: it is not demo data`);
  }

  // Order matters: `lot_closures.winning_bid_event_id` references `bid_events`
  // with RESTRICT, so the closure goes first or Postgres refuses the delete.
  await db.delete(lotClosures).where(eq(lotClosures.lotId, target.lotId));
  await db.delete(bidEvents).where(eq(bidEvents.lotId, target.lotId));
  await db.delete(lotState).where(eq(lotState.lotId, target.lotId));
  await db.delete(lots).where(eq(lots.id, target.lotId));
  if (target.saleId !== undefined) {
    await db.delete(sales).where(and(eq(sales.id, target.saleId), eq(sales.isDemo, true)));
  }
  if (target.userIds !== undefined && target.userIds.length > 0) {
    await db.delete(users).where(inArray(users.id, [...target.userIds]));
  }
}
