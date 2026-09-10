import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { TradeService } from './trades.service.js';
import { AuthMiddleware } from '../../core/middleware/auth.middleware.js';
import { CreateTradeInput, UpdateTradeInput, CreateTradeExitInput } from './trades.types.js';

export async function tradeRoutes(
  fastify: FastifyInstance,
  _opts: FastifyPluginOptions,
): Promise<void> {
  const service = new TradeService();

  // Enforce authentication on all trade routes
  fastify.addHook('preHandler', AuthMiddleware.authenticate);

  // GET /api/v1/trades
  fastify.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const query = req.query as {
      symbol?: string;
      direction?: string;
      from?: string;
      to?: string;
      q?: string;
      page?: string;
      limit?: string;
      order?: string;
    };

    const page = query.page ? parseInt(query.page, 10) || 1 : 1;
    const limit = query.limit ? parseInt(query.limit, 10) || 20 : 20;

    const result = await service.searchTrades(
      {
        userId,
        symbol: query.symbol,
        direction: query.direction,
        from: query.from,
        to: query.to,
        q: query.q,
      },
      {
        page,
        limit,
        order: query.order,
      },
    );

    return reply.status(200).send({
      status: 'success',
      data: result,
      error: null,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/v1/trades/:id
  fastify.get('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const params = req.params as { id: string };
    const id = parseInt(params.id, 10);

    const trade = await service.getTrade(id, userId);

    return reply.status(200).send({
      status: 'success',
      data: trade,
      error: null,
      timestamp: new Date().toISOString(),
    });
  });

  // POST /api/v1/trades
  fastify.post('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const body = req.body as CreateTradeInput;

    const trade = await service.createTrade(body, userId);

    return reply.status(201).send({
      status: 'success',
      data: trade,
      error: null,
      timestamp: new Date().toISOString(),
    });
  });

  // PUT /api/v1/trades/:id
  fastify.put('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const params = req.params as { id: string };
    const id = parseInt(params.id, 10);
    const body = req.body as UpdateTradeInput;

    const updated = await service.updateTrade(id, body, userId);

    return reply.status(200).send({
      status: 'success',
      data: updated,
      error: null,
      timestamp: new Date().toISOString(),
    });
  });

  // DELETE /api/v1/trades/:id
  fastify.delete('/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const params = req.params as { id: string };
    const id = parseInt(params.id, 10);

    const deleted = await service.deleteTrade(id, userId);

    return reply.status(200).send({
      status: 'success',
      data: { deleted },
      error: null,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/v1/trades/:id/exits
  fastify.get('/:id/exits', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const params = req.params as { id: string };
    const tradeId = parseInt(params.id, 10);

    const exits = await service.listTradeExits(tradeId, userId);

    return reply.status(200).send({
      status: 'success',
      data: { items: exits },
      error: null,
      timestamp: new Date().toISOString(),
    });
  });

  // POST /api/v1/trades/:id/exits
  fastify.post('/:id/exits', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const params = req.params as { id: string };
    const tradeId = parseInt(params.id, 10);
    const body = req.body as CreateTradeExitInput;

    const result = await service.createTradeExit(tradeId, userId, body);

    return reply.status(201).send({
      status: 'success',
      data: result,
      error: null,
      timestamp: new Date().toISOString(),
    });
  });

  // DELETE /api/v1/trades/exits/:exitId
  fastify.delete('/exits/:exitId', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const params = req.params as { exitId: string };
    const exitId = parseInt(params.exitId, 10);

    const deleted = await service.deleteTradeExit(exitId, userId);

    return reply.status(200).send({
      status: 'success',
      data: { deleted },
      error: null,
      timestamp: new Date().toISOString(),
    });
  });
}
