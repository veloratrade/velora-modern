/*
 * Raw-value normalizers — port of legacy `velora-data.js` `raw` + `normalize`.
 * Financial decimals stay strings until a render boundary; naive wall-clock
 * strings are never parsed to instants.
 */
type Raw = Record<string, unknown>;

export function text(value: unknown, fallback: string | null = null): string | null {
  return value === undefined || value === null ? fallback : String(value);
}
export function decimal(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s) ? s : null;
}
export function integer(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
export function isoDate(value: unknown): string | null {
  if (!value) return null;
  const input = String(value).trim();
  if (/(Z$|[+-]\d{2}:?\d{2}$)/i.test(input)) {
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
export function rawWall(value: unknown): string | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) ? s.replace('T', ' ') : null;
}

function pick(raw: Raw, camel: string, snake: string): unknown {
  return raw[camel] !== undefined ? raw[camel] : raw[snake];
}

export interface Trade {
  id: number | null;
  accountId: number | null;
  symbol: string;
  direction: string;
  entryPrice: string | null;
  exitPrice: string | null;
  volume: string | null;
  profitLoss: string | null;
  rMultiple: string | null;
  commission: string | null;
  swap: string | null;
  currency: string;
  strategyTag: string | null;
  notes: string | null;
  source: string;
  occurredOpenAtUtc: string | null;
  occurredCloseAtUtc: string | null;
  openTime: string | null;
  closeTime: string | null;
  createdAt: string | null;
  stopLoss: string | null;
  takeProfit: string | null;
  status: string | null;
}

export function normalizeTrade(input: unknown): Trade {
  const raw = (input || {}) as Raw;
  return Object.freeze({
    id: integer(raw.id),
    accountId: integer(pick(raw, 'accountId', 'account_id')),
    symbol: text(raw.symbol, '') as string,
    direction: (text(raw.direction, '') as string).toLowerCase(),
    entryPrice: decimal(pick(raw, 'entryPrice', 'entry_price')),
    exitPrice: decimal(pick(raw, 'exitPrice', 'exit_price')),
    volume: decimal(raw.volume),
    profitLoss: decimal(pick(raw, 'profitLoss', 'profit_loss')),
    rMultiple: decimal(pick(raw, 'rMultiple', 'r_multiple')),
    commission: decimal(raw.commission),
    swap: decimal(raw.swap),
    currency: (text(raw.currency, 'USD') as string).toUpperCase(),
    strategyTag: text(pick(raw, 'strategyTag', 'strategy_tag')),
    notes: text(raw.notes),
    source: text(raw.source, 'manual') as string,
    occurredOpenAtUtc: text(pick(raw, 'occurredOpenAtUtc', 'occurred_open_at_utc')),
    occurredCloseAtUtc: text(pick(raw, 'occurredCloseAtUtc', 'occurred_close_at_utc')),
    openTime: rawWall(pick(raw, 'openTime', 'open_time')),
    closeTime: rawWall(pick(raw, 'closeTime', 'close_time')),
    createdAt: rawWall(pick(raw, 'createdAt', 'created_at')),
    stopLoss: decimal(pick(raw, 'stopLoss', 'stop_loss')),
    takeProfit: decimal(pick(raw, 'takeProfit', 'take_profit')),
    status: text(raw.status),
  });
}

export interface Account {
  id: number | null;
  label: string | null;
  login: string | null;
  server: string | null;
  broker: string | null;
  platform: string | null;
  status: string;
  syncStatus: string;
  balance: string | null;
  equity: string | null;
  leverage: string | null;
  currency: string;
  lastSyncedAt: string | null;
}

export function normalizeAccount(input: unknown): Account {
  const raw = (input || {}) as Raw;
  const last = pick(raw, 'lastSyncedAt', 'last_synced_at');
  return Object.freeze({
    id: integer(raw.id),
    label: text(raw.label),
    login: text(pick(raw, 'mtLogin', 'mt_login')),
    server: text(raw.server),
    broker: text(raw.broker),
    platform: text(pick(raw, 'platform', 'provider')),
    status: (text(raw.status, 'unknown') as string).toLowerCase(),
    syncStatus: (text(pick(raw, 'syncStatus', 'sync_status'), 'unknown') as string).toLowerCase(),
    balance: decimal(raw.balance),
    equity: decimal(raw.equity),
    leverage: decimal(raw.leverage),
    currency: (text(raw.currency, 'USD') as string).toUpperCase(),
    lastSyncedAt: isoDate(last) || rawWall(last),
  });
}
