import { TradeRepository, MemoryTradeRecord } from './trades.repository.js';
import {
  CreateTradeInput,
  UpdateTradeInput,
  TradeFilter,
  PaginationOptions,
  TradeSerialized,
  CreateTradeExitInput,
  TradeExitSerialized,
  TradeDirection,
} from './trades.types.js';
import { PnlCalculator } from './pnlCalculator.js';
import { ApiError } from '../../core/errors/errorHandler.js';
import { Decimal } from 'decimal.js';

export class TradeService {
  private static readonly DIRECTIONS: TradeDirection[] = ['buy', 'sell'];

  constructor(private readonly repository: TradeRepository = new TradeRepository()) {}

  public getRepository(): TradeRepository {
    return this.repository;
  }

  public async buildTrade(
    raw: Partial<CreateTradeInput>,
    userId: number,
  ): Promise<Omit<MemoryTradeRecord, 'id' | 'createdAt' | 'updatedAt'>> {
    const rawSymbol = raw.symbol ?? '';
    const symbol = typeof rawSymbol === 'string' ? rawSymbol.trim().toUpperCase() : '';
    const direction = typeof raw.direction === 'string' ? raw.direction : '';
    const source = 'manual';

    if (!symbol) {
      throw new ApiError(
        'Symbol is required.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'symbol',
          messageKey: 'errors.validation.required',
        },
        'errors.validation.required',
      );
    }

    if (!/^[A-Z0-9#][A-Z0-9._:/#+-]{0,31}$/.test(symbol)) {
      throw new ApiError(
        'Invalid symbol.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'symbol',
          messageKey: 'errors.validation.format',
        },
        'errors.validation.format',
      );
    }

    if (!TradeService.DIRECTIONS.includes(direction as TradeDirection)) {
      throw new ApiError(
        'Invalid trade direction.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'direction',
          messageKey: 'errors.validation.choice',
        },
        'errors.validation.choice',
      );
    }

    let accountId: number | null = null;
    if (raw.accountId !== undefined && raw.accountId !== null && raw.accountId !== '') {
      const rawAcc = String(raw.accountId);
      if (!/^[1-9]\d*$/.test(rawAcc)) {
        throw new ApiError(
          'Invalid broker account.',
          400,
          'VALIDATION_FAILED',
          {
            field: 'accountId',
            messageKey: 'errors.validation.format',
          },
          'errors.validation.format',
        );
      }
      accountId = parseInt(rawAcc, 10);
      const isOwned = await this.repository.verifyAccountOwnership(accountId, userId);
      if (!isOwned) {
        throw new ApiError(
          'Broker account ownership check failed.',
          400,
          'VALIDATION_FAILED',
          {
            field: 'accountId',
            messageKey: 'errors.trades.accountNotOwned',
          },
          'errors.trades.accountNotOwned',
        );
      }
    }

    const entryPrice = this.validateDecimal(raw.entryPrice, 'entryPrice', 10, 8);
    const exitPrice = this.validateDecimal(raw.exitPrice, 'exitPrice', 10, 8);
    const volume = this.validateDecimal(raw.volume, 'volume', 10, 8);
    const commission = this.validateDecimal(raw.commission ?? '0', 'commission', 10, 8);
    const swap = this.validateDecimal(raw.swap ?? '0', 'swap', 10, 8);
    const contractSize = this.validateDecimal(raw.contractSize ?? '1', 'contractSize', 10, 8);

    const stopLoss =
      raw.stopLoss !== undefined && raw.stopLoss !== null && raw.stopLoss !== ''
        ? this.validateDecimal(raw.stopLoss, 'stopLoss', 10, 8)
        : null;

    const takeProfit =
      raw.takeProfit !== undefined && raw.takeProfit !== null && raw.takeProfit !== ''
        ? this.validateDecimal(raw.takeProfit, 'takeProfit', 10, 8)
        : null;

    if (
      new Decimal(entryPrice).lessThanOrEqualTo(0) ||
      new Decimal(exitPrice).lessThanOrEqualTo(0)
    ) {
      throw new ApiError(
        'Trade prices must be positive.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'entryPrice',
          messageKey: 'errors.validation.positive',
        },
        'errors.validation.positive',
      );
    }

    if (new Decimal(volume).lessThanOrEqualTo(0)) {
      throw new ApiError(
        'Volume must be positive.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'volume',
          messageKey: 'errors.validation.positive',
        },
        'errors.validation.positive',
      );
    }

    if (new Decimal(contractSize).lessThanOrEqualTo(0)) {
      throw new ApiError(
        'Contract size must be positive.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'contractSize',
          messageKey: 'errors.validation.positive',
        },
        'errors.validation.positive',
      );
    }

    if (stopLoss !== null && new Decimal(stopLoss).lessThanOrEqualTo(0)) {
      throw new ApiError(
        'Stop loss must be positive.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'stopLoss',
          messageKey: 'errors.validation.positive',
        },
        'errors.validation.positive',
      );
    }

    if (takeProfit !== null && new Decimal(takeProfit).lessThanOrEqualTo(0)) {
      throw new ApiError(
        'Take profit must be positive.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'takeProfit',
          messageKey: 'errors.validation.positive',
        },
        'errors.validation.positive',
      );
    }

    const openTime = this.toStandardDatetime(raw.openTime, 'openTime');
    const closeTime = this.toStandardDatetime(raw.closeTime, 'closeTime');

    if (new Date(closeTime).getTime() < new Date(openTime).getTime()) {
      throw new ApiError(
        'Close time must not precede open time.',
        400,
        'VALIDATION_FAILED',
        {
          field: 'closeTime',
          messageKey: 'errors.validation.datetime',
        },
        'errors.validation.datetime',
      );
    }

    const strategyTag = this.validateOptionalText(raw.strategyTag, 'strategyTag', 64);
    const notes = this.validateOptionalText(raw.notes, 'notes', 5000);

    let emotionalScore: number | null = null;
    if (
      raw.emotionalScore !== undefined &&
      raw.emotionalScore !== null &&
      raw.emotionalScore !== ''
    ) {
      const scoreNum = Number(raw.emotionalScore);
      if (!Number.isInteger(scoreNum) || scoreNum < 1 || scoreNum > 5) {
        throw new ApiError(
          'Emotional score is out of range.',
          400,
          'VALIDATION_FAILED',
          {
            field: 'emotionalScore',
            messageKey: 'errors.validation.range',
            params: { min: 1, max: 5 },
          },
          'errors.validation.range',
        );
      }
      emotionalScore = scoreNum;
    }

    const pnlCalc = PnlCalculator.calculate({
      entryPrice,
      exitPrice,
      volume,
      direction: direction as TradeDirection,
      commission,
      swap,
      stopLoss,
      contractSize,
    });

    return {
      userId,
      accountId,
      externalDealId: null,
      symbol,
      direction: direction as TradeDirection,
      entryPrice,
      exitPrice,
      volume,
      contractSize,
      commission,
      swap,
      profitLoss: pnlCalc.netPnl,
      rMultiple: pnlCalc.rMultiple,
      stopLoss,
      takeProfit,
      openTime,
      closeTime,
      occurredOpenAtUtc: null,
      occurredCloseAtUtc: null,
      timeStatus: 'unresolved',
      sourceTimezone: null,
      sourceTimezoneSource: 'unknown',
      sourceCalendar: 'unknown',
      rawOpenText: null,
      rawCloseText: null,
      strategyTag,
      emotionalScore,
      notes,
      source,
    };
  }

  public async createTrade(raw: CreateTradeInput, userId: number): Promise<TradeSerialized> {
    const tradeRecord = await this.buildTrade(raw, userId);
    const id = await this.repository.create(tradeRecord);
    const created = await this.repository.requireOwned(id, userId);
    return this.serialize(created);
  }

  public async getTrade(id: number, userId: number): Promise<TradeSerialized> {
    const trade = await this.repository.requireOwned(id, userId);
    return this.serialize(trade);
  }

  public async searchTrades(
    filter: TradeFilter,
    options: PaginationOptions,
  ): Promise<{
    items: TradeSerialized[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const result = await this.repository.search(filter, options);
    const totalPages = Math.max(1, Math.ceil(result.total / options.limit));

    return {
      items: result.items.map((t) => this.serialize(t)),
      pagination: {
        page: options.page,
        limit: options.limit,
        total: result.total,
        totalPages,
      },
    };
  }

  public async updateTrade(
    id: number,
    raw: UpdateTradeInput,
    userId: number,
  ): Promise<TradeSerialized> {
    const existing = await this.repository.requireOwned(id, userId);

    const mergedInput: CreateTradeInput = {
      symbol: raw.symbol ?? existing.symbol,
      direction: (raw.direction ?? existing.direction) as TradeDirection,
      entryPrice: raw.entryPrice ?? existing.entryPrice,
      exitPrice: raw.exitPrice ?? existing.exitPrice,
      volume: raw.volume ?? existing.volume,
      contractSize: raw.contractSize ?? existing.contractSize,
      commission: raw.commission ?? existing.commission,
      swap: raw.swap ?? existing.swap,
      stopLoss: raw.stopLoss !== undefined ? raw.stopLoss : existing.stopLoss,
      takeProfit: raw.takeProfit !== undefined ? raw.takeProfit : existing.takeProfit,
      accountId: raw.accountId !== undefined ? raw.accountId : existing.accountId,
      openTime: raw.openTime ?? existing.openTime,
      closeTime: raw.closeTime ?? existing.closeTime,
      strategyTag: raw.strategyTag !== undefined ? raw.strategyTag : existing.strategyTag,
      emotionalScore:
        raw.emotionalScore !== undefined ? raw.emotionalScore : existing.emotionalScore,
      notes: raw.notes !== undefined ? raw.notes : existing.notes,
    };

    const updatedRecord = await this.buildTrade(mergedInput, userId);
    await this.repository.update(id, updatedRecord);
    const updated = await this.repository.requireOwned(id, userId);
    return this.serialize(updated);
  }

  public async deleteTrade(id: number, userId: number): Promise<boolean> {
    await this.repository.requireOwned(id, userId);
    return this.repository.delete(id, userId);
  }

  // --- Partial Exit Methods ---

  public async listTradeExits(tradeId: number, userId: number): Promise<TradeExitSerialized[]> {
    await this.repository.requireOwned(tradeId, userId);
    const exits = await this.repository.listExitsByTrade(tradeId, userId);
    return exits.map((e) => ({
      id: e.id,
      tradeId: e.tradeId,
      exitType: e.exitType,
      exitPrice: this.trimZeros(e.exitPrice),
      volume: this.trimZeros(e.volume),
      pnl: this.trimZeros(e.pnl),
      exitedAt: e.exitedAt,
      notes: e.notes,
    }));
  }

  public async createTradeExit(
    tradeId: number,
    userId: number,
    input: CreateTradeExitInput,
  ): Promise<{ id: number; messageKey: string; params: Record<string, unknown> }> {
    const id = await this.repository.createExit(tradeId, userId, input);
    return {
      id,
      messageKey: 'trades.exitCreated',
      params: {},
    };
  }

  public async deleteTradeExit(exitId: number, userId: number): Promise<boolean> {
    const deleted = await this.repository.deleteExit(exitId, userId);
    if (!deleted) {
      throw new ApiError(
        'Trade exit not found.',
        404,
        'NOT_FOUND',
        null,
        'errors.trades.exitNotFound',
      );
    }
    return true;
  }

  public serialize(trade: MemoryTradeRecord): TradeSerialized {
    return {
      id: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      entryPrice: this.trimZeros(trade.entryPrice),
      exitPrice: this.trimZeros(trade.exitPrice),
      volume: this.trimZeros(trade.volume),
      contractSize: this.trimZeros(trade.contractSize),
      commission: this.trimZeros(trade.commission),
      swap: this.trimZeros(trade.swap),
      profitLoss: this.trimZeros(trade.profitLoss),
      rMultiple: trade.rMultiple === null ? null : this.trimZeros(trade.rMultiple),
      stopLoss: trade.stopLoss === null ? null : this.trimZeros(trade.stopLoss),
      takeProfit: trade.takeProfit === null ? null : this.trimZeros(trade.takeProfit),
      accountId: trade.accountId,
      openTime: trade.openTime,
      closeTime: trade.closeTime,
      occurredOpenAtUtc: trade.occurredOpenAtUtc,
      occurredCloseAtUtc: trade.occurredCloseAtUtc,
      timeStatus: trade.timeStatus || 'unresolved',
      sourceTimezone: trade.sourceTimezone,
      sourceTimezoneSource: trade.sourceTimezoneSource || 'unknown',
      sourceCalendar: trade.sourceCalendar || 'unknown',
      rawOpenText: trade.rawOpenText,
      rawCloseText: trade.rawCloseText,
      session: 'unconfigured',
      strategyTag: trade.strategyTag,
      emotionalScore: trade.emotionalScore,
      notes: trade.notes,
      source: trade.source,
      createdAt:
        trade.createdAt instanceof Date ? trade.createdAt.toISOString() : String(trade.createdAt),
      updatedAt:
        trade.updatedAt instanceof Date ? trade.updatedAt.toISOString() : String(trade.updatedAt),
    };
  }

  private validateDecimal(
    val: unknown,
    field: string,
    maxIntDigits: number,
    maxDecDigits: number,
  ): string {
    if (typeof val !== 'string' && typeof val !== 'number') {
      throw new ApiError(
        'Invalid numeric amount.',
        400,
        'VALIDATION_FAILED',
        {
          field,
          messageKey: 'errors.validation.numeric',
        },
        'errors.validation.numeric',
      );
    }
    const str = String(val).trim();
    const pattern = new RegExp(`^-?\\d{1,${maxIntDigits}}(?:\\.\\d{1,${maxDecDigits}})?$`);
    if (!str || !pattern.test(str)) {
      throw new ApiError(
        'Invalid numeric amount.',
        400,
        'VALIDATION_FAILED',
        {
          field,
          messageKey: 'errors.validation.decimal',
          params: { maxIntegerDigits: maxIntDigits, maxFractionDigits: maxDecDigits },
        },
        'errors.validation.decimal',
      );
    }
    return new Decimal(str).toFixed(8);
  }

  private validateOptionalText(val: unknown, field: string, maxLength: number): string | null {
    if (val === undefined || val === null || val === '') {
      return null;
    }
    if (typeof val !== 'string' || val.length > maxLength) {
      throw new ApiError(
        'Invalid text value.',
        400,
        'VALIDATION_FAILED',
        {
          field,
          messageKey: 'errors.validation.maxLength',
          params: { max: maxLength },
        },
        'errors.validation.maxLength',
      );
    }
    return val;
  }

  private toStandardDatetime(val: unknown, field: string): string {
    if (typeof val === 'string' && val.trim() !== '' && val.length <= 64) {
      const parsed = new Date(val);
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().replace('T', ' ').substring(0, 19);
      }
    }
    throw new ApiError(
      'Invalid date and time.',
      400,
      'VALIDATION_FAILED',
      {
        field,
        messageKey: 'errors.validation.datetime',
      },
      'errors.validation.datetime',
    );
  }

  private trimZeros(val: string): string {
    if (!val.includes('.')) return val;
    const trimmed = val.replace(/\.?0+$/, '');
    return trimmed === '' ? '0' : trimmed;
  }
}
