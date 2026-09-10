import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { AccountRepository } from '../../src/modules/accounts/accounts.repository.js';

describe('Accounts Module Integration Tests', () => {
  let app: FastifyInstance;
  let authService: AuthService;
  let user1Token: string;
  let user2Token: string;

  beforeEach(async () => {
    AuthService.clearMemoryStore();
    AccountRepository.clearMemoryStore();
    authService = new AuthService();
    app = buildApp();
    await app.ready();

    // Register & Login User 1
    await authService.register({
      email: 'trader1@velora.test',
      password: 'Password123!',
      fullName: 'Trader One',
    });
    AuthService.verifyUserForTest('trader1@velora.test');
    const login1 = await authService.login(
      { email: 'trader1@velora.test', password: 'Password123!' },
      '127.0.0.1',
    );
    user1Token = login1.accessToken;
    AuthService.setUserPlanInMemory(login1.user.id, 'pro');

    // Register & Login User 2
    await authService.register({
      email: 'trader2@velora.test',
      password: 'Password123!',
      fullName: 'Trader Two',
    });
    AuthService.verifyUserForTest('trader2@velora.test');
    const login2 = await authService.login(
      { email: 'trader2@velora.test', password: 'Password123!' },
      '127.0.0.1',
    );
    user2Token = login2.accessToken;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/accounts — List Accounts', () => {
    it('should list trading accounts for authenticated user', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${user1Token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(Array.isArray(body.data.accounts)).toBe(true);
      expect(body.data.accounts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('POST /api/v1/accounts — Create Account', () => {
    it('should create a valid manual trading account', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          provider: 'MT4',
          label: 'Primary Forex Account',
          accountNumber: '5001234',
          currency: 'USD',
          leverage: '1:100',
          timezone: 'Asia/Tehran',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(body.data.account.provider).toBe('MT4');
      expect(body.data.account.currency).toBe('USD');
      expect(body.data.account.timezone).toBe('Asia/Tehran');
    });

    it('should reject invalid currency format', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          provider: 'MANUAL',
          currency: 'INVALID_CURRENCY',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('POST /api/v1/accounts/detect-server — Server Auto-Detection', () => {
    it('should detect suggested servers for login starting with 6', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts/detect-server',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: { mt_login: '6543210' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(body.data.mt_login).toBe('6543210');
      expect(body.data.suggestedServers).toContain('Exness-Demo');
    });

    it('should reject non-numeric login format for server detection', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts/detect-server',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: { mt_login: 'abc_invalid' },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PATCH /api/v1/accounts/:id/timezone — Timezone Update', () => {
    it('should update account timezone to valid IANA string', async () => {
      // First list accounts to get user 1 account ID
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${user1Token}` },
      });
      const accountId = listRes.json().data.accounts[0].id;

      const patchRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/accounts/${accountId}/timezone`,
        headers: { authorization: `Bearer ${user1Token}` },
        payload: { timezone: 'Europe/London' },
      });

      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json().data.account.timezone).toBe('Europe/London');
    });
  });

  describe('Ownership Security Isolation', () => {
    it('should prevent User 2 from deleting User 1 account', async () => {
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${user1Token}` },
      });
      const accountId = listRes.json().data.accounts[0].id;

      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/accounts/${accountId}`,
        headers: { authorization: `Bearer ${user2Token}` },
      });

      expect(delRes.statusCode).toBe(404);
      expect(delRes.json().error.code).toBe('NOT_FOUND');
    });
  });
});
