import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../../src/app.js';
import { FastifyInstance } from 'fastify';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { TradeRepository } from '../../src/modules/trades/trades.repository.js';

describe('Core Trading & Journaling Engine Integration Tests', () => {
  let app: FastifyInstance;
  let authService: AuthService;
  let user1Token: string;
  let user2Token: string;

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

  describe('POST /api/v1/trades — Trade Creation', () => {
    it('should create a valid manual Buy trade and calculate financial metrics', async () => {
      const payload = {
        symbol: 'EURUSD',
        direction: 'buy',
        entryPrice: '1.1000',
        exitPrice: '1.1050',
        volume: '1.0',
        contractSize: '100000',
        commission: '5.00',
        swap: '1.50',
        stopLoss: '1.0970',
        openTime: '2026-09-10 10:00:00',
        closeTime: '2026-09-10 12:00:00',
        strategyTag: 'Breakout',
        emotionalScore: 4,
        notes: 'Clean H1 breakout trade',
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(body.data.symbol).toBe('EURUSD');
      expect(body.data.direction).toBe('buy');
      expect(body.data.entryPrice).toBe('1.1');
      expect(body.data.exitPrice).toBe('1.105');
      expect(body.data.volume).toBe('1');
      expect(body.data.profitLoss).toBe('493.5');
      expect(body.data.rMultiple).toBe('1.645');
      expect(body.data.strategyTag).toBe('Breakout');
      expect(body.data.emotionalScore).toBe(4);
    });

    it('should reject trade creation without authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        payload: {
          symbol: 'EURUSD',
          direction: 'buy',
          entryPrice: '1.1000',
          exitPrice: '1.1050',
          volume: '1.0',
          openTime: '2026-09-10 10:00:00',
          closeTime: '2026-09-10 12:00:00',
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.status).toBe('error');
      expect(body.error.code).toBe('ACCESS_TOKEN_MISSING');
    });

    it('should reject trade with closeTime preceding openTime', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          symbol: 'EURUSD',
          direction: 'buy',
          entryPrice: '1.1000',
          exitPrice: '1.1050',
          volume: '1.0',
          openTime: '2026-09-10 14:00:00',
          closeTime: '2026-09-10 12:00:00', // Chronology error!
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.status).toBe('error');
      expect(body.error.code).toBe('VALIDATION_FAILED');
    });

    it('should reject trade referencing an account not owned by user', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          symbol: 'EURUSD',
          direction: 'buy',
          entryPrice: '1.1000',
          exitPrice: '1.1050',
          volume: '1.0',
          accountId: 9999, // Unowned account!
          openTime: '2026-09-10 10:00:00',
          closeTime: '2026-09-10 12:00:00',
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.status).toBe('error');
      expect(body.error.messageKey).toBe('errors.trades.accountNotOwned');
    });
  });

  describe('GET /api/v1/trades — Search & Pagination', () => {
    it('should retrieve user trades with pagination and filters', async () => {
      // Create 2 trades for User 1
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
          openTime: '2026-09-10 10:00:00',
          closeTime: '2026-09-10 12:00:00',
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
          exitPrice: '1.2950',
          volume: '0.5',
          openTime: '2026-09-10 11:00:00',
          closeTime: '2026-09-10 13:00:00',
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/trades?symbol=EURUSD',
        headers: { authorization: `Bearer ${user1Token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('success');
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].symbol).toBe('EURUSD');
      expect(body.data.pagination.total).toBe(1);
    });
  });

  describe('Ownership Security Isolation', () => {
    it('should prevent User 2 from accessing User 1 trade', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          symbol: 'EURUSD',
          direction: 'buy',
          entryPrice: '1.1000',
          exitPrice: '1.1050',
          volume: '1.0',
          openTime: '2026-09-10 10:00:00',
          closeTime: '2026-09-10 12:00:00',
        },
      });
      const tradeId = createRes.json().data.id;

      // Attempt GET by User 2
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/v1/trades/${tradeId}`,
        headers: { authorization: `Bearer ${user2Token}` },
      });

      expect(getRes.statusCode).toBe(404);
      expect(getRes.json().error.code).toBe('NOT_FOUND');

      // Attempt PUT by User 2
      const putRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/trades/${tradeId}`,
        headers: { authorization: `Bearer ${user2Token}` },
        payload: { volume: '2.0' },
      });

      expect(putRes.statusCode).toBe(404);

      // Attempt DELETE by User 2
      const delRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/trades/${tradeId}`,
        headers: { authorization: `Bearer ${user2Token}` },
      });

      expect(delRes.statusCode).toBe(404);
    });
  });

  describe('Partial Exits (/api/v1/trades/:id/exits)', () => {
    it('should create partial exit and enforce cumulative volume constraint', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          symbol: 'EURUSD',
          direction: 'buy',
          entryPrice: '1.1000',
          exitPrice: '1.1050',
          volume: '1.0', // Total trade volume = 1.0
          commission: '10.00',
          openTime: '2026-09-10 10:00:00',
          closeTime: '2026-09-10 14:00:00',
        },
      });
      const tradeId = createRes.json().data.id;

      // Exit 1: volume = 0.5 (valid)
      const exit1 = await app.inject({
        method: 'POST',
        url: `/api/v1/trades/${tradeId}/exits`,
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          exitType: 'tp',
          exitPrice: '1.1030',
          volume: '0.5',
          exitedAt: '2026-09-10 11:00:00',
          notes: 'TP1 partial close',
        },
      });

      expect(exit1.statusCode).toBe(201);

      // Exit 2: volume = 0.6 (Total = 1.1 > 1.0 -> should fail)
      const exit2 = await app.inject({
        method: 'POST',
        url: `/api/v1/trades/${tradeId}/exits`,
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          exitType: 'tp',
          exitPrice: '1.1050',
          volume: '0.6',
          exitedAt: '2026-09-10 12:00:00',
        },
      });

      expect(exit2.statusCode).toBe(422);
      expect(exit2.json().error.code).toBe('VALIDATION_FAILED');

      // List exits
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/trades/${tradeId}/exits`,
        headers: { authorization: `Bearer ${user1Token}` },
      });

      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().data.items).toHaveLength(1);
      expect(listRes.json().data.items[0].volume).toBe('0.5');
    });

    it('should reject concurrent partial exits that exceed total parent trade volume (atomicity check)', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/v1/trades',
        headers: { authorization: `Bearer ${user1Token}` },
        payload: {
          symbol: 'EURUSD',
          direction: 'buy',
          entryPrice: '1.1000',
          exitPrice: '1.1050',
          volume: '1.0', // Total trade volume = 1.0
          commission: '10.00',
          openTime: '2026-09-10 10:00:00',
          closeTime: '2026-09-10 14:00:00',
        },
      });
      const tradeId = createRes.json().data.id;

      // Send 2 concurrent requests, each attempting volume = 0.6 (0.6 + 0.6 = 1.2 > 1.0)
      const [res1, res2] = await Promise.all([
        app.inject({
          method: 'POST',
          url: `/api/v1/trades/${tradeId}/exits`,
          headers: { authorization: `Bearer ${user1Token}` },
          payload: {
            exitType: 'tp',
            exitPrice: '1.1030',
            volume: '0.6',
            exitedAt: '2026-09-10 11:00:00',
            notes: 'Concurrent exit A',
          },
        }),
        app.inject({
          method: 'POST',
          url: `/api/v1/trades/${tradeId}/exits`,
          headers: { authorization: `Bearer ${user1Token}` },
          payload: {
            exitType: 'tp',
            exitPrice: '1.1040',
            volume: '0.6',
            exitedAt: '2026-09-10 11:30:00',
            notes: 'Concurrent exit B',
          },
        }),
      ]);

      const statusCodes = [res1.statusCode, res2.statusCode].sort();
      expect(statusCodes).toEqual([201, 422]);

      // List exits to verify exactly one exit was stored with volume 0.6
      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/trades/${tradeId}/exits`,
        headers: { authorization: `Bearer ${user1Token}` },
      });

      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().data.items).toHaveLength(1);
      expect(listRes.json().data.items[0].volume).toBe('0.6');
    });
  });
});
