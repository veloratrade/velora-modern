import { FastifyPluginAsync } from 'fastify';
import { AuthMiddleware } from '../../core/middleware/auth.middleware.js';
import { AccountService } from './accounts.service.js';
import { CreateAccountInput, AccountProvider, AccountStatus } from './accounts.types.js';

export const accountRoutes: FastifyPluginAsync = async (fastify) => {
  const service = new AccountService();

  // GET /api/v1/accounts
  fastify.get(
    '/',
    {
      preHandler: [AuthMiddleware.authenticate],
    },
    async (request, reply) => {
      const userId = request.userId!;
      const accounts = await service.listAccounts(userId);

      return reply.status(200).send({
        status: 'success',
        data: { accounts },
      });
    },
  );

  // POST /api/v1/accounts
  fastify.post<{ Body: CreateAccountInput }>(
    '/',
    {
      preHandler: [AuthMiddleware.authenticate],
    },
    async (request, reply) => {
      const userId = request.userId!;
      const userPlan = request.userPlan || request.user?.plan;
      const body = request.body || {};

      const account = await service.createAccount(
        userId,
        {
          provider: body.provider as AccountProvider,
          label: body.label,
          accountNumber: body.accountNumber,
          currency: body.currency,
          leverage: body.leverage,
          status: body.status as AccountStatus,
          timezone: body.timezone,
        },
        userPlan,
      );

      return reply.status(201).send({
        status: 'success',
        data: { account },
      });
    },
  );

  // POST /api/v1/accounts/detect-server
  fastify.post<{ Body: { mt_login?: string; accountNumber?: string } }>(
    '/detect-server',
    {
      preHandler: [AuthMiddleware.authenticate],
    },
    async (request, reply) => {
      const body = request.body || {};
      const login = body.mt_login ?? body.accountNumber;

      const result = service.detectServer(login);

      return reply.status(200).send({
        status: 'success',
        data: result,
      });
    },
  );

  // PATCH /api/v1/accounts/:id/timezone
  fastify.patch<{ Params: { id: string }; Body: { timezone?: string } }>(
    '/:id/timezone',
    {
      preHandler: [AuthMiddleware.authenticate],
    },
    async (request, reply) => {
      const userId = request.userId!;
      const id = parseInt(request.params.id, 10);
      const body = request.body || {};

      const account = await service.updateTimezone(id, userId, body.timezone);

      return reply.status(200).send({
        status: 'success',
        data: { account },
      });
    },
  );

  // DELETE /api/v1/accounts/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [AuthMiddleware.authenticate],
    },
    async (request, reply) => {
      const userId = request.userId!;
      const id = parseInt(request.params.id, 10);

      await service.deleteAccount(id, userId);

      return reply.status(200).send({
        status: 'success',
        data: { deleted: true },
      });
    },
  );
};
