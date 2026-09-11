import { readFileSync } from 'fs';
import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { requestIdPlugin } from './core/plugins/requestId.js';
import { errorHandler } from './core/errors/errorHandler.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { tradeRoutes } from './modules/trades/trades.routes.js';
import { accountsPlugin } from './modules/accounts/index.js';
import { dashboardPlugin } from './modules/dashboard/index.js';

// Single source of truth for the application version: package.json "version"
// (authoritative value per migration changelog + README). Read at runtime so
// src (tsx/vitest) and dist (node) always agree — no hardcoded duplicate.
// Path holds in both layouts: src/app.ts -> ../package.json and
// dist/app.js -> ../package.json.
const APP_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  }
).version;

export function buildApp() {
  const app = Fastify({
    logger,
    disableRequestLogging: false,
    bodyLimit: 1048576, // 1MB limit
  });

  // Register Security Plugins
  app.register(helmet, {
    contentSecurityPolicy: env.NODE_ENV === 'production',
    // D16 owner-approved values — explicit configuration, never framework
    // defaults. Unrelated Helmet headers keep their existing behavior.
    frameguard: { action: 'deny' }, // X-Frame-Options: DENY
    hsts: { maxAge: 31536000, includeSubDomains: true },
  });

  // D16 owner-approved: Cache-Control is not a Helmet header, so it is
  // enforced here. onSend runs for every reply (including errors), so the
  // policy holds on all responses.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('cache-control', 'no-store, max-age=0, private');
    return payload;
  });

  app.register(cors, {
    origin: env.NODE_ENV === 'production' ? false : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'Cookie'],
  });

  app.register(sensible);
  app.register(requestIdPlugin);

  // Register Error Handlers
  app.setErrorHandler(errorHandler);

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      status: 'error',
      data: null,
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        messageKey: 'errors.notFound',
        params: {},
        details: null,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // Operational /health Endpoint
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'velora-modern',
      version: APP_VERSION,
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies: {
        database: env.DATABASE_URL ? 'configured' : 'not_configured',
        redis: env.REDIS_URL ? 'configured' : 'not_configured',
      },
    };
  });

  // Domain Module Routes
  app.register(authRoutes, { prefix: '/api/v1/auth' });
  app.register(tradeRoutes, { prefix: '/api/v1/trades' });
  app.register(accountsPlugin);
  app.register(dashboardPlugin);

  return app;
}
