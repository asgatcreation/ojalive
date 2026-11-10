/**
 * Queue names, in one place.
 *
 * `lot-close` is the important one. A delayed job is scheduled for each lot's end
 * time, but the job is not the authority — it re-reads the database end time, and
 * a sweeper catches any job that was lost. Four layers in total, so a lot closes
 * exactly once. See docs/MILESTONE-1-DESIGN.md §8.5.
 */

export const QUEUE_NAMES = {
  /** Delayed job per lot, fired at its end time. */
  lotClose: 'lot-close',
  /** Persists accepted bid events from the Redis stream into Postgres. */
  bidPersist: 'bid-persist',
  /** Periodic: finds lots whose end time has passed but are still open. */
  stuckLotSweeper: 'stuck-lot-sweeper',
  /** Invoices, deposit refunds, second-chance offers, seller payouts. */
  settlement: 'settlement',
  /** Web push, email via Brevo, SMS via Termii. */
  notifications: 'notifications',
  /** Asserts the double-entry ledger balances. */
  ledgerCheck: 'ledger-check',
  /** Demo-only: bot bidders keeping auctions alive. Feature flagged. */
  demoBots: 'demo-bots',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * BullMQ defaults.
 *
 * `removeOnFail: false` is deliberate — a failed settlement or notification job
 * is evidence, and we want it in the dead-letter view rather than gone.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: false,
} as const;
