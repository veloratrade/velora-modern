"use client";
import * as api from "./client";

// --- Account & identity (Phase 1: /profile overview + /settings sections) -----
// Shapes mirror the Modern kernel handlers (`GET /api/v1/auth/me`,
// `POST /api/v1/auth/change-password`, `GET|PUT /api/v1/auth/email-preferences`,
// `PATCH /api/v1/auth/me/preferences`). Nothing here invents a field: the kernel
// answers `PublicUserDto` and the six email-preference keys by name.

/** `GET /api/v1/auth/me` payload (kernel PublicUserDto). */
export interface AccountUserView {
  id: string;
  email: string;
  fullName: string;
  role: string;
  plan: string;
  timezone: string;
  locale: string;
  createdAt: string;
  aiConsent: boolean;
}

/** The six categories the API stores — named exactly as the server names them. */
export type EmailPreferenceKey =
  | "welcome_email"
  | "security_alerts"
  | "trade_notifications"
  | "weekly_report"
  | "monthly_report"
  | "achievement_notifications";

export type EmailPreferences = Record<EmailPreferenceKey, 0 | 1>;

export function getMe(): Promise<{ user: AccountUserView }> {
  return api.request<{ user: AccountUserView }>("/api/v1/auth/me").then((data) => ({
    // Modern answers numeric ids on this route; the browser session normalizes
    // ids to strings (client.setSession), so normalize here too rather than let
    // one surface hold a number and the rest strings.
    user: { ...data.user, id: String(data.user.id) },
  }));
}

export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ changed: true; messageKey: string; params: Record<string, never> }> {
  return api.request("/api/v1/auth/change-password", { method: "POST", body: input });
}

export function getEmailPreferences(): Promise<{ preferences: EmailPreferences; messageKey?: string }> {
  return api.request("/api/v1/auth/email-preferences");
}

/**
 * Partial update: the server merges the booleans it recognises onto the stored
 * (or default) row, so an omitted category is never reset — Legacy's merge
 * semantics, preserved on both sides.
 */
export function updateEmailPreferences(patch: Partial<Record<EmailPreferenceKey, boolean>>): Promise<{ updated: true; preferences: EmailPreferences; messageKey?: string }> {
  return api.request("/api/v1/auth/email-preferences", { method: "PUT", body: patch });
}

export function updatePreferences(input: { locale?: "fa" | "en"; ai_consent?: boolean }): Promise<{ locale: string; ai_consent: boolean; ai_consent_at: string | null }> {
  return api.request("/api/v1/auth/me/preferences", { method: "PATCH", body: input });
}

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

/**
 * TRD-06 — ask for a sync now (POST /accounts/{id}/sync).
 *
 * Three outcomes, all of them ordinary: `queued` (202 — dispatched says whether
 * a queue accepted it immediately, deduplicated says the same window was already
 * queued), `up-to-date` (200 — the cursor is already at/after now) and a thrown
 * ApiError carrying the API's own code (`METAAPI_REQUIRED` for an account with
 * no provider link, `TOO_MANY_REQUESTS` past 20/300).
 */
export function triggerSync(accountId: string): Promise<{
  accountId: string;
  status: "queued" | "up-to-date";
  dispatched?: boolean;
  deduplicated?: boolean;
  window?: { from: string; to: string };
}> {
  return api.request(`/api/v1/accounts/${encodeURIComponent(accountId)}/sync`, { method: "POST", body: {} });
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
// SHAPES ARE THE API'S, NOT A GUESS. These interfaces used to declare
// `totalTrades`/`winningTrades`/`totalPnL`/`period` and an `equity`/`balance`
// curve point — none of which `/api/v1/analytics/*` returns. The dashboard read
// the invented names through `??` fallbacks and rendered 0 / a flat zero line
// with no error anywhere. The fields below mirror `SummaryMetrics`
// (`packages/domain/src/metrics.ts`), `EquityPointView` and the by-symbol
// projection in `apps/api/src/analytics`, and
// `apps/web/src/lib/api/analyticsContract.test.ts` compares them against the
// domain's real output so the two cannot drift again.
//
// Ratio and money fields are DECIMAL STRINGS at a fixed scale (ratios 4 dp,
// money 2 dp, R 8 dp) — the scale is part of the wire contract, so they are
// typed as strings and formatted, never parsed into money.

/**
 * The summary fields this client actually consumes, at runtime.
 *
 * `satisfies` ties every entry to the interface above (a typo or a removed field
 * fails the build), and `analyticsContract.test.ts` compares this list with the
 * keys the domain's `computeSummary` really returns — so the wire contract is
 * checked against the implementation, not against a comment.
 */
export const ANALYTICS_SUMMARY_FIELDS = [
  "tradeCount",
  "wins",
  "losses",
  "breakeven",
  "winRate",
  "totalPnl",
  "profitFactor",
  "averageR",
  "bestTrade",
  "worstTrade",
] as const satisfies readonly (keyof AnalyticsSummary)[];

/** One strategy group inside `/analytics/summary`. */
export interface AnalyticsStrategyRow extends AnalyticsSummary {
  strategy: string;
}

export interface AnalyticsSummary {
  tradeCount: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Ratio, 4 dp decimal string ("0.5333"). */
  winRate: string;
  /** Money, 2 dp decimal string. */
  totalPnl: string;
  /** Ratio, 4 dp decimal string; null means "no losses but some profit" (infinite). */
  profitFactor: string | null;
  /** Ratio, 4 dp decimal string. */
  averageR: string;
  bestTrade: string;
  worstTrade: string;
  /** Present on `/analytics/summary`. */
  byStrategy?: AnalyticsStrategyRow[];
  window?: { from: string | null; to: string | null; accountId: string | null };
}

/** One cumulative point of `/analytics/equity-curve`. */
export interface AnalyticsCurvePoint {
  /** Calendar day (UTC) the P&L belongs to. */
  day: string;
  /** Cumulative net P&L from the start of the window, 2 dp decimal string. */
  cumulativePnl: string;
}

/** One instrument group of `/analytics/by-symbol`. */
export interface AnalyticsSymbolRow extends AnalyticsSummary {
  symbol: string;
}

/** One weekday×hour bucket of `/analytics/heatmap`. */
export interface AnalyticsHeatmapCell {
  weekday: number;
  hour: number;
  metrics: AnalyticsSummary;
}

export function getAnalyticsSummary(params?: Record<string, string>): Promise<AnalyticsSummary> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.request(`/api/v1/analytics/summary${qs}`);
}

export function getEquityCurve(params?: Record<string, string>): Promise<{ points: AnalyticsCurvePoint[] }> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.request(`/api/v1/analytics/equity-curve${qs}`);
}

export function getHeatmap(params?: Record<string, string>): Promise<{ cells: AnalyticsHeatmapCell[] }> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return api.request(`/api/v1/analytics/heatmap${qs}`);
}

export function getBySymbol(params?: Record<string, string>): Promise<{ symbols: AnalyticsSymbolRow[] }> {
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
