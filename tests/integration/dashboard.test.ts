import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { TradeRepository } from '../../src/modules/trades/trades.repository.js';

describe('Dashboard Module Integration Tests', () => {
  let app: FastifyInstance;
  let authService: AuthService;
  let user1Token: string;

  beforeEach(async () => {
    AuthService.clearMemoryStore();
    TradeRepository.clearMemoryStore();
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
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/dashboard/summary', () => {
    it('should compute exact trading metrics and equity curve', async () => {
      // Create 2 winning trades and 1 losing trade for User 1
      await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          symbol: 'EURUSD',
          direction: 'buy',
          entryPrice: '1.1000',
          exitPrice: '1.1050', // +500 gross pnl
          volume: '1.0',
          contractSize: '100000',
          commission: '5.00',
          swap: '0.00',
          stopLoss: '1.0970',
          openTime: '2026-09-08 10:00:00',
          closeTime: '2026-09-08 12:00:00',
          strategyTag: 'Breakout',
        },
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          symbol: 'GBPUSD',
          direction: 'sell',
          entryPrice: '1.3000',
          exitPrice: '1.3050', // -250 gross pnl (losing trade)
          volume: '0.5',
          contractSize: '100000',
          commission: '2.50',
          swap: '0.00',
          stopLoss: '1.2950',
          openTime: '2026-09-09 10:00:00',
          closeTime: '2026-09-09 12:00:00',
          strategyTag: 'MeanReversion',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/summary',
        headers: { authorization: `Bearer ${user1Token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(body.data.summary.tradeCount).toBe(2);
      expect(body.data.summary.wins).toBe(1);
      expect(body.data.summary.losses).toBe(1);
      expect(body.data.summary.winRate).toBe('0.5000');
      expect(parseFloat(body.data.summary.totalPnl)).toBeGreaterThan(0);
      expect(body.data.summary.equityCurve).toBeDefined();
    });
  });

  describe('GET /api/v1/dashboard/equity-curve', () => {
    it('should retrieve daily equity curve points', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/equity-curve?days=30',
        headers: { authorization: `Bearer ${user1Token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(Array.isArray(body.data.equityCurve)).toBe(true);
    });
  });

  describe('GET /api/v1/dashboard/strategies', () => {
    it('should aggregate performance grouped by strategy tag', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          symbol: 'EURUSD',
          direction: 'buy',
          entryPrice: '1.1000',
          exitPrice: '1.1050',
          volume: '1.0',
          openTime: '2026-09-08 10:00:00',
          closeTime: '2026-09-08 12:00:00',
          strategyTag: 'TrendFollowing',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/dashboard/strategies',
        headers: { authorization: `Bearer ${user1Token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(Array.isArray(body.data.strategies)).toBe(true);
      expect(body.data.strategies[0].strategy).toBe('TrendFollowing');
      expect(body.data.strategies[0].winRate).toBe('1.0000');
    });
  });
});
