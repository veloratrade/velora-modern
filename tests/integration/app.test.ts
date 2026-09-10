import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('Fastify Application Scaffolding', () => {
  const app = buildApp();

  beforeAll(async () => {
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
    expect(body.version).toBe('0.6.0');
    expect(body.environment).toBeDefined();
    expect(body.timestamp).toBeDefined();
    expect(body.uptime).toBeTypeOf('number');
    expect(body.dependencies).toBeDefined();
  });

  it('GET /health should apply security headers via helmet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-dns-prefetch-control']).toBe('off');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('GET /health should assign or echo x-request-id correlation header', async () => {
    const customRequestId = 'test-request-id-12345';
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        'x-request-id': customRequestId,
      },
    });

    expect(response.headers['x-request-id']).toBe(customRequestId);
  });
});
