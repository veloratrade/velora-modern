import { describe, it, expect } from 'vitest';
import { JwtService } from '../../src/modules/auth/jwt.js';

describe('JwtService Unit Tests', () => {
  it('should sign and verify valid JWT access tokens', async () => {
    const payload = { sub: '123', role: 'user' };
    const token = await JwtService.signAccessToken(payload, 300);

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');

    const decoded = await JwtService.verifyAccessToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe('123');
    expect(decoded?.role).toBe('user');
    expect(decoded?.exp).toBeDefined();
    expect(decoded?.iat).toBeDefined();
  });

  it('should reject tampered or malformed tokens', async () => {
    const validToken = await JwtService.signAccessToken({ sub: '123', role: 'user' });
    const tampered = validToken + 'invalid';

    const decoded = await JwtService.verifyAccessToken(tampered);
    expect(decoded).toBeNull();

    const malformed = await JwtService.verifyAccessToken('invalid.token.str');
    expect(malformed).toBeNull();
  });

  it('should reject expired tokens', async () => {
    // TTL = -1 second (already expired)
    const expiredToken = await JwtService.signAccessToken({ sub: '123', role: 'user' }, -1);

    const decoded = await JwtService.verifyAccessToken(expiredToken);
    expect(decoded).toBeNull();
  });
});
