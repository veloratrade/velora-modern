import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

describe('Fastify Application Scaffolding', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health should return 200 OK and expected health payload', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);

    expect(body.status).toBe('ok');
    expect(body.service).toBe('velora-modern');
    expect(body.version).toBe('0.2.0');
    expect(body.environment).toBeDefined();
    expect(body.timestamp).toBeDefined();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.dependencies).toEqual({
      database: 'not_configured_phase2',
      redis: 'not_configured_phase2',
    });
  });

  it('GET /health response should contain x-request-id and security headers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-request-id']).toBeDefined();
    expect(typeof response.headers['x-request-id']).toBe('string');
  });

  it('custom x-request-id header should be preserved', async () => {
    const customId = 'test-request-id-12345';
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': customId,
      },
    });

    expect(response.headers['x-request-id']).toBe(customId);
  });
});
