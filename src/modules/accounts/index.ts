import { FastifyPluginAsync } from 'fastify';
import { accountRoutes } from './accounts.routes.js';

export const accountsPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(accountRoutes, { prefix: '/api/v1/accounts' });
};

export * from './accounts.types.js';
export * from './accounts.repository.js';
export * from './accounts.service.js';
