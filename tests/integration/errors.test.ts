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

  it('404 for unknown routes should return structured JSON error envelope', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/non-existent-route',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.payload);

    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(404);
    expect(body.code).toBeDefined();
    expect(body.error).toBeDefined();
  });

  it('known application errors should return custom status code and code', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test-error',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);

    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(400);
    expect(body.code).toBe('TEST_BAD_REQUEST');
    expect(body.error).toBe('Test application error');
  });
});
