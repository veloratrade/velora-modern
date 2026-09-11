import { readFileSync } from 'fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app.js';

// D9: the ONLY authoritative application version is package.json "version".
// This test derives it the same way operators do — never a hardcoded duplicate.
const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  }
).version;

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
    // D9: /health MUST report the authoritative package.json version, which is
    // also what the smoke suite compares against — equality means the
    // version-drift detector stays quiet (no false drift warning).
    expect(body.version).toBe(PACKAGE_VERSION);
    expect(body.environment).toBeDefined();
    expect(body.timestamp).toBeDefined();
    expect(body.uptime).toBeTypeOf('number');
    expect(body.dependencies).toBeDefined();
  });

  it('GET /health should emit the owner-approved security-header contract (D16)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    const h = response.headers;
    // D16 owner-approved values (2026-09-12), asserted on ACTUAL response
    // headers — never on configuration objects. Matches SECURITY §13.
    expect(h['x-content-type-options']).toBe('nosniff'); // §13 ✓ (unchanged)
    expect(h['x-dns-prefetch-control']).toBe('off'); // unchanged
    expect(h['x-frame-options']).toBe('DENY'); // D16 approved
    expect(h['x-xss-protection']).toBe('0'); // §13 ✓ (unchanged)
    expect(h['strict-transport-security']).toBe('max-age=31536000; includeSubDomains'); // D16 approved
    expect(h['cache-control']).toBe('no-store, max-age=0, private'); // D16 approved
    // CSP is production-only by design (the API-only surface has no HTML
    // subject); in test env the header MUST be absent. This is independent
    // of secret scanning — secret scanning is not CSP.
    expect(h['content-security-policy']).toBeUndefined();
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
