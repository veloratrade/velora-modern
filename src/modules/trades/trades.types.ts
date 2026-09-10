export type TradeDirection = 'buy' | 'sell';
export type TradeSource = 'manual' | 'metaapi' | 'import';
export type TradeExitType = 'tp' | 'sl' | 'manual' | 'partial';

export interface CreateTradeInput {
  symbol: string;
  direction: TradeDirection;
  entryPrice: string;
  exitPrice: string;
  volume: string;
  contractSize?: string;
  commission?: string;
  swap?: string;
  stopLoss?: string | null;
  takeProfit?: string | null;
  accountId?: number | string | null;
  openTime: string;
  closeTime: string;
  strategyTag?: string | null;
  emotionalScore?: number | string | null;
  notes?: string | null;
}

export interface UpdateTradeInput extends Partial<CreateTradeInput> {}

export interface TradeFilter {
  userId: number;
  symbol?: string;
  direction?: string;
  startDate?: string;
  endDate?: string;
  from?: string;
  to?: string;
  q?: string;
}

export interface PaginationOptions {
  page: number;
  limit: number;
  order?: string;
}

export interface CreateTradeExitInput {
  exitType: TradeExitType;
  exitPrice: string;
  volume: string;
  exitedAt: string;
  notes?: string | null;
}

export interface TradeSerialized {
  id: number;
  symbol: string;
  direction: string;
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
  accountId: number | null;
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
  session: string;
  strategyTag: string | null;
  emotionalScore: number | null;
  notes: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface TradeExitSerialized {
  id: number;
  tradeId: number;
  exitType: string;
  exitPrice: string;
  volume: string;
  pnl: string;
  exitedAt: string;
  notes: string | null;
}
