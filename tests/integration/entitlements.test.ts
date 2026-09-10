import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { AccountRepository } from '../../src/modules/accounts/accounts.repository.js';

describe('Commercial Entitlements Module — Integration Tests', () => {
  let app: FastifyInstance;
  let authService: AuthService;
  let freeUserToken: string;
  let freeUserId: number;
  let proUserToken: string;

  beforeEach(async () => {
    AuthService.clearMemoryStore();
    AccountRepository.clearMemoryStore();
    authService = new AuthService();
    app = buildApp();
    await app.ready();

    // Register Free User
    await authService.register({
      email: 'freeuser@velora.test',
      password: 'Password123!',
      fullName: 'Free Trader',
    });
    AuthService.verifyUserForTest('freeuser@velora.test');
    const freeLogin = await authService.login(
      { email: 'freeuser@velora.test', password: 'Password123!' },
      '127.0.0.1',
    );
    freeUserToken = freeLogin.accessToken;
    freeUserId = freeLogin.user.id;

    // Clear initial default memory accounts for clean state in tests
    AccountRepository.clearMemoryStore();
    const existingAccounts = await new AccountRepository().listByUser(freeUserId);
    for (const acc of existingAccounts) {
      await new AccountRepository().delete(acc.id, freeUserId);
    }

    // Register Pro User
    await authService.register({
      email: 'prouser@velora.test',
      password: 'Password123!',
      fullName: 'Pro Trader',
    });
    AuthService.verifyUserForTest('prouser@velora.test');
    const proLogin = await authService.login(
      { email: 'prouser@velora.test', password: 'Password123!' },
      '127.0.0.1',
    );
    proUserToken = proLogin.accessToken;
    const proUserId = proLogin.user.id;

    // Set user plan to 'pro'
    AuthService.setUserPlanInMemory(proUserId, 'pro');
  });

  afterEach(async () => {
    await app.close();
  });

  describe('Blocker B — Atomic Concurrency Quota Safety', () => {
    it('should safely serialize concurrent account creation requests and enforce exactly 1 account limit', async () => {
      // Free user starts with 0 accounts
      const initialAccounts = await new AccountRepository().listByUser(freeUserId);
      expect(initialAccounts.length).toBe(0);

      // Launch two simultaneous account-creation requests concurrently
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: '/api/v1/accounts',
          headers: { authorization: `Bearer ${freeUserToken}` },
          payload: { provider: 'MANUAL', label: 'Concurrent Account A', currency: 'USD' },
        }),
        app.inject({
          method: 'POST',
          url: '/api/v1/accounts',
          headers: { authorization: `Bearer ${freeUserToken}` },
          payload: { provider: 'MT4', label: 'Concurrent Account B', currency: 'USD' },
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      // Exactly ONE request must succeed (201 Created) and the other MUST fail with HTTP 429 (ACCOUNT_QUOTA_EXCEEDED)
      expect(statusCodes).toEqual([201, 429]);

      const failedRes = res1.statusCode === 429 ? res1 : res2;
      const failedBody = failedRes.json();
      expect(failedBody.status).toBe('error');
      expect(failedBody.error.code).toBe('ACCOUNT_QUOTA_EXCEEDED');
      expect(failedBody.error.messageKey).toBe('errors.accounts.quotaExceeded');

      // Verify database / store state: EXACTLY 1 trading account exists for the Free user
      const finalAccounts = await new AccountRepository().listByUser(freeUserId);
      expect(finalAccounts.length).toBe(1);
    });
  });

  describe('Free Plan Quota Enforcement (Exactly 1 Trading Account)', () => {
    it('should ALLOW Free user to create 1st trading account', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${freeUserToken}` },
        payload: {
          provider: 'MANUAL',
          label: 'Free Account 1',
          currency: 'USD',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(body.data.account.label).toBe('Free Account 1');
    });

    it('should BLOCK Free user from creating 2nd trading account with HTTP 429', async () => {
      // Create 1st account
      const firstRes = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${freeUserToken}` },
        payload: {
          provider: 'MANUAL',
          label: 'Free Account 1',
          currency: 'USD',
        },
      });
      expect(firstRes.statusCode).toBe(201);

      // Attempt 2nd account
      const secondRes = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${freeUserToken}` },
        payload: {
          provider: 'MT4',
          label: 'Free Account 2 Attempt',
          currency: 'USD',
        },
      });

      expect(secondRes.statusCode).toBe(429);
      const body = secondRes.json();
      expect(body.status).toBe('error');
      expect(body.error.code).toBe('ACCOUNT_QUOTA_EXCEEDED');
      expect(body.error.messageKey).toBe('errors.accounts.quotaExceeded');
    });
  });

  describe('Pro Plan Unlimited Account Entitlement', () => {
    it('should ALLOW Pro user to create multiple trading accounts across platforms', async () => {
      const acc1 = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${proUserToken}` },
        payload: { provider: 'MANUAL', label: 'Pro Manual', currency: 'USD' },
      });
      expect(acc1.statusCode).toBe(201);

      const acc2 = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${proUserToken}` },
        payload: { provider: 'MT4', label: 'Pro MT4', currency: 'EUR' },
      });
      expect(acc2.statusCode).toBe(201);

      const acc3 = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${proUserToken}` },
        payload: { provider: 'MT5', label: 'Pro MT5', currency: 'GBP' },
      });
      expect(acc3.statusCode).toBe(201);
    });
  });

  describe('Provider Quota & Platform Bypass Prevention (MANUAL, MT4, MT5)', () => {
    it('should enforce limit across all platforms: MANUAL succeeds, then MT4 & MT5 fail with 429', async () => {
      // 1. Free creates MANUAL -> succeeds
      const manualRes = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${freeUserToken}` },
        payload: { provider: 'MANUAL', label: 'Manual Account' },
      });
      expect(manualRes.statusCode).toBe(201);

      // 2. Free attempts MT4 -> fails with 429
      const mt4Res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${freeUserToken}` },
        payload: { provider: 'MT4', label: 'MT4 Bypass Attempt' },
      });
      expect(mt4Res.statusCode).toBe(429);
      expect(mt4Res.json().error.code).toBe('ACCOUNT_QUOTA_EXCEEDED');

      // 3. Free attempts MT5 -> fails with 429
      const mt5Res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        headers: { authorization: `Bearer ${freeUserToken}` },
        payload: { provider: 'MT5', label: 'MT5 Bypass Attempt' },
      });
      expect(mt5Res.statusCode).toBe(429);
      expect(mt5Res.json().error.code).toBe('ACCOUNT_QUOTA_EXCEEDED');
    });
  });

  describe('Authentication & Security', () => {
    it('should reject unauthenticated requests to create account', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/accounts',
        payload: { provider: 'MANUAL', label: 'Unauthenticated' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('ACCESS_TOKEN_MISSING');
    });
  });
});
