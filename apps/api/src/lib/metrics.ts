import { collectDefaultMetrics, Histogram, Counter, Gauge, Registry } from 'prom-client';

/**
 * The metrics behind the service targets in docs/MILESTONE-1-DESIGN.md §5.
 *
 * Buckets are chosen around the targets themselves (p95 < 150 ms, p99 < 300 ms),
 * so the histogram has resolution exactly where we need to read it.
 */
export const registry = new Registry();

registry.setDefaultLabels({ app: 'ojalive-api' });
collectDefaultMetrics({ register: registry });

export const bidAckDuration = new Histogram({
  name: 'ojalive_bid_ack_duration_seconds',
  help: 'Server-side time from receiving a bid to acknowledging it',
  labelNames: ['outcome'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2],
  registers: [registry],
});

export const bidsAccepted = new Counter({
  name: 'ojalive_bids_accepted_total',
  help: 'Bids accepted by the engine',
  registers: [registry],
});

export const bidsRejected = new Counter({
  name: 'ojalive_bids_rejected_total',
  help: 'Bids rejected, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const connectedSockets = new Gauge({
  name: 'ojalive_connected_sockets',
  help: 'Currently connected Socket.IO clients on this instance',
  registers: [registry],
});

export const bidStreamLag = new Gauge({
  name: 'ojalive_bid_stream_lag',
  help: 'Accepted bid events not yet persisted to Postgres (durability risk window)',
  registers: [registry],
});
