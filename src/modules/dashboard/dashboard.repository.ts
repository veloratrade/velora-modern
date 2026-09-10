import { prisma } from '../../core/db.js';
import { ApiError } from '../../core/errors/errorHandler.js';
import { TradeRepository, MemoryTradeRecord } from '../trades/trades.repository.js';

export class DashboardRepository {
  private tradeRepository: TradeRepository;

  constructor(tradeRepository = new TradeRepository()) {
    this.tradeRepository = tradeRepository;
  }

  public async getUserTrades(userId: number): Promise<MemoryTradeRecord[]> {
    try {
      const trades = await prisma.trade.findMany({
        where: { userId: BigInt(userId) },
        orderBy: { openTime: 'asc' },
      });

      return trades.map((t) => ({
        id: Number(t.id),
        userId: Number(t.userId),
        accountId: t.accountId ? Number(t.accountId) : null,
        externalDealId: t.externalDealId,
        symbol: t.symbol,
        direction: t.direction,
        entryPrice: t.entryPrice.toString(),
        exitPrice: t.exitPrice ? t.exitPrice.toString() : '0',
        volume: t.volume.toString(),
        contractSize: t.contractSize.toString(),
        commission: t.commission.toString(),
        swap: t.swap.toString(),
        profitLoss: t.profitLoss ? t.profitLoss.toString() : '0',
        rMultiple: t.rMultiple ? t.rMultiple.toString() : null,
        stopLoss: t.stopLoss ? t.stopLoss.toString() : null,
        takeProfit: t.takeProfit ? t.takeProfit.toString() : null,
        openTime: t.openTime.toISOString().replace('T', ' ').substring(0, 19),
        closeTime: t.closeTime
          ? t.closeTime.toISOString().replace('T', ' ').substring(0, 19)
          : t.openTime.toISOString().replace('T', ' ').substring(0, 19),
        occurredOpenAtUtc: t.occurredOpenAtUtc
          ? t.occurredOpenAtUtc.toISOString().replace('T', ' ').substring(0, 19)
          : null,
        occurredCloseAtUtc: t.occurredCloseAtUtc
          ? t.occurredCloseAtUtc.toISOString().replace('T', ' ').substring(0, 19)
          : null,
        timeStatus: t.timeStatus,
        sourceTimezone: t.sourceTimezone,
        sourceTimezoneSource: t.sourceTimezoneSource,
        sourceCalendar: t.sourceCalendar,
        rawOpenText: t.rawOpenText,
        rawCloseText: t.rawCloseText,
        strategyTag: t.strategyTag,
        emotionalScore: t.emotionalScore,
        notes: t.notes,
        source: t.source,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      // Query memory trades from search filter
      const res = await this.tradeRepository.search({ userId }, { page: 1, limit: 10000 });
      return res.items;
    }
  }

  private isTestEnvironment(): boolean {
    return process.env.NODE_ENV === 'test';
  }
}
