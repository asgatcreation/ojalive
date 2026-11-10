/**
 * Time rules for Ojà Live:
 *
 *   - Stored and compared in UTC, always, as epoch milliseconds or Date.
 *   - Displayed in Africa/Lagos, always.
 *   - The SERVER clock decides when a lot closes. Client clocks are advisory
 *     and are corrected against the server (see docs/MILESTONE-1-DESIGN.md §7.6).
 */

export const DISPLAY_TIME_ZONE = 'Africa/Lagos';

/** Epoch milliseconds, UTC. The only time representation the bid engine accepts. */
export type EpochMillis = number;

/**
 * A clock, so that closing logic and anti-sniping can be tested with a fake one
 * instead of `setTimeout` and hope.
 */
export interface Clock {
  now(): EpochMillis;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** A clock you control, for deterministic tests of soft close and closing. */
export function fakeClock(startAt: EpochMillis): Clock & {
  advance(millis: number): void;
  set(at: EpochMillis): void;
} {
  let current = startAt;
  return {
    now: () => current,
    advance(millis: number) {
      current += millis;
    },
    set(at: EpochMillis) {
      current = at;
    },
  };
}

const lagosFormatter = new Intl.DateTimeFormat('en-NG', {
  timeZone: DISPLAY_TIME_ZONE,
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Format an instant for a Nigerian reader. */
export function formatLagos(at: EpochMillis | Date): string {
  return lagosFormatter.format(at instanceof Date ? at : new Date(at));
}

/** Human countdown text: `2d 4h`, `6h 12m`, `4m 09s`, `12s`. */
export function formatCountdown(millisRemaining: number): string {
  if (millisRemaining <= 0) return 'Closed';
  const totalSeconds = Math.floor(millisRemaining / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
