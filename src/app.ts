import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { requestIdPlugin } from './core/plugins/requestId.js';
import { errorHandler } from './core/errors/errorHandler.js';
import { authRoutes } from './modules/auth/auth.routes.js';

export function buildApp() {
  const app = Fastify({
    logger,
    disableRequestLogging: false,
    bodyLimit: 1048576, // 1MB limit
  });

  // Register Security Plugins
  app.register(helmet, {
    contentSecurityPolicy: env.NODE_ENV === 'production',
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

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: `Route ${request.method}:${request.url} not found`,
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  // Operational /health Endpoint
  app.get('/health', async () => {
    return {
      status: 'ok',
      service: 'velora-modern',
      version: '0.4.0',
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

  return app;
}
