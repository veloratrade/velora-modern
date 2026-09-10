import { FastifyPluginAsync } from 'fastify';
import { AuthMiddleware } from '../../core/middleware/auth.middleware.js';
import { DashboardService } from './dashboard.service.js';

export const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new DashboardService();

  // GET /api/v1/dashboard/summary
  fastify.get(
    '/summary',
    {
      preHandler: [AuthMiddleware.authenticate],
    },
    async (request, reply) => {
      const userId = request.userId!;
      const summary = await service.getSummary(userId);

      return reply.status(200).send({
        status: 'success',
        data: { summary },
      });
    },
  );

  // GET /api/v1/dashboard/equity-curve
  fastify.get<{ Querystring: { days?: string } }>(
    '/equity-curve',
    {
      preHandler: [AuthMiddleware.authenticate],
    },
    async (request, reply) => {
      const userId = request.userId!;
      const requestedDays = request.query.days ? parseInt(request.query.days, 10) : 30;
      const days = isNaN(requestedDays) ? 30 : requestedDays;

      const equityCurve = await service.getEquityCurve(userId, days);

      return reply.status(200).send({
        status: 'success',
        data: { equityCurve },
      });
    },
  );

  // GET /api/v1/dashboard/strategies
  fastify.get(
    '/strategies',
    {
      preHandler: [AuthMiddleware.authenticate],
    },
    async (request, reply) => {
      const userId = request.userId!;
      const strategies = await service.getPerStrategy(userId);

      return reply.status(200).send({
        status: 'success',
        data: { strategies },
      });
    },
  );
};
