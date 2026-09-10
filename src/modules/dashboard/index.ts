import { FastifyPluginAsync } from 'fastify';
import { dashboardRoutes } from './dashboard.routes.js';

export const dashboardPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(dashboardRoutes, { prefix: '/api/v1/dashboard' });
};

export * from './dashboard.types.js';
export * from './dashboard.repository.js';
export * from './dashboard.service.js';
