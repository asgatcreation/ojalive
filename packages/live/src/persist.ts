/**
 * Moving accepted events from the Redis Stream into Postgres.
 *
 * The worker calls this for every entry it reads. It is deliberately safe to
 * call twice with the same entry: `UNIQUE (lot_id, seq)` makes the second
 * insert a no-op, which is how at-least-once delivery from a consumer group
 * becomes exactly-once storage.
 */

import { persistAcceptedBid, type Database } from '@ojalive/db';
import type { StreamEvent } from './stream.js';

export type PersistOutcome = 'written' | 'already_present' | 'not_persistable';

export async function persistStreamEvent(
  db: Database,
  event: StreamEvent,
): Promise<PersistOutcome> {
  // A close event's row is written inside the same transaction as the closure
  // itself, so there is nothing to do here.
  if (event.kind === 'close' || event.userId === null) return 'not_persistable';

  const row = await persistAcceptedBid(db, {
    lotId: event.lotId,
    seq: event.seq,
    userId: event.userId,
    kind: event.kind === 'buy_now' ? 'buy_now' : 'bid',
    maxAmountKobo: event.maxKobo,
    priceAfterKobo: event.priceKobo,
    leaderAfterUserId: event.leaderUserId,
    idempotencyKey: event.idempotencyKey,
    acceptedAt: event.at,
    source: event.source,
    endsAt: event.endsAt,
    extensionCount: event.extensionCount,
    leaderMaxKobo: event.leaderMaxKobo,
    leaderMaxSetSeq: event.leaderMaxSetSeq,
    bidCount: event.bidCount,
    reserveMet: event.reserveMet,
  });

  return row === null ? 'already_present' : 'written';
}
