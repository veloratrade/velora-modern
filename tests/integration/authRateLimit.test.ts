import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

// D7: auth rate-limit behavior test. Exercises the EXISTING forgotPassword
// bucket (5 attempts / 900s per client IP) WITHOUT changing any rate-limit
// policy value. Documentation-range source IPs (RFC 5737 TEST-NET) are sent
// via x-forwarded-for so this suite is isolated from every other suite that
// shares the in-memory test limiter.
describe('Auth Rate Limiting (existing enforcement, D7)', () => {
  let app: FastifyInstance;
  const PROBE_IP = '203.0.113.7'; // TEST-NET-3
  const OTHER_IP = '198.51.100.9'; // TEST-NET-2

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  function forgot(ip: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: { 'x-forwarded-for': ip },
      payload: { email: 'ratelimit-probe@example.com' },
    });
  }

  it('allows attempts within the bucket, then rejects with 429', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await forgot(PROBE_IP);
      expect(res.statusCode).toBe(200);
    }
    const capped = await forgot(PROBE_IP);
    expect(capped.statusCode).toBe(429);
    expect(JSON.parse(capped.payload).error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('scopes buckets per client IP (other IPs unaffected)', async () => {
    const res = await forgot(OTHER_IP);
    expect(res.statusCode).toBe(200);
  });
});
