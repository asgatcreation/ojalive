/**
 * The Postgres schema — the source of truth (design doc §6).
 *
 * This milestone lands the bidding slice only: people, sales, lots, the
 * append-only `bid_events` log, the rebuildable `lot_state` projection and
 * `lot_closures`. Categories arrive in milestone 6 and money in milestone 8, as
 * separate migrations, expand-then-contract.
 *
 * Two rules hold everywhere in here:
 *
 * - **Money is `bigint` kobo.** Drizzle's `mode: 'bigint'` hands JavaScript a
 *   `bigint`, which is the same `Kobo` type the engine uses. No floats, ever.
 * - **Timestamps are `timestamptz` in UTC.** Africa/Lagos is a display concern.
 */

import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { StoredLotRules } from './rules.js';

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const userStatus = pgEnum('user_status', ['active', 'suspended', 'closed']);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    passwordHash: text('password_hash'),
    isBot: boolean('is_bot').notNull().default(false),
    ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }),
    /** 0 browse, 1 phone OTP, 2 ID document, 3 BVN. Drives the bid limit. */
    verificationTier: smallint('verification_tier').notNull().default(0),
    status: userStatus('status').notNull().default('active'),
    createdAt,
  },
  (table) => [
    uniqueIndex('users_email_key').on(table.email),
    uniqueIndex('users_phone_key').on(table.phone),
  ],
);

export const saleKind = pgEnum('sale_kind', ['timed', 'live', 'sealed']);
export const saleStatus = pgEnum('sale_status', [
  'draft',
  'scheduled',
  'open',
  'closed',
  'cancelled',
]);

export const sales = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    kind: saleKind('kind').notNull().default('timed'),
    opensAt: timestamp('opens_at', { withTimezone: true }).notNull(),
    firstLotClosesAt: timestamp('first_lot_closes_at', { withTimezone: true }).notNull(),
    /** Lots close one at a time, so an extension on lot 14 cannot shove lot 15. */
    staggerSeconds: integer('stagger_seconds').notNull().default(60),
    status: saleStatus('status').notNull().default('draft'),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt,
  },
  (table) => [uniqueIndex('sales_slug_key').on(table.slug)],
);

export const lotStatus = pgEnum('lot_status', [
  'draft',
  'submitted',
  'approved',
  'scheduled',
  'open',
  'paused',
  'closing',
  'closed',
  'cancelled',
]);

export const lotType = pgEnum('lot_type', ['single', 'bulk', 'mixed']);

export const lots = pgTable(
  'lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    saleId: uuid('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'restrict' }),
    sellerId: uuid('seller_id').references(() => users.id, { onDelete: 'restrict' }),
    lotNumber: integer('lot_number').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    lotType: lotType('lot_type').notNull().default('single'),
    quantity: integer('quantity').notNull().default(1),
    /** Validated against the category's published schema version (milestone 6). */
    attributes: jsonb('attributes').notNull().default({}),
    conditionGrade: text('condition_grade'),
    startingPriceKobo: bigint('starting_price_kobo', { mode: 'bigint' }).notNull(),
    /** Null means no reserve: the lot sells for whatever the top bid is. */
    reservePriceKobo: bigint('reserve_price_kobo', { mode: 'bigint' }),
    buyNowPriceKobo: bigint('buy_now_price_kobo', { mode: 'bigint' }),
    opensAt: timestamp('opens_at', { withTimezone: true }).notNull(),
    /**
     * The authoritative end time. The soft close moves it; the closing job
     * re-reads it rather than trusting its own schedule (design doc §8.5).
     */
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    originalEndsAt: timestamp('original_ends_at', { withTimezone: true }).notNull(),
    extensionCount: integer('extension_count').notNull().default(0),
    status: lotStatus('status').notNull().default('draft'),
    /**
     * Increments, deposit percentage, premium, VAT and the anti-sniping window,
     * frozen onto the lot when it is scheduled. An auction's terms must not move
     * under the bidders, so the lot carries its own copy — never a live lookup.
     */
    rulesSnapshot: jsonb('rules_snapshot').notNull().$type<StoredLotRules>(),
    isDemo: boolean('is_demo').notNull().default(false),
    createdAt,
  },
  (table) => [
    uniqueIndex('lots_sale_lot_number_key').on(table.saleId, table.lotNumber),
    uniqueIndex('lots_slug_key').on(table.slug),
    // The hot query: which open lots are due to close. Partial, because the
    // answer only ever concerns open lots.
    index('lots_open_ends_at_idx')
      .on(table.endsAt)
      .where(sql`${table.status} = 'open'`),
  ],
);

export const bidEventKind = pgEnum('bid_event_kind', [
  'bid',
  'proxy_raise',
  'retraction',
  'buy_now',
  'close',
  'pause',
  'resume',
  'extend',
]);

export const bidSource = pgEnum('bid_source', ['web', 'api', 'bot', 'staff']);

/**
 * The append-only truth. Nothing here is ever UPDATEd except to mark a
 * retraction — and the retraction is itself appended as a row.
 *
 * `UNIQUE (lot_id, seq)` is what makes "exactly once, in order" a database fact
 * rather than a hope: two events can never share a sequence number, however
 * many API instances are running.
 *
 * `UNIQUE (lot_id, user_id, idempotency_key)` is the backstop for idempotency.
 * Postgres treats NULLs as distinct, so the engine's own events (close, pause)
 * carry no key and no user and are unaffected.
 */
export const bidEvents = pgTable(
  'bid_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    kind: bidEventKind('kind').notNull(),
    /** The bidder's secret maximum. Masked in every log, API response and view. */
    maxAmountKobo: bigint('max_amount_kobo', { mode: 'bigint' }),
    priceAfterKobo: bigint('price_after_kobo', { mode: 'bigint' }).notNull(),
    leaderAfterUserId: uuid('leader_after_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    idempotencyKey: text('idempotency_key'),
    /** The server clock at acceptance. The only clock that decides anything. */
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    source: bidSource('source').notNull().default('web'),
    ip: text('ip'),
    deviceId: text('device_id'),
    retractedBy: uuid('retracted_by').references(() => users.id, { onDelete: 'restrict' }),
    retractedReason: text('retracted_reason'),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('bid_events_lot_seq_key').on(table.lotId, table.seq),
    uniqueIndex('bid_events_idempotency_key').on(table.lotId, table.userId, table.idempotencyKey),
    index('bid_events_lot_id_idx').on(table.lotId, table.id),
  ],
);

/**
 * A PROJECTION, not truth. It can be deleted entirely and rebuilt by replaying
 * `bid_events` through `packages/bid-engine`, which is exactly what the Redis
 * recovery path does (design doc §8.2) and what the rebuild test asserts.
 */
export const lotState = pgTable('lot_state', {
  lotId: uuid('lot_id')
    .primaryKey()
    .references(() => lots.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull().default(0),
  priceKobo: bigint('price_kobo', { mode: 'bigint' }).notNull(),
  leaderUserId: uuid('leader_user_id').references(() => users.id, { onDelete: 'restrict' }),
  leaderMaxKobo: bigint('leader_max_kobo', { mode: 'bigint' }),
  leaderMaxSetSeq: integer('leader_max_set_seq'),
  bidCount: integer('bid_count').notNull().default(0),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  reserveMet: boolean('reserve_met').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const closureOutcome = pgEnum('closure_outcome', [
  'sold',
  'unsold_reserve',
  'no_bids',
  'cancelled',
]);

/**
 * The last line of defence for closing exactly once. `lot_id` is the primary
 * key, so even if the delayed job, the end-time re-read and the Lua
 * compare-and-set all failed at once, the second INSERT cannot succeed.
 */
export const lotClosures = pgTable('lot_closures', {
  lotId: uuid('lot_id')
    .primaryKey()
    .references(() => lots.id, { onDelete: 'restrict' }),
  closedAt: timestamp('closed_at', { withTimezone: true }).notNull(),
  winningBidEventId: bigint('winning_bid_event_id', { mode: 'bigint' }).references(
    () => bidEvents.id,
    { onDelete: 'restrict' },
  ),
  hammerPriceKobo: bigint('hammer_price_kobo', { mode: 'bigint' }).notNull(),
  outcome: closureOutcome('outcome').notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type SaleRow = typeof sales.$inferSelect;
export type LotRow = typeof lots.$inferSelect;
export type BidEventRow = typeof bidEvents.$inferSelect;
export type NewBidEventRow = typeof bidEvents.$inferInsert;
export type LotStateRow = typeof lotState.$inferSelect;
export type LotClosureRow = typeof lotClosures.$inferSelect;
