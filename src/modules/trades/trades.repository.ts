import { prisma } from '../../core/db.js';
import { ApiError } from '../../core/errors/errorHandler.js';
import {
  CreateTradeExitInput,
  PaginationOptions,
  TradeFilter,
  TradeDirection,
  TradeSource,
  TradeExitType,
} from './trades.types.js';
import { PnlCalculator } from './pnlCalculator.js';
import { Decimal } from 'decimal.js';

export interface MemoryTradeRecord {
  id: number;
  userId: number;
  accountId: number | null;
  externalDealId: string | null;
  symbol: string;
  direction: TradeDirection;
  entryPrice: string;
  exitPrice: string;
  volume: string;
  contractSize: string;
  commission: string;
  swap: string;
  profitLoss: string;
  rMultiple: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  openTime: string;
  closeTime: string;
  occurredOpenAtUtc: string | null;
  occurredCloseAtUtc: string | null;
  timeStatus: string;
  sourceTimezone: string | null;
  sourceTimezoneSource: string;
  sourceCalendar: string;
  rawOpenText: string | null;
  rawCloseText: string | null;
  strategyTag: string | null;
  emotionalScore: number | null;
  notes: string | null;
  source: TradeSource;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryTradeExitRecord {
  id: number;
  tradeId: number;
  userId: number;
  exitType: TradeExitType;
  exitPrice: string;
  volume: string;
  pnl: string;
  exitedAt: string;
  notes: string | null;
  createdAt: Date;
}

export interface MemoryAccountRecord {
  id: number;
  userId: number;
  name: string;
}

export class TradeRepository {
  private static memoryTrades: MemoryTradeRecord[] = [];
  private static memoryExits: MemoryTradeExitRecord[] = [];
  private static memoryAccounts: MemoryAccountRecord[] = [
    { id: 1, userId: 1, name: 'Default Account User 1' },
    { id: 2, userId: 2, name: 'Default Account User 2' },
  ];
  private static idCounter = 1;
  private static exitIdCounter = 1;

  public static clearMemoryStore(): void {
    TradeRepository.memoryTrades = [];
    TradeRepository.memoryExits = [];
    TradeRepository.memoryAccounts = [
      { id: 1, userId: 1, name: 'Default Account User 1' },
      { id: 2, userId: 2, name: 'Default Account User 2' },
    ];
    TradeRepository.idCounter = 1;
    TradeRepository.exitIdCounter = 1;
  }

  public async findOwned(id: number, userId: number): Promise<MemoryTradeRecord | null> {
    try {
      const trade = await prisma.trade.findFirst({
        where: {
          id: BigInt(id),
          userId: BigInt(userId),
        },
      });

      if (!trade) return null;

      return this.mapDbToRecord(trade);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }
      const record = TradeRepository.memoryTrades.find((t) => t.id === id && t.userId === userId);
      return record ? { ...record } : null;
    }
  }

  public async requireOwned(id: number, userId: number): Promise<MemoryTradeRecord> {
    const trade = await this.findOwned(id, userId);
    if (!trade) {
      throw new ApiError('Trade not found.', 404, 'NOT_FOUND', null, 'errors.trades.notFound');
    }
    return trade;
  }

  public async verifyAccountOwnership(accountId: number, userId: number): Promise<boolean> {
    try {
      const account = await prisma.tradingAccount.findFirst({
        where: {
          id: BigInt(accountId),
          userId: BigInt(userId),
        },
      });

      return Boolean(account);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }
      const acc = TradeRepository.memoryAccounts.find(
        (a) => a.id === accountId && a.userId === userId,
      );
      return Boolean(acc);
    }
  }

  public async search(
    filter: TradeFilter,
    options: PaginationOptions,
  ): Promise<{ items: MemoryTradeRecord[]; total: number }> {
    const { page, limit } = options;
    const skip = (page - 1) * limit;

    try {
      const where: Record<string, unknown> = {
        userId: BigInt(filter.userId),
      };

      if (filter.symbol) {
        where.symbol = { contains: filter.symbol };
      }
      if (filter.direction) {
        where.direction = filter.direction;
      }
      const startDate = filter.startDate || filter.from;
      if (startDate) {
        where.openTime = { gte: new Date(startDate) };
      }
      const endDate = filter.endDate || filter.to;
      if (endDate) {
        where.closeTime = { lte: new Date(endDate) };
      }

      const [trades, total] = await Promise.all([
        prisma.trade.findMany({
          where,
          skip,
          take: limit,
          orderBy: { openTime: 'desc' },
        }),
        prisma.trade.count({ where }),
      ]);

      return {
        items: trades.map((t) => this.mapDbToRecord(t)),
        total,
      };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      let list = TradeRepository.memoryTrades.filter((t) => t.userId === filter.userId);

      if (filter.symbol) {
        const sym = filter.symbol.toUpperCase();
        list = list.filter((t) => t.symbol.includes(sym));
      }

      if (filter.direction) {
        list = list.filter((t) => t.direction === filter.direction);
      }

      const startDate = filter.startDate || filter.from;
      if (startDate) {
        const start = new Date(startDate).getTime();
        list = list.filter((t) => new Date(t.openTime).getTime() >= start);
      }

      const endDate = filter.endDate || filter.to;
      if (endDate) {
        const end = new Date(endDate).getTime();
        list = list.filter((t) => new Date(t.closeTime).getTime() <= end);
      }

      const total = list.length;
      const paged = list.slice(skip, skip + limit);

      return { items: paged, total };
    }
  }

  public async create(
    data: Omit<MemoryTradeRecord, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<number> {
    try {
      const created = await prisma.trade.create({
        data: {
          userId: BigInt(data.userId),
          accountId: data.accountId ? BigInt(data.accountId) : null,
          externalDealId: data.externalDealId,
          symbol: data.symbol,
          direction: data.direction,
          entryPrice: data.entryPrice,
          exitPrice: data.exitPrice,
          volume: data.volume,
          contractSize: data.contractSize,
          commission: data.commission,
          swap: data.swap,
          profitLoss: data.profitLoss,
          rMultiple: data.rMultiple,
          stopLoss: data.stopLoss,
          takeProfit: data.takeProfit,
          openTime: new Date(data.openTime),
          closeTime: new Date(data.closeTime),
          occurredOpenAtUtc: data.occurredOpenAtUtc ? new Date(data.occurredOpenAtUtc) : null,
          occurredCloseAtUtc: data.occurredCloseAtUtc ? new Date(data.occurredCloseAtUtc) : null,
          timeStatus: data.timeStatus,
          sourceTimezone: data.sourceTimezone,
          sourceTimezoneSource: data.sourceTimezoneSource,
          sourceCalendar: data.sourceCalendar,
          rawOpenText: data.rawOpenText,
          rawCloseText: data.rawCloseText,
          strategyTag: data.strategyTag,
          emotionalScore: data.emotionalScore,
          notes: data.notes,
          source: data.source,
        },
      });

      return Number(created.id);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const id = TradeRepository.idCounter++;
      const now = new Date();
      const record: MemoryTradeRecord = {
        ...data,
        id,
        createdAt: now,
        updatedAt: now,
      };
      TradeRepository.memoryTrades.push(record);
      return id;
    }
  }

  public async update(
    id: number,
    data: Partial<Omit<MemoryTradeRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<boolean> {
    try {
      const updateData: Record<string, unknown> = {};

      if (data.symbol !== undefined) updateData.symbol = data.symbol;
      if (data.direction !== undefined) updateData.direction = data.direction;
      if (data.entryPrice !== undefined) updateData.entryPrice = data.entryPrice;
      if (data.exitPrice !== undefined) updateData.exitPrice = data.exitPrice;
      if (data.volume !== undefined) updateData.volume = data.volume;
      if (data.contractSize !== undefined) updateData.contractSize = data.contractSize;
      if (data.commission !== undefined) updateData.commission = data.commission;
      if (data.swap !== undefined) updateData.swap = data.swap;
      if (data.profitLoss !== undefined) updateData.profitLoss = data.profitLoss;
      if (data.rMultiple !== undefined) updateData.rMultiple = data.rMultiple;
      if (data.stopLoss !== undefined) updateData.stopLoss = data.stopLoss;
      if (data.takeProfit !== undefined) updateData.takeProfit = data.takeProfit;
      if (data.accountId !== undefined)
        updateData.accountId = data.accountId ? BigInt(data.accountId) : null;
      if (data.openTime !== undefined) updateData.openTime = new Date(data.openTime);
      if (data.closeTime !== undefined) updateData.closeTime = new Date(data.closeTime);
      if (data.strategyTag !== undefined) updateData.strategyTag = data.strategyTag;
      if (data.emotionalScore !== undefined) updateData.emotionalScore = data.emotionalScore;
      if (data.notes !== undefined) updateData.notes = data.notes;

      await prisma.trade.update({
        where: { id: BigInt(id) },
        data: updateData,
      });

      return true;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const idx = TradeRepository.memoryTrades.findIndex((t) => t.id === id);
      if (idx === -1) return false;

      const existing = TradeRepository.memoryTrades[idx];
      if (!existing) return false;

      TradeRepository.memoryTrades[idx] = {
        ...existing,
        ...data,
        updatedAt: new Date(),
      };
      return true;
    }
  }

  public async delete(id: number, userId: number): Promise<boolean> {
    try {
      const result = await prisma.trade.deleteMany({
        where: {
          id: BigInt(id),
          userId: BigInt(userId),
        },
      });

      return result.count > 0;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const idx = TradeRepository.memoryTrades.findIndex((t) => t.id === id && t.userId === userId);
      if (idx === -1) return false;

      TradeRepository.memoryTrades.splice(idx, 1);
      TradeRepository.memoryExits = TradeRepository.memoryExits.filter((e) => e.tradeId !== id);
      return true;
    }
  }

  // --- Trade Exits (Partial Exits) ---

  public async listExitsByTrade(tradeId: number, userId: number): Promise<MemoryTradeExitRecord[]> {
    try {
      const exits = await prisma.tradeExit.findMany({
        where: {
          tradeId: BigInt(tradeId),
          trade: { userId: BigInt(userId) },
        },
        orderBy: { exitTime: 'asc' },
      });

      return exits.map((e) => ({
        id: Number(e.id),
        tradeId: Number(e.tradeId),
        userId,
        exitType: e.exitType as TradeExitType,
        exitPrice: e.exitPrice.toString(),
        volume: e.volume.toString(),
        pnl: e.pnl.toString(),
        exitedAt: e.exitTime.toISOString().replace('T', ' ').substring(0, 19),
        notes: null,
        createdAt: e.createdAt,
      }));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      return TradeRepository.memoryExits
        .filter((e) => e.tradeId === tradeId && e.userId === userId)
        .sort((a, b) => new Date(a.exitedAt).getTime() - new Date(b.exitedAt).getTime());
    }
  }

  public async createExit(
    tradeId: number,
    userId: number,
    input: CreateTradeExitInput,
  ): Promise<number> {
    const parentTrade = await this.requireOwned(tradeId, userId);

    const existingExits = await this.listExitsByTrade(tradeId, userId);
    let cumulativeVolume = new Decimal(0);
    for (const exit of existingExits) {
      cumulativeVolume = cumulativeVolume.plus(new Decimal(exit.volume));
    }

    const newExitVolume = new Decimal(input.volume);
    const totalVolume = cumulativeVolume.plus(newExitVolume);
    const parentVolume = new Decimal(parentTrade.volume);

    if (totalVolume.greaterThan(parentVolume)) {
      throw new ApiError(
        'Cumulative exit volume exceeds the trade volume.',
        422,
        'VALIDATION_FAILED',
        { volume: 'EXIT_VOLUME_EXCEEDED' },
        'errors.validation.range',
      );
    }

    const exitedAtTime = new Date(input.exitedAt).getTime();
    const openTime = new Date(parentTrade.openTime).getTime();
    const closeTime = new Date(parentTrade.closeTime).getTime();

    if (exitedAtTime < openTime || exitedAtTime > closeTime) {
      throw new ApiError(
        'Exit timestamp must be within trade open and close times.',
        422,
        'VALIDATION_FAILED',
        { field: 'exitedAt' },
        'errors.validation.datetime',
      );
    }

    const ratio = newExitVolume.dividedBy(parentVolume);
    const allocatedCommission = new Decimal(parentTrade.commission).times(ratio).toFixed(8);
    const allocatedSwap = new Decimal(parentTrade.swap).times(ratio).toFixed(8);

    const calcResult = PnlCalculator.calculate({
      entryPrice: parentTrade.entryPrice,
      exitPrice: input.exitPrice,
      volume: input.volume,
      direction: parentTrade.direction,
      commission: allocatedCommission,
      swap: allocatedSwap,
      contractSize: parentTrade.contractSize,
    });

    const exitPnl = calcResult.netPnl;

    try {
      const created = await prisma.tradeExit.create({
        data: {
          tradeId: BigInt(tradeId),
          exitType: input.exitType,
          exitPrice: input.exitPrice,
          volume: input.volume,
          pnl: exitPnl,
          exitTime: new Date(input.exitedAt),
        },
      });

      return Number(created.id);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const id = TradeRepository.exitIdCounter++;
      const record: MemoryTradeExitRecord = {
        id,
        tradeId,
        userId,
        exitType: input.exitType,
        exitPrice: input.exitPrice,
        volume: input.volume,
        pnl: exitPnl,
        exitedAt: input.exitedAt,
        notes: input.notes ?? null,
        createdAt: new Date(),
      };

      TradeRepository.memoryExits.push(record);
      return id;
    }
  }

  public async deleteExit(exitId: number, userId: number): Promise<boolean> {
    try {
      const result = await prisma.tradeExit.deleteMany({
        where: {
          id: BigInt(exitId),
          trade: { userId: BigInt(userId) },
        },
      });

      return result.count > 0;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (!this.isTestEnvironment()) {
        throw new ApiError('Service unavailable.', 503, 'SERVICE_UNAVAILABLE');
      }

      const idx = TradeRepository.memoryExits.findIndex(
        (e) => e.id === exitId && e.userId === userId,
      );
      if (idx === -1) return false;

      TradeRepository.memoryExits.splice(idx, 1);
      return true;
    }
  }

  private mapDbToRecord(trade: {
    id: bigint;
    userId: bigint;
    accountId: bigint | null;
    externalDealId: string | null;
    symbol: string;
    direction: TradeDirection;
    entryPrice: { toString(): string };
    exitPrice: { toString(): string } | null;
    volume: { toString(): string };
    contractSize: { toString(): string };
    commission: { toString(): string };
    swap: { toString(): string };
    profitLoss: { toString(): string } | null;
    rMultiple: { toString(): string } | null;
    stopLoss: { toString(): string } | null;
    takeProfit: { toString(): string } | null;
    openTime: Date;
    closeTime: Date | null;
    occurredOpenAtUtc: Date | null;
    occurredCloseAtUtc: Date | null;
    timeStatus: string;
    sourceTimezone: string | null;
    sourceTimezoneSource: string;
    sourceCalendar: string;
    rawOpenText: string | null;
    rawCloseText: string | null;
    strategyTag: string | null;
    emotionalScore: number | null;
    notes: string | null;
    source: TradeSource;
    createdAt: Date;
    updatedAt: Date;
  }): MemoryTradeRecord {
    return {
      id: Number(trade.id),
      userId: Number(trade.userId),
      accountId: trade.accountId ? Number(trade.accountId) : null,
      externalDealId: trade.externalDealId,
      symbol: trade.symbol,
      direction: trade.direction,
      entryPrice: trade.entryPrice.toString(),
      exitPrice: trade.exitPrice ? trade.exitPrice.toString() : '0',
      volume: trade.volume.toString(),
      contractSize: trade.contractSize.toString(),
      commission: trade.commission.toString(),
      swap: trade.swap.toString(),
      profitLoss: trade.profitLoss ? trade.profitLoss.toString() : '0',
      rMultiple: trade.rMultiple ? trade.rMultiple.toString() : null,
      stopLoss: trade.stopLoss ? trade.stopLoss.toString() : null,
      takeProfit: trade.takeProfit ? trade.takeProfit.toString() : null,
      openTime: trade.openTime.toISOString().replace('T', ' ').substring(0, 19),
      closeTime: trade.closeTime
        ? trade.closeTime.toISOString().replace('T', ' ').substring(0, 19)
        : trade.openTime.toISOString().replace('T', ' ').substring(0, 19),
      occurredOpenAtUtc: trade.occurredOpenAtUtc
        ? trade.occurredOpenAtUtc.toISOString().replace('T', ' ').substring(0, 19)
        : null,
      occurredCloseAtUtc: trade.occurredCloseAtUtc
        ? trade.occurredCloseAtUtc.toISOString().replace('T', ' ').substring(0, 19)
        : null,
      timeStatus: trade.timeStatus,
      sourceTimezone: trade.sourceTimezone,
      sourceTimezoneSource: trade.sourceTimezoneSource,
      sourceCalendar: trade.sourceCalendar,
      rawOpenText: trade.rawOpenText,
      rawCloseText: trade.rawCloseText,
      strategyTag: trade.strategyTag,
      emotionalScore: trade.emotionalScore,
      notes: trade.notes,
      source: trade.source,
      createdAt: trade.createdAt,
      updatedAt: trade.updatedAt,
    };
  }

  private isTestEnvironment(): boolean {
    return process.env.NODE_ENV === 'test';
  }
}
