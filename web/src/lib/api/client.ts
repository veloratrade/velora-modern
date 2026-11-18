/*
 * Language-neutral client data layer — TypeScript port of legacy
 * `public/assets/velora-data.js`.
 *
 * Contract preserved (and matching velora-modern `src/modules/auth`):
 *  - access token + user live in memory only (SECURITY_REQUIREMENTS §30)
 *  - refresh token is an HttpOnly cookie; `POST /api/v1/auth/refresh` with
 *    `credentials: 'same-origin'` rotates it
 *  - a 401 with a refreshable code triggers ONE refresh + retry
 *  - `{ status, data, error }` envelope → resolves with `data`
 *  - never attaches locale headers; never transforms values
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
    super(message || options.code || 'API request failed');
    this.name = 'ApiError';
    this.code = options.code || 'API_ERROR';
    this.status = options.status || 0;
    this.messageKey = options.messageKey || 'errors.api';
    this.params = options.params || {};
    this.details = options.details ?? null;
  }
}

export interface SessionUser {
  id: number;
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

let accessToken = '';
let currentUser: SessionUser | null = null;
let refreshInFlight: Promise<string> | null = null;
let sessionReady: Promise<SessionUser | null> | null = null;

function purgeLegacyAuthStorage(): void {
  try {
    window.localStorage.removeItem('tj_access_token');
    window.localStorage.removeItem('tj_refresh_token');
    window.localStorage.removeItem('tj_user');
  } catch {
    /* ignore */
  }
}

function emitSession(): void {
  try {
    window.dispatchEvent(
      new CustomEvent('velora:session', { detail: { authenticated: !!accessToken, user: currentUser } }),
    );
  } catch {
    /* ignore */
  }
}

function emitUserLocale(user: SessionUser | null): void {
  try {
    const locale = user && user.locale ? String(user.locale) : '';
    if (locale && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(locale)) {
      window.dispatchEvent(new CustomEvent('velora:user-locale', { detail: { locale: locale.toLowerCase() } }));
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
  if (tokens && Object.prototype.hasOwnProperty.call(tokens, 'refreshToken')) {
    throw new ApiError('Refresh credentials are not accepted by browser JavaScript', {
      status: 500,
      code: 'UNSAFE_AUTH_RESPONSE',
      messageKey: 'errors.api',
    });
  }
  if (!tokens || typeof tokens.accessToken !== 'string' || !tokens.accessToken) {
    throw new ApiError('Invalid auth response', { status: 401, code: 'UNAUTHORIZED', messageKey: 'errors.unauthorized' });
  }
  accessToken = tokens.accessToken;
  currentUser = tokens.user || currentUser || null;
  sessionReady = Promise.resolve(currentUser);
  emitSession();
  if (currentUser) emitUserLocale(currentUser);
  return accessToken;
}

export function setUser(user: SessionUser | null): void {
  currentUser = user;
  emitSession();
}

export function clearAuth(): void {
  accessToken = '';
  currentUser = null;
  purgeLegacyAuthStorage();
  emitSession();
}

function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = request<{ tokens?: TokenPayload }>('/api/v1/auth/refresh', {
    method: 'POST',
    token: '',
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
  return request('/api/v1/auth/logout', { method: 'POST', token: '', refresh: false, retryAuth: false, body: {} })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      clearAuth();
      sessionReady = null;
    });
}

const REFRESHABLE = ['UNAUTHORIZED', 'ACCESS_TOKEN_MISSING', 'INVALID_TOKEN', 'SESSION_REVOKED'];
const TERMINAL = ['ACCOUNT_INACTIVE', 'USER_NOT_FOUND'];
const AUTH_BOOTSTRAP_EXCLUDED = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-verification',
  '/api/v1/auth/resend-verification-email',
];

export async function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  const authToken = options.token === undefined ? accessToken : options.token;
  if (authToken && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${authToken}`);
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body !== undefined && !isForm && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const init: RequestInit = {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers,
    credentials: options.credentials || 'same-origin',
    cache: options.cache || 'no-store',
    signal: options.signal,
  };
  if (options.body !== undefined) {
    init.body = isForm || typeof options.body === 'string' ? (options.body as BodyInit) : JSON.stringify(options.body);
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
  const code = String(error.code || '');

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

  if (!response.ok || (payload && payload.status === 'error')) {
    throw new ApiError(String(error.message || response.statusText), {
      code: code || undefined,
      status: response.status,
      messageKey: (error.messageKey as string) || `errors.http.${response.status}`,
      params: error.params as Record<string, unknown>,
      details: error.details as Record<string, unknown> | null,
    });
  }
  return (payload && Object.prototype.hasOwnProperty.call(payload, 'data') ? payload.data : payload) as T;
}

if (typeof window !== 'undefined') purgeLegacyAuthStorage();
