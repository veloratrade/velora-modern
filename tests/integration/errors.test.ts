import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';

describe('Error Handling Scaffolding', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();

    // Register a test route that triggers a 400 error
    app.get('/test-error', async () => {
      const err = new Error('Test application error') as Error & {
        statusCode?: number;
        code?: string;
      };
      err.statusCode = 400;
      err.code = 'TEST_BAD_REQUEST';
      throw err;
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('404 for unknown routes should return structured PHP-compatible JSON error envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/non-existent-route',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.payload);

    expect(body.status).toBe('error');
    expect(body.data).toBeNull();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBeDefined();
    expect(body.error.message).toBeDefined();
    expect(body.error.messageKey).toBeDefined();
    expect(body.timestamp).toBeDefined();
  });

  it('known application errors should return PHP-compatible error envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-error',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);

    expect(body.status).toBe('error');
    expect(body.data).toBeNull();
    expect(body.error.code).toBe('TEST_BAD_REQUEST');
    expect(body.error.message).toBe('Test application error');
    expect(body.error.messageKey).toBeDefined();
    expect(body.timestamp).toBeDefined();
  });
});
