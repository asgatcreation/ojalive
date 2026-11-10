import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type OjaLiveApp } from './app.js';
import { loadApiEnv } from './env.js';

const testEnv = loadApiEnv({
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://ojalive:ojalive@localhost:55436/ojalive_test',
  REDIS_URL: 'redis://localhost:56386',
});

describe('api app', () => {
  let app: OjaLiveApp;
  let ready = true;

  beforeEach(async () => {
    ready = true;
    app = await buildApp({ env: testEnv, isReady: () => ready });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports health without touching any dependency', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'ojalive-api' });
  });

  it('reports ready when dependencies are up', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready' });
  });

  it('returns 503 from /ready while draining, so the load balancer backs off', async () => {
    ready = false;
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
  });

  it('exposes prometheus metrics for the service targets', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('ojalive_bid_ack_duration_seconds');
    expect(response.body).toContain('ojalive_bid_stream_lag');
  });

  it('sets security headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
