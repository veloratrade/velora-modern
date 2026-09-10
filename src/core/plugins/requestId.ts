import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';

const requestIdPluginAsync: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('onRequest', async (request, reply) => {
    const existingId = request.headers['x-request-id'];
    const requestId =
      typeof existingId === 'string' && existingId.trim() !== '' ? existingId.trim() : randomUUID();

    request.id = requestId;
    reply.header('x-request-id', requestId);
  });
};

export const requestIdPlugin = fp(requestIdPluginAsync, {
  name: 'request-id-plugin',
});
