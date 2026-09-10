import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';

describe('Auth Module Integration Tests', () => {
  const app = buildApp();
  const authService = new AuthService();

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    AuthService.clearMemoryStore();
  });

  it('POST /api/v1/auth/register should create unverified user and return verificationRequired', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'trader@example.com',
        password: 'SecurePass123',
        fullName: 'Jane Trader',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.verificationRequired).toBe(true);
    expect(body.email).toBe('trader@example.com');
  });

  it('POST /api/v1/auth/register should handle duplicate unverified email by resending verification', async () => {
    // 1. First registration
    await authService.register(
      {
        email: 'duplicate-unverified@example.com',
        password: 'SecurePass123',
        fullName: 'Trader One',
      },
      '127.0.0.1',
    );

    // 2. Second registration with same email before verification
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'duplicate-unverified@example.com',
        password: 'AnotherPass123',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.verificationRequired).toBe(true);
    expect(body.messageKey).toBe('auth.verificationResent');
  });

  it('POST /api/v1/auth/register should reject duplicate email when user is already verified', async () => {
    // Register user and simulate verified email state
    await authService.register(
      { email: 'verified-dup@example.com', password: 'SecurePass123', fullName: 'Verified Trader' },
      '127.0.0.1',
    );

    AuthService.verifyUserForTest('verified-dup@example.com');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'verified-dup@example.com',
        password: 'NewSecurePass123',
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('POST /api/v1/auth/verify-email should handle invalid verification token', async () => {
    const resInvalid = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-email',
      payload: { token: 'invalid_token_str' },
    });

    expect(resInvalid.statusCode).toBe(401);
    const body = JSON.parse(resInvalid.payload);
    expect(body.code).toBe('VERIFICATION_LINK_INVALID');
  });

  it('POST /api/v1/auth/login should reject unverified email', async () => {
    await authService.register(
      {
        email: 'unverified-login@example.com',
        password: 'SecurePass123',
        fullName: 'Unverified User',
      },
      '127.0.0.1',
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'unverified-login@example.com',
        password: 'SecurePass123',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('POST /api/v1/auth/login should reject invalid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: 'nonexistent@example.com',
        password: 'WrongPassword123',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /api/v1/auth/forgot-password & reset-password flow', async () => {
    // 1. Forgot password for non-existent email returns anti-enumeration response
    const forgotRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'reset@example.com' },
    });

    expect(forgotRes.statusCode).toBe(200);
    expect(JSON.parse(forgotRes.payload).sent).toBe(true);

    // 2. Reset password with invalid token throws 400
    const resetRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: {
        token: 'invalid_token',
        newPassword: 'NewPassword123',
      },
    });

    expect(resetRes.statusCode).toBe(400);
    const body = JSON.parse(resetRes.payload);
    expect(body.code).toBe('VALIDATION_FAILED');
  });

  it('GET /api/v1/auth/me should return 401 when token is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('ACCESS_TOKEN_MISSING');
  });
});
