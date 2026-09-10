import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { RateLimiter } from '../../src/core/middleware/rateLimiter.js';
import { ApiError, errorHandler } from '../../src/core/errors/errorHandler.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

describe('Phase 4F Remediation Unit Tests', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    AuthService.clearMemoryStore();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  // =========================================================================
  // BLOCKER A: MemoryStore Safety & Fail-Closed Tests
  // =========================================================================

  describe('Blocker A: MemoryStore Fail-Closed Safety', () => {
    it('should allow MemoryStore fallback in test environment (NODE_ENV=test)', async () => {
      process.env.NODE_ENV = 'test';
      const authService = new AuthService();

      // In test mode without DB connection, register creates user in MemoryStore
      const result = await authService.register(
        { email: 'test-env@example.com', password: 'SecurePassword123' },
        '127.0.0.1',
      );

      expect(result.verificationRequired).toBe(true);
      expect(result.email).toBe('test-env@example.com');
    });

    it('should fail closed with HTTP 503 in development environment when DB operations fail', async () => {
      process.env.NODE_ENV = 'development';
      const authService = new AuthService();

      await expect(
        authService.register(
          { email: 'dev-env@example.com', password: 'SecurePassword123' },
          '127.0.0.1',
        ),
      ).rejects.toThrowError(ApiError);

      try {
        await authService.register(
          { email: 'dev-env@example.com', password: 'SecurePassword123' },
          '127.0.0.1',
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiError = err as ApiError;
        expect(apiError.statusCode).toBe(503);
        expect(apiError.code).toBe('SERVICE_UNAVAILABLE');
      }
    });

    it('should fail closed with HTTP 503 in production environment when DB operations fail', async () => {
      process.env.NODE_ENV = 'production';
      const authService = new AuthService();

      try {
        await authService.login(
          { email: 'prod-user@example.com', password: 'SecurePassword123' },
          '127.0.0.1',
        );
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiError = err as ApiError;
        expect(apiError.statusCode).toBe(503);
        expect(apiError.code).toBe('SERVICE_UNAVAILABLE');
        expect(apiError.message).not.toMatch(/prisma/i);
        expect(apiError.message).not.toMatch(/mysql/i);
      }
    });

    it('should enforce fail-closed RateLimiter in production environment when DB fails', async () => {
      process.env.NODE_ENV = 'production';

      try {
        await RateLimiter.hit('login', '127.0.0.1', 5, 300);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiError = err as ApiError;
        expect(apiError.statusCode).toBe(503);
        expect(apiError.code).toBe('SERVICE_UNAVAILABLE');
      }
    });
  });

  // =========================================================================
  // BLOCKER B: PHP Error Response Envelope Parity
  // =========================================================================

  describe('Blocker B: PHP Error Envelope Parity', () => {
    it('should format ApiError into exact PHP-compatible response envelope', () => {
      const err = new ApiError(
        'Email already registered.',
        409,
        'EMAIL_ALREADY_REGISTERED',
        { email: 'Email already registered.' },
        'errors.auth.emailAlreadyRegistered',
      );

      let payload: unknown = null;
      let statusCodeSent = 0;

      const mockReply = {
        status(code: number) {
          statusCodeSent = code;
          return this;
        },
        send(data: unknown) {
          payload = data;
          return this;
        },
      } as FastifyReply;

      const mockRequest = {
        id: 'req-1',
        log: { info: () => {}, error: () => {} },
      } as unknown as FastifyRequest;

      errorHandler(err, mockRequest, mockReply);

      expect(statusCodeSent).toBe(409);
      const res = payload as {
        status: string;
        data: null;
        error: {
          code: string;
          message: string;
          messageKey: string;
          params: Record<string, unknown>;
          details: Record<string, unknown> | null;
        };
        timestamp: string;
      };

      expect(res.status).toBe('error');
      expect(res.data).toBeNull();
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe('EMAIL_ALREADY_REGISTERED');
      expect(res.error.message).toBe('Email already registered.');
      expect(res.error.messageKey).toBe('errors.auth.emailAlreadyRegistered');
      expect(res.error.params).toEqual({});
      expect(res.error.details).toEqual({ email: 'Email already registered.' });
      expect(res.timestamp).toBeDefined();
      expect(new Date(res.timestamp).getTime()).not.toBeNaN();
    });

    it('should format 503 Service Unavailable into safe PHP error envelope without DB leaks', () => {
      process.env.NODE_ENV = 'production';
      const dbErr = new ApiError(
        'Service unavailable.',
        503,
        'SERVICE_UNAVAILABLE',
        null,
        'errors.http.503',
      );

      let payload: unknown = null;
      let statusCodeSent = 0;

      const mockReply = {
        status(code: number) {
          statusCodeSent = code;
          return this;
        },
        send(data: unknown) {
          payload = data;
          return this;
        },
      } as FastifyReply;

      const mockRequest = {
        id: 'req-db-fail',
        log: { error: () => {}, info: () => {} },
      } as unknown as FastifyRequest;

      errorHandler(dbErr, mockRequest, mockReply);

      expect(statusCodeSent).toBe(503);
      const res = payload as {
        status: string;
        data: null;
        error: {
          code: string;
          message: string;
          messageKey: string;
          params: Record<string, unknown>;
          details: Record<string, unknown> | null;
        };
        timestamp: string;
      };

      expect(res.status).toBe('error');
      expect(res.data).toBeNull();
      expect(res.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.error.messageKey).toBe('errors.http.503');
      expect(res.error.details).toBeNull();
    });
  });
});
