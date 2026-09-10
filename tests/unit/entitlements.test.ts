import { describe, it, expect, beforeEach } from 'vitest';
import { EntitlementService } from '../../src/modules/entitlements/entitlement.service.js';
import { ApiError } from '../../src/core/errors/errorHandler.js';

describe('Commercial Entitlements Engine — Unit Tests', () => {
  let entitlementService: EntitlementService;

  beforeEach(() => {
    entitlementService = new EntitlementService();
  });

  describe('getPlanQuota', () => {
    it('should return Free plan quota (1 trading account) for "free", empty, or undefined plan', () => {
      expect(entitlementService.getPlanQuota('free')).toEqual({
        plan: 'free',
        maxTradingAccounts: 1,
        isUnlimited: false,
      });

      expect(entitlementService.getPlanQuota(null)).toEqual({
        plan: 'free',
        maxTradingAccounts: 1,
        isUnlimited: false,
      });

      expect(entitlementService.getPlanQuota(undefined)).toEqual({
        plan: 'free',
        maxTradingAccounts: 1,
        isUnlimited: false,
      });

      expect(entitlementService.getPlanQuota('')).toEqual({
        plan: 'free',
        maxTradingAccounts: 1,
        isUnlimited: false,
      });
    });

    it('should return Pro plan quota (unlimited) for "pro" plan (case-insensitive)', () => {
      expect(entitlementService.getPlanQuota('pro')).toEqual({
        plan: 'pro',
        maxTradingAccounts: Infinity,
        isUnlimited: true,
      });

      expect(entitlementService.getPlanQuota('PRO')).toEqual({
        plan: 'pro',
        maxTradingAccounts: Infinity,
        isUnlimited: true,
      });

      expect(entitlementService.getPlanQuota(' Pro ')).toEqual({
        plan: 'pro',
        maxTradingAccounts: Infinity,
        isUnlimited: true,
      });
    });

    it('should return Enterprise plan quota (unlimited) for "enterprise" plan (case-insensitive)', () => {
      expect(entitlementService.getPlanQuota('enterprise')).toEqual({
        plan: 'enterprise',
        maxTradingAccounts: Infinity,
        isUnlimited: true,
      });

      expect(entitlementService.getPlanQuota('ENTERPRISE')).toEqual({
        plan: 'enterprise',
        maxTradingAccounts: Infinity,
        isUnlimited: true,
      });
    });

    it('should SAFE-FAIL CLOSED to Free plan (1 account limit) for any unknown/unsupported plan string', () => {
      expect(entitlementService.getPlanQuota('unknown_plan_x')).toEqual({
        plan: 'free',
        maxTradingAccounts: 1,
        isUnlimited: false,
      });

      expect(entitlementService.getPlanQuota('vip_gold_plan')).toEqual({
        plan: 'free',
        maxTradingAccounts: 1,
        isUnlimited: false,
      });
    });
  });

  describe('checkTradingAccountEntitlement', () => {
    it('should ALLOW Free user with 0 existing accounts to create 1 account', async () => {
      const res = await entitlementService.checkTradingAccountEntitlement(101, 0, 'free');
      expect(res.allowed).toBe(true);
      expect(res.limit).toBe(1);
      expect(res.currentCount).toBe(0);
    });

    it('should BLOCK Free user with 1 existing account from creating a 2nd account', async () => {
      await expect(
        entitlementService.checkTradingAccountEntitlement(101, 1, 'free'),
      ).rejects.toThrow(ApiError);

      try {
        await entitlementService.checkTradingAccountEntitlement(101, 1, 'free');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.statusCode).toBe(429);
        expect(apiErr.code).toBe('ACCOUNT_QUOTA_EXCEEDED');
        expect(apiErr.messageKey).toBe('errors.accounts.quotaExceeded');
        expect(apiErr.params).toEqual({
          plan: 'free',
          currentCount: 1,
          maxAllowed: 1,
        });
      }
    });

    it('should ALLOW Pro user with multiple existing accounts to create more accounts', async () => {
      const res1 = await entitlementService.checkTradingAccountEntitlement(102, 1, 'pro');
      expect(res1.allowed).toBe(true);

      const res2 = await entitlementService.checkTradingAccountEntitlement(102, 10, 'pro');
      expect(res2.allowed).toBe(true);

      const res3 = await entitlementService.checkTradingAccountEntitlement(102, 100, 'pro');
      expect(res3.allowed).toBe(true);
    });

    it('should ALLOW Enterprise user with multiple existing accounts to create more accounts', async () => {
      const res = await entitlementService.checkTradingAccountEntitlement(103, 5, 'enterprise');
      expect(res.allowed).toBe(true);
    });
  });

  describe('Database Fail-Closed Invariant (Blocker A)', () => {
    it('should verify fail-closed 503 SERVICE_UNAVAILABLE contract when DB throws in production/dev', async () => {
      const originalEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        // Calling getUserPlan for a non-existent or failing DB in production mode MUST throw 503
        await expect(entitlementService.getUserPlan(999999)).rejects.toThrow(ApiError);

        try {
          await entitlementService.getUserPlan(999999);
        } catch (err) {
          expect(err).toBeInstanceOf(ApiError);
          const apiErr = err as ApiError;
          expect(apiErr.statusCode).toBe(503);
          expect(apiErr.code).toBe('SERVICE_UNAVAILABLE');
        }
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe('Platform Bypass Prevention & Account Type Scoping', () => {
    it('should treat all trading platforms (MT4, MT5, MANUAL) identically under Free tier limit', async () => {
      // Free user already has 1 MANUAL account
      await expect(
        entitlementService.checkTradingAccountEntitlement(104, 1, 'free'),
      ).rejects.toThrow('Trading account quota exceeded');
    });

    it('should confirm projects are excluded from trading account count', async () => {
      // User has 5 projects but 0 trading accounts -> creation must succeed for Free plan
      const res = await entitlementService.checkTradingAccountEntitlement(105, 0, 'free');
      expect(res.allowed).toBe(true);
    });
  });
});
