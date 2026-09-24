"use client";
/*
 * API client — W1 auth frontend, modern contract adaptation.
 *
 * Preserves 6F's security model (access token in memory only, HttpOnly
 * refresh_token cookie, single-flight refresh, envelope → data) but reconciled
 * to Modern @ 80f0ade + W0 landing architecture:
 *  - string IDs (Modern uses string ULIDs, not numbers)
 *  - fullName (not full_name)
 *  - UNAUTHENTICATED in REFRESHABLE (Modern answers protected-route failures
 *    with 401 UNAUTHENTICATED, not Legacy's 401 UNAUTHORIZED family — Stage 1 §C)
 *  - details.messageKey propagation (Modern error.details may carry messageKey)
 *  - no notificationLocale (Modern registerRequest: {email, password, locale, fullName, timezone})
 *  - no localStorage token fallback (memory only, purge legacy keys)
 *  - no locale headers (proxy owns locale)
 *  - same-origin fetch (no VELORA_API_ORIGIN rewrites in prod; dev rewrites below handle local API)
 */

export interface ApiErrorOptions {
  code?: string;
  status?: number;
  messageKey?: string;
  params?: Record<string, unknown>;
  details?: Record<string, unknown> | null;
}

export class ApiError extends Error {
  code: string;
  status: number;
  messageKey: string;
  params: Record<string, unknown>;
  details: Record<string, unknown> | null;
  constructor(message?: string, options: ApiErrorOptions = {}) {
    super(message || options.code || "API request failed");
    this.name = "ApiError";
    this.code = options.code || "API_ERROR";
    this.status = options.status || 0;
    this.messageKey = options.messageKey || "errors.api";
    this.params = options.params || {};
    this.details = options.details ?? null;
  }
}

export interface SessionUser {
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

export interface TokenPayload {
  accessToken: string;
  expiresIn?: number;
  tokenType?: string;
  user?: SessionUser;
  refreshToken?: unknown;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  token?: string;
  refresh?: boolean;
  retryAuth?: boolean;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  cache?: RequestCache;
}

let accessToken = "";
let currentUser: SessionUser | null = null;
let refreshInFlight: Promise<string> | null = null;
let sessionReady: Promise<SessionUser | null> | null = null;

function purgeLegacyAuthStorage(): void {
  try {
    window.localStorage.removeItem("tj_access_token");
    window.localStorage.removeItem("tj_refresh_token");
    window.localStorage.removeItem("tj_user");
    window.localStorage.removeItem("velora_access_token");
  } catch {
    /* ignore */
  }
}

function emitSession(): void {
  try {
    window.dispatchEvent(
      new CustomEvent("velora:session", { detail: { authenticated: !!accessToken, user: currentUser } }),
    );
  } catch {
    /* ignore */
  }
}

function emitUserLocale(user: SessionUser | null): void {
  try {
    const locale = user && user.locale ? String(user.locale) : "";
    if (locale && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(locale)) {
      window.dispatchEvent(new CustomEvent("velora:user-locale", { detail: { locale: locale.toLowerCase() } }));
    }
  } catch {
    /* ignore */
  }
}

export function getAccessToken(): string {
  return accessToken;
}
export function getUser(): SessionUser | null {
  return currentUser;
}

export function setSession(tokens: TokenPayload | undefined | null): string {
  if (tokens && Object.prototype.hasOwnProperty.call(tokens, "refreshToken")) {
    throw new ApiError("Refresh credentials are not accepted by browser JavaScript", {
      status: 500,
      code: "UNSAFE_AUTH_RESPONSE",
      messageKey: "errors.api",
    });
  }
  if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken) {
    throw new ApiError("Invalid auth response", {
      status: 401,
      code: "UNAUTHENTICATED",
      messageKey: "errors.unauthorized",
    });
  }
  accessToken = tokens.accessToken;
  // Modern returns user inside tokens.user (login/refresh) or via /me; keep latest.
  currentUser = (tokens.user as SessionUser) || currentUser || null;
  // Normalize id to string (Modern contracts: string IDs; 6F assumed number)
  if (currentUser && typeof currentUser.id === "number") {
    currentUser = { ...currentUser, id: String(currentUser.id) } as SessionUser;
  }
  sessionReady = Promise.resolve(currentUser);
  emitSession();
  if (currentUser) emitUserLocale(currentUser);
  return accessToken;
}

export function setUser(user: SessionUser | null): void {
  if (user && typeof (user as unknown as { id: unknown }).id === "number") {
    user = { ...user, id: String((user as unknown as { id: number }).id) } as SessionUser;
  }
  currentUser = user;
  emitSession();
}

export function clearAuth(): void {
  accessToken = "";
  currentUser = null;
  purgeLegacyAuthStorage();
  emitSession();
}

function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = request<{ tokens?: TokenPayload }>("/api/v1/auth/refresh", {
    method: "POST",
    token: "",
    refresh: false,
    retryAuth: false,
    body: {},
  })
    .then((payload) => setSession(payload && payload.tokens))
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export function ready(): Promise<SessionUser | null> {
  if (!sessionReady) {
    sessionReady = refreshAccessToken()
      .then(() => currentUser)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          clearAuth();
          return null;
        }
        throw error;
      });
  }
  return sessionReady;
}

export function resetSessionReady(): void {
  sessionReady = null;
}

export function logout(): Promise<void> {
  return request("/api/v1/auth/logout", { method: "POST", token: "", refresh: false, retryAuth: false, body: {} })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      clearAuth();
      sessionReady = null;
    });
}

// Modern contract reconciliation (Stage 1 §C, W1 matrix):
// - Modern protects routes with 401 UNAUTHENTICATED (not Legacy UNAUTHORIZED/INVALID_TOKEN)
// - Refreshable means "maybe the access token expired but the HttpOnly refresh cookie is still valid"
// - Terminal means "refresh will never help, clear state immediately"
const REFRESHABLE = ["UNAUTHENTICATED", "INVALID_TOKEN", "SESSION_EXPIRED", "REFRESH_COOKIE_MISSING", "UNAUTHORIZED", "ACCESS_TOKEN_MISSING", "SESSION_REVOKED"];
const TERMINAL = ["ACCOUNT_INACTIVE", "USER_NOT_FOUND", "EMAIL_NOT_VERIFIED"];
const AUTH_BOOTSTRAP_EXCLUDED = [
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  "/api/v1/auth/refresh",
  "/api/v1/auth/logout",
  "/api/v1/auth/forgot-password",
  "/api/v1/auth/reset-password",
  "/api/v1/auth/verify-email",
  "/api/v1/auth/resend-verification",
  "/api/v1/auth/resend-verification-email",
];

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  const authToken = options.token === undefined ? accessToken : options.token;
  if (authToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${authToken}`);
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body !== undefined && !isForm && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");

  const init: RequestInit = {
    method: options.method || (options.body === undefined ? "GET" : "POST"),
    headers,
    credentials: options.credentials || "same-origin",
    cache: options.cache || "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  };
  if (options.body !== undefined) {
    init.body = isForm || typeof options.body === "string" ? (options.body as BodyInit) : JSON.stringify(options.body);
  }

  const response = await fetch(path, init);
  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  const error = (payload && (payload.error as Record<string, unknown>)) || {};
  const code = String(error.code || "");
  const details = (error.details as Record<string, unknown>) || null;

  // Propagate details.messageKey if present (Modern error.details may carry i18n key)
  const detailMessageKey = details && typeof details.messageKey === "string" ? String(details.messageKey) : undefined;
  const detailParams = details && typeof details.params === "object" ? (details.params as Record<string, unknown>) : undefined;
  // The Modern envelope often carries interpolation values as SIBLINGS of
  // messageKey (e.g. {messageKey, plan, currentCount, maxAllowed}). When no
  // explicit params object exists, derive params from the remaining details —
  // excluding messageKey/field bookkeeping keys used only for routing.
  const derivedParams = (() => {
    if (!details || detailParams) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(details)) {
      if (k === "messageKey" || k === "field") continue;
      out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  })();

  const canRefresh =
    response.status === 401 &&
    options.refresh !== false &&
    options.retryAuth !== false &&
    !AUTH_BOOTSTRAP_EXCLUDED.includes(path) &&
    REFRESHABLE.includes(code);

  if (canRefresh) {
    const newToken = await refreshAccessToken().catch((refreshError: unknown) => {
      if (refreshError instanceof ApiError && refreshError.status === 401) clearAuth();
      throw refreshError;
    });
    return request<T>(path, { ...options, token: newToken, refresh: false });
  }

  if (response.status === 401 && TERMINAL.includes(code)) clearAuth();

  if (!response.ok || (payload && payload.status === "error")) {
    // Prefer detail messageKey if present, else error.messageKey, else http fallback
    const messageKey =
      detailMessageKey || (typeof error.messageKey === "string" ? String(error.messageKey) : undefined) || `errors.http.${response.status}`;
    const params = (detailParams as Record<string, unknown>) || (error.params as Record<string, unknown>) || derivedParams || {};
    const opts: ApiErrorOptions = {
      status: response.status,
      messageKey,
      params,
      ...(details ? { details: details as Record<string, unknown> } : {}),
      ...(code ? { code } : {}),
    };
    throw new ApiError(String(error.message || response.statusText), opts);
  }
  return (payload && Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload) as T;
}

if (typeof window !== "undefined") purgeLegacyAuthStorage();
