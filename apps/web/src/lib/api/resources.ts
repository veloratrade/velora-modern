"use client";
import * as api from "./client";

// --- Accounts ---
export interface AccountRecord {
  id: string;
  userId: string;
  provider: "MT4" | "MT5" | "MANUAL";
  platform: string;
  label: string;
  accountNumber: string;
  currency: string;
  leverage: string;
  timezone: string | null;
  timezoneSource: string;
  status: "connected" | "error" | "disconnected";
  syncStatus: "DISCONNECTED" | "CONNECTING" | "SYNCING" | "CONNECTED" | "ERROR";
  balance: string;
  equity: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  provider: string;
  label?: string;
  accountNumber?: string;
  currency?: string;
  leverage?: string;
  timezone?: string;
  status?: string;
}

export function listAccounts(): Promise<{ accounts: AccountRecord[] } | AccountRecord[]> {
  return api.request("/api/v1/accounts");
}

export function createAccount(input: CreateAccountInput): Promise<{ account: AccountRecord } | AccountRecord> {
  return api.request("/api/v1/accounts", { method: "POST", body: input });
}

export function detectServer(mtLogin: string): Promise<{ mt_login: string; suggestedServers: string[]; allServers: string[]; messageKey: string; nextStepKey: string }> {
  return api.request("/api/v1/accounts/detect-server", { method: "POST", body: { mt_login: mtLogin } });
}

export interface SyncStatusView {
  accountId: string;
  userId: string;
  provider: string;
  metaapiConnected: boolean;
  syncStatus: string;
  lastSyncAt: string | null;
  consecutiveErrors: number;
  connectedAt: string | null;
  metaapiAccountId: string | null;
}

export function getSyncStatus(accountId: string): Promise<SyncStatusView> {
  return api.request(`/api/v1/accounts/${encodeURIComponent(accountId)}/sync-status`);
}

export function connectMetaApi(accountId: string): Promise<{ accountId: string; metaapiAccountId: string; status: string; alreadyConnected?: boolean }> {
  return api.request(`/api/v1/accounts/${encodeURIComponent(accountId)}/metaapi/connect`, { method: "POST", body: {} });
}

export function disconnectMetaApi(accountId: string): Promise<{ accountId: string; status: string }> {
  return api.request(`/api/v1/accounts/${encodeURIComponent(accountId)}/metaapi/disconnect`, { method: "POST", body: {} });
}

// --- Credentials ---
export interface CredentialMeta {
  id: string;
  userId: string;
  provider: "METAAPI";
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export function listCredentials(): Promise<{ credentials: CredentialMeta[] }> {
  return api.request("/api/v1/credentials");
}

export function createCredential(provider: "METAAPI", secret: string): Promise<{ credential: CredentialMeta } | CredentialMeta> {
  return api.request("/api/v1/credentials", { method: "POST", body: { provider, secret } });
}

export function deleteCredential(id: string): Promise<{ deleted: boolean }> {
  return api.request(`/api/v1/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// --- Trades ---
export interface TradeRecord {
  id: string;
  symbol: string;
  direction: "buy" | "sell";
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
  accountId: string | null;
  openTime: string;
  closeTime: string;
  timeStatus: string;
  sourceTimezone: string | null;
  strategyTag: string | null;
  emotionalScore: number | null;
  notes: string | null;
  source: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TradeExitRecord {
  id: string;
  tradeId: string;
  exitType: "tp" | "sl" | "manual" | "partial";
  exitPrice: string;
  volume: string;
  exitedAt: string;
  notes: string | null;
  profitLoss: string;
}

export function listTrades(params?: Record<string, string>): Promise<{ items: TradeRecord[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.request(`/api/v1/trades${qs}`);
}

export function createTrade(input: Record<string, unknown>): Promise<{ trade: TradeRecord } | TradeRecord> {
  return api.request("/api/v1/trades", { method: "POST", body: input });
}

export function getTrade(id: string): Promise<{ trade: TradeRecord } | TradeRecord> {
  return api.request(`/api/v1/trades/${encodeURIComponent(id)}`);
}

export function updateTrade(id: string, input: Record<string, unknown>): Promise<{ trade: TradeRecord } | TradeRecord> {
  return api.request(`/api/v1/trades/${encodeURIComponent(id)}`, { method: "PUT", body: input });
}

export function deleteTrade(id: string): Promise<{ deleted: boolean }> {
  return api.request(`/api/v1/trades/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function listTradeExits(tradeId: string): Promise<{ items: TradeExitRecord[] }> {
  return api.request(`/api/v1/trades/${encodeURIComponent(tradeId)}/exits`);
}

export function createTradeExit(tradeId: string, input: Record<string, unknown>): Promise<{ exit: TradeExitRecord }> {
  return api.request(`/api/v1/trades/${encodeURIComponent(tradeId)}/exits`, { method: "POST", body: input });
}

export function getTradeSymbols(): Promise<{ symbols: string[] }> {
  return api.request("/api/v1/trades/symbols");
}

// --- Analytics ---
export interface AnalyticsSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  totalPnL: string;
  avgWin: string;
  avgLoss: string;
  bestTrade: string;
  worstTrade: string;
  maxDrawdown: string;
  sharpeRatio?: number;
  period?: { from: string | null; to: string | null };
}

export function getAnalyticsSummary(params?: Record<string, string>): Promise<AnalyticsSummary> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.request(`/api/v1/analytics/summary${qs}`);
}

export function getEquityCurve(params?: Record<string, string>): Promise<{ points: Array<{ date: string; equity: string; balance: string }> }> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.request(`/api/v1/analytics/equity-curve${qs}`);
}

export function getHeatmap(params?: Record<string, string>): Promise<{ cells: Array<{ day: string; hour: number; pnl: string; count: number }> }> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.request(`/api/v1/analytics/heatmap${qs}`);
}

export function getBySymbol(params?: Record<string, string>): Promise<{ symbols: Array<{ symbol: string; trades: number; pnl: string; winRate: number }> }> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.request(`/api/v1/analytics/by-symbol${qs}`);
}

// --- Telegram (journal client, ADR-018) ---
// Mirrors the shapes `apps/api/src/telegram/telegramRoutes.ts` answers. The web
// app never sends a user id, an account id or a Telegram id: the API resolves all
// three from the bearer claims, and this surface only ever describes the RESULT.

/** The six states the Settings screen must be able to tell apart. */
export type TelegramLinkState = "NOT_LINKED" | "LINK_PENDING" | "LINKED" | "LINK_EXPIRED" | "LINK_REVOKED" | "LINK_ERROR";

export interface TelegramIdentityView {
  /** Last four digits only — the API never sends the full Telegram id. */
  maskedTelegramUserId: string;
  username: string | null;
  linkedAt: string;
  lastSeenAt: string | null;
}

export interface TelegramChannelView {
  title: string;
  chatType: string;
  status: string;
  canPost: boolean;
  verifiedAt: string | null;
}

export interface TelegramStatusView {
  bot: { username: string | null; deepLinkAvailable: boolean };
  updateMode: "off" | "polling" | "webhook";
  state: TelegramLinkState;
  identity: TelegramIdentityView | null;
  pendingLinkExpiresAt: string | null;
  channel: TelegramChannelView | null;
}

export function getTelegramStatus(): Promise<TelegramStatusView> {
  return api.request("/api/v1/telegram/status");
}

/** Mint the one-time deep link. The returned token is opaque and single-use. */
export function startTelegramLink(): Promise<{ deepLink: string; expiresAt: string }> {
  return api.request("/api/v1/telegram/link/start", { method: "POST", body: {} });
}

export function unlinkTelegram(): Promise<{ unlinked: boolean }> {
  return api.request("/api/v1/telegram/link/unlink", { method: "POST", body: {} });
}

export function getTelegramChannel(): Promise<{ channel: TelegramChannelView | null }> {
  return api.request("/api/v1/telegram/channel");
}

/** Channel BINDING is Telegram-only (the server verifies posting rights); the web
 *  can only unbind something the caller owns. */
export function unbindTelegramChannel(): Promise<{ channel: null }> {
  return api.request("/api/v1/telegram/channel", { method: "DELETE" });
}
