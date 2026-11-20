/**
 * Broadcasting deltas by tailing each lot's event stream.
 *
 * The obvious design is "whoever accepted the bid emits it", with the Redis
 * adapter fanning the emit out to the other instances. This does not do that,
 * for one reason that matters: the API is not the only thing that changes a
 * lot. The worker closes lots. A lot closed by a worker has to reach watchers
 * too, and the worker is not a Socket.IO server.
 *
 * So every instance tails the streams of the lots its own sockets are watching,
 * and emits what it reads to its own sockets. Whoever wrote to the stream — an
 * API instance accepting a bid, or the worker closing a lot — gets broadcast
 * for free, through one path. `seq` stays the single ordering authority, and
 * there is no second delivery mechanism to disagree with it.
 *
 * It also means a delta is never emitted for a bid that failed to reach the
 * stream, because the stream append is what makes it real.
 */

import type { Redis } from 'ioredis';
import type { RealtimeLogger } from './logging.js';
import { lotStreamKey, parseStreamEntry, toPublicEvent, type PublicLotEvent } from '@ojalive/live';

export interface TailerOptions {
  /** How long to block on Redis waiting for new entries. */
  readonly blockMillis?: number;
  readonly batchSize?: number;
}

export type DeltaHandler = (lotId: string, events: readonly PublicLotEvent[]) => void;

/**
 * Tails one lot. Returns a function that stops it.
 *
 * It uses its own blocking connection: `XREAD BLOCK` occupies a connection for
 * the duration, so sharing one with the rest of the API would stall every other
 * command behind it.
 */
export class LotTailer {
  private stopped = false;
  private lastSeq: number;
  private readonly connection: Redis;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    redis: Redis,
    private readonly lotId: string,
    fromSeq: number,
    private readonly onDeltas: DeltaHandler,
    private readonly logger: RealtimeLogger,
    private readonly options: TailerOptions = {},
  ) {
    this.lastSeq = fromSeq;
    // `duplicate()` copies the connection options, including the URL, without
    // sharing the socket.
    this.connection = redis.duplicate();
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Interrupt the blocking read rather than waiting out its timeout.
    this.connection.disconnect();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const reply = await this.connection.xread(
          'COUNT',
          this.options.batchSize ?? 200,
          'BLOCK',
          this.options.blockMillis ?? 2_000,
          'STREAMS',
          lotStreamKey(this.lotId),
          `${String(this.lastSeq)}-0`,
        );
        if (this.stopped) return;
        if (reply === null) continue;

        const events: PublicLotEvent[] = [];
        for (const [, entries] of reply) {
          for (const [id, fields] of entries) {
            const event = parseStreamEntry(this.lotId, id, fields);
            // Strictly increasing, so a redelivery or an out-of-order read can
            // never make a client apply the same seq twice.
            if (event.seq <= this.lastSeq) continue;
            this.lastSeq = event.seq;
            events.push(toPublicEvent(event));
          }
        }

        if (events.length > 0) this.onDeltas(this.lotId, events);
      } catch (error: unknown) {
        if (this.stopped) return;
        this.logger.warn({ lotId: this.lotId, error }, 'lot tailer read failed; retrying');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}

/**
 * One tailer per lot that anybody here is watching, started on the first
 * watcher and stopped after the last one leaves.
 *
 * Reference counted, because a thousand watchers of one lot should cost one
 * blocking connection, not a thousand.
 */
export class TailerRegistry {
  private readonly tailers = new Map<string, { tailer: LotTailer; watchers: number }>();

  constructor(
    private readonly redis: Redis,
    private readonly onDeltas: DeltaHandler,
    private readonly logger: RealtimeLogger,
    private readonly options: TailerOptions = {},
  ) {}

  /** Start tailing from `fromSeq` if this is the first watcher of the lot. */
  acquire(lotId: string, fromSeq: number): void {
    const existing = this.tailers.get(lotId);
    if (existing !== undefined) {
      existing.watchers += 1;
      return;
    }
    const tailer = new LotTailer(
      this.redis,
      lotId,
      fromSeq,
      this.onDeltas,
      this.logger,
      this.options,
    );
    this.tailers.set(lotId, { tailer, watchers: 1 });
    tailer.start();
  }

  async release(lotId: string): Promise<void> {
    const existing = this.tailers.get(lotId);
    if (existing === undefined) return;
    existing.watchers -= 1;
    if (existing.watchers > 0) return;
    this.tailers.delete(lotId);
    await existing.tailer.stop();
  }

  lots(): string[] {
    return [...this.tailers.keys()];
  }

  async stopAll(): Promise<void> {
    const all = [...this.tailers.values()].map((entry) => entry.tailer.stop());
    this.tailers.clear();
    await Promise.all(all);
  }
}
