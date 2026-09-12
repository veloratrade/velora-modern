// Auth HTTP contract tests — Phase C identity port. Kernel-level evidence over
// real HTTP (in-process fetch) with the real service on the in-memory store.
// Contract shapes are Remote/PHP-verified (auth.routes.ts, AuthController);
// error-object exact PHP fields remain fixture-pending (C2 inventory).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "./authService.js";
import { MemoryUserStore } from "./memoryUserStore.js";
import { VeloraHasher } from "./hashing.js";
import { JwtService } from "./jwt.js";

const SECRET = "auth-routes-test-secret-0123456789abcdefghij"; // 42 chars, test-only

async function withAuthServer(
  fn: (base: string, tokens: string[]) => Promise<void>,
  opts: { configureAuth?: boolean } = {},
): Promise<void> {
  const configureAuth = opts.configureAuth ?? true;
  // Per-server token capture — no cross-test state (test isolation).
  const tokens: string[] = [];
  const auth = configureAuth
    ? new AuthService({
        store: new MemoryUserStore(),
        hasher: new VeloraHasher(),
        jwt: JwtService.create(SECRET),
        generateVerificationToken: () => {
          const t = `route-test-verification-token-${Math.random().toString(36).slice(2)}-0123456789`;
          tokens.push(t);
          return t;
        },
      })
    : undefined;
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    ...(auth !== undefined ? { auth } : {}),
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`, tokens);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string; requestId?: string; details?: Record<string, string> } | null;
  timestamp: string;
}

async function post(base: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("register: 201 + 4-field envelope + verificationRequired; tokens never in body", async () => {
  await withAuthServer(async (base) => {
    const res = await fetch(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "route@velora.example", password: "a-strong-password-123", fullName: "Route Test" }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as Envelope<{ verificationRequired: boolean; email: string }>;
    assert.equal(body.status, "success");
    assert.equal(body.error, null);
    assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
    assert.equal(body.data.verificationRequired, true);
    assert.equal(body.data.email, "route@velora.example");
    assert.ok(!JSON.stringify(body).includes("accessToken"));
    assert.ok(!JSON.stringify(body).includes("refreshToken"));
  });
});

test("register: validation failure → 400 VALIDATION_FAILED with details", async () => {
  await withAuthServer(async (base) => {
    const res = await fetch(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "short" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Envelope<null>;
    assert.equal(body.status, "error");
    assert.equal(body.error?.code, "VALIDATION_FAILED");
    assert.ok(body.error?.details && Object.keys(body.error.details).length >= 2);
  });
});

test("register: malformed JSON body → 400 VALIDATION_FAILED", async () => {
  await withAuthServer(async (base) => {
    const res = await fetch(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as Envelope<null>).error?.code, "VALIDATION_FAILED");
  });
});

test("FULL HTTP JOURNEY: register → verify-email → login → me → refresh → logout", async () => {
  await withAuthServer(async (base, tokens) => {
    // 1. register (token captured by the injected generator — Phase I email path stub)
    const reg = await fetch(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "journey@velora.example", password: "a-strong-password-123", fullName: "Journey" }),
    });
    assert.equal(reg.status, 201);
    const verificationToken = tokens.shift();

    // 2. unverified login is rejected with the Remote-verified code
    const unv = await post(base, "/api/v1/auth/login", { email: "journey@velora.example", password: "a-strong-password-123" });
    assert.equal(unv.status, 401);
    assert.equal((unv.body as Envelope<null>).error?.code, "EMAIL_NOT_VERIFIED");

    // 3. verify-email over HTTP
    const ver = await post(base, "/api/v1/auth/verify-email", { token: verificationToken });
    assert.equal(ver.status, 200);
    assert.deepEqual(
      ((ver.body as Envelope<{ verified: boolean; alreadyVerified: boolean; messageKey: string }>).data),
      { verified: true, alreadyVerified: false, messageKey: "auth.emailVerified", params: {} },
    );

    // 4. login → 200 {tokens} + exact refresh cookie; refresh token NOT in body
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "journey@velora.example", password: "a-strong-password-123" }),
    });
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as Envelope<{
      tokens: { accessToken: string; expiresIn: number; tokenType: string; user: { email: string; plan: string } };
    }>;
    assert.equal(loginBody.status, "success");
    const tokensBody = loginBody.data.tokens;
    assert.equal(tokensBody.expiresIn, 900);
    assert.equal(tokensBody.tokenType, "Bearer");
    assert.equal(tokensBody.user.email, "journey@velora.example");
    assert.equal(tokensBody.user.plan, "free");
    assert.ok(!JSON.stringify(loginBody).includes("refreshToken"));
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.startsWith("refresh_token="), "cookie name");
    assert.ok(setCookie.includes("Path=/; HttpOnly; Secure; SameSite=Lax"), "cookie attrs");
    assert.ok(setCookie.includes("Max-Age=2592000"), "cookie max-age (30 days)");
    const refreshToken = /refresh_token=([^;]+)/.exec(setCookie)?.[1] ?? "";

    // 5. /me with Bearer token
    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${tokensBody.accessToken}` } });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as Envelope<{ user: { email: string; fullName: string } }>;
    assert.equal(meBody.data.user.email, "journey@velora.example");
    assert.equal(meBody.data.user.fullName, "Journey");

    // 6. refresh via cookie → rotated cookie + new tokens
    const refresh = await fetch(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { Cookie: `refresh_token=${refreshToken}` },
    });
    assert.equal(refresh.status, 200);
    const refreshBody = (await refresh.json()) as Envelope<{ tokens: { accessToken: string } }>;
    assert.notEqual(refreshBody.data.tokens.accessToken, tokensBody.accessToken);
    const rotatedCookie = refresh.headers.get("set-cookie") ?? "";
    const rotatedToken = /refresh_token=([^;]+)/.exec(rotatedCookie)?.[1] ?? "";
    assert.notEqual(rotatedToken, refreshToken);

    // 7. old refresh token no longer works (rotation) → 401 + cookie cleared
    const oldRefresh = await fetch(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { Cookie: `refresh_token=${refreshToken}` },
    });
    assert.equal(oldRefresh.status, 401);
    assert.equal(((await oldRefresh.json()) as Envelope<null>).error?.code, "INVALID_TOKEN");
    assert.ok((oldRefresh.headers.get("set-cookie") ?? "").includes("Max-Age=0"));

    // 8. logout with the rotated cookie → revoked + cookie cleared
    const logout = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: `refresh_token=${rotatedToken}`, Origin: "https://veloratrade.ir" },
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(((await logout.json()) as Envelope<{ loggedOut: boolean }>).data, { loggedOut: true });
    assert.ok((logout.headers.get("set-cookie") ?? "").includes("Max-Age=0"));

    // 9. post-logout refresh → INVALID_TOKEN
    const after = await fetch(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { Cookie: `refresh_token=${rotatedToken}` },
    });
    assert.equal(after.status, 401);
    assert.equal(((await after.json()) as Envelope<null>).error?.code, "INVALID_TOKEN");
  });
});

test("auth guard: /me without/with-invalid Bearer → 401 UNAUTHENTICATED", async () => {
  await withAuthServer(async (base) => {
    const me = await fetch(`${base}/api/v1/auth/me`);
    assert.equal(me.status, 401);
    assert.equal(((await me.json()) as Envelope<null>).error?.code, "UNAUTHENTICATED");
    const meBad = await fetch(`${base}/api/v1/auth/me`, { headers: { Authorization: "Bearer not-a-jwt" } });
    assert.equal(meBad.status, 401);
  });
});

test("refresh: missing cookie/body → 401 REFRESH_COOKIE_MISSING + clearing cookie", async () => {
  await withAuthServer(async (base) => {
    const res = await fetch(`${base}/api/v1/auth/refresh`, { method: "POST" });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Envelope<null>;
    assert.equal(body.error?.code, "REFRESH_COOKIE_MISSING");
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("refresh_token=;"));
    assert.ok(setCookie.includes("Max-Age=0"));
  });
});

test("logout: origin guard preserved (403 ORIGIN_REJECTED / 200 + cleared cookie)", async () => {
  await withAuthServer(async (base) => {
    const evil = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(evil.status, 403);
    assert.equal(((await evil.json()) as Envelope<null>).error?.code, "ORIGIN_REJECTED");

    const good = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: "https://veloratrade.ir" },
    });
    assert.equal(good.status, 200);
    const body = (await good.json()) as Envelope<{ loggedOut: boolean }>;
    assert.deepEqual(body.data, { loggedOut: true });
    assert.ok((good.headers.get("set-cookie") ?? "").includes("Max-Age=0"));
  });
});

test("auth routes fail closed (503 SERVICE_UNAVAILABLE) when the capability is unconfigured", async () => {
  await withAuthServer(
    async (base) => {
      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x@velora.example", password: "a-strong-password-123" }),
      });
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as Envelope<null>).error?.code, "SERVICE_UNAVAILABLE");
    },
    { configureAuth: false },
  );
});

test("IDENTITY COMPLETION: change-password journey (wrong current → change → sessions revoked → new login)", async () => {
  await withAuthServer(async (base, tokens) => {
    // setup: registered + verified user with an active session
    await post(base, "/api/v1/auth/register", { email: "chg@velora.example", password: "first-strong-password-1" });
    await post(base, "/api/v1/auth/verify-email", { token: tokens.shift() });
    const login1 = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "chg@velora.example", password: "first-strong-password-1" }),
    });
    const refreshToken = /refresh_token=([^;]+)/.exec(login1.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const accessToken = ((await login1.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;

    // wrong current password → 400 VALIDATION_FAILED + details.currentPassword
    const wrong = await fetch(`${base}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ currentPassword: "wrong-current-password-9", newPassword: "second-strong-password-2" }),
    });
    assert.equal(wrong.status, 400);
    const wrongBody = (await wrong.json()) as Envelope<null>;
    assert.equal(wrongBody.error?.code, "VALIDATION_FAILED");
    assert.ok(wrongBody.error?.details && "currentPassword" in wrongBody.error.details);

    // identical password → 400 + details.newPassword
    const same = await fetch(`${base}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ currentPassword: "first-strong-password-1", newPassword: "first-strong-password-1" }),
    });
    assert.equal(same.status, 400);
    assert.ok("newPassword" in (((await same.json()) as Envelope<null>).error?.details ?? {}));

    // unauthenticated → 401
    const unauth = await fetch(`${base}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "a", newPassword: "b" }),
    });
    assert.equal(unauth.status, 401);

    // success → {changed, messageKey, params}
    const okRes = await fetch(`${base}/api/v1/auth/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ currentPassword: "first-strong-password-1", newPassword: "second-strong-password-2" }),
    });
    assert.equal(okRes.status, 200);
    assert.deepEqual(((await okRes.json()) as Envelope<{ changed: boolean; messageKey: string }>).data, {
      changed: true,
      messageKey: "auth.passwordChanged",
      params: {},
    });

    // the pre-change refresh session is revoked
    const deadRefresh = await fetch(`${base}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { Cookie: `refresh_token=${refreshToken}` },
    });
    assert.equal(deadRefresh.status, 401);

    // old password no longer logs in; the new one does
    const oldLogin = await post(base, "/api/v1/auth/login", { email: "chg@velora.example", password: "first-strong-password-1" });
    assert.equal(oldLogin.status, 401);
    const newLogin = await post(base, "/api/v1/auth/login", { email: "chg@velora.example", password: "second-strong-password-2" });
    assert.equal(newLogin.status, 200);
  });
});

test("PREFERENCES: PATCH /me/preferences (locale + ai_consent) contract", async () => {
  await withAuthServer(async (base, tokens) => {
    await post(base, "/api/v1/auth/register", { email: "pref@velora.example", password: "a-strong-password-123" });
    await post(base, "/api/v1/auth/verify-email", { token: tokens.shift() });
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "pref@velora.example", password: "a-strong-password-123" }),
    });
    const accessToken = ((await login.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };

    // no field → 400
    const none = await fetch(`${base}/api/v1/auth/me/preferences`, { method: "PATCH", headers: auth, body: "{}" });
    assert.equal(none.status, 400);
    // invalid locale → 400 with details
    const badLocale = await fetch(`${base}/api/v1/auth/me/preferences`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ locale: "fr" }),
    });
    assert.equal(badLocale.status, 400);
    // unauthenticated → 401
    const unauth = await fetch(`${base}/api/v1/auth/me/preferences`, { method: "PATCH", body: "{}" });
    assert.equal(unauth.status, 401);

    // both fields → Remote-verified response shape
    const both = await fetch(`${base}/api/v1/auth/me/preferences`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ locale: "en", ai_consent: true }),
    });
    assert.equal(both.status, 200);
    const body = (await both.json()) as Envelope<{ updated: boolean; locale: string; ai_consent: boolean; ai_consent_at: string | null }>;
    assert.equal(body.data.updated, true);
    assert.equal(body.data.locale, "en");
    assert.equal(body.data.ai_consent, true);
    assert.ok(body.data.ai_consent_at !== null);

    // ai_consent=false clears the timestamp
    const off = await fetch(`${base}/api/v1/auth/me/preferences`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ ai_consent: false }),
    });
    assert.equal(((await off.json()) as Envelope<{ ai_consent: boolean; ai_consent_at: string | null }>).data.ai_consent_at, null);
  });
});

test("EMAIL PREFERENCES: GET defaults (PHP 6-key shape, all ON) + PUT partial merge", async () => {
  await withAuthServer(async (base, tokens) => {
    await post(base, "/api/v1/auth/register", { email: "emailpref@velora.example", password: "a-strong-password-123" });
    await post(base, "/api/v1/auth/verify-email", { token: tokens.shift() });
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "emailpref@velora.example", password: "a-strong-password-123" }),
    });
    const accessToken = ((await login.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` };

    // unauthenticated → 401
    assert.equal((await fetch(`${base}/api/v1/auth/email-preferences`)).status, 401);

    // GET: PHP defaults — 6 keys, all 1, ints not booleans; marketing_emails absent
    const get = await fetch(`${base}/api/v1/auth/email-preferences`, { headers: { Authorization: `Bearer ${accessToken}` } });
    assert.equal(get.status, 200);
    const getBody = (await get.json()) as Envelope<{ preferences: Record<string, number>; messageKey: string }>;
    assert.deepEqual(getBody.data.preferences, {
      welcome_email: 1, security_alerts: 1, trade_notifications: 1,
      weekly_report: 1, monthly_report: 1, achievement_notifications: 1,
    });
    assert.equal(getBody.data.messageKey, "auth.emailPreferences");
    assert.ok(!("marketing_emails" in getBody.data.preferences));

    // PUT partial: only known boolean keys merge; no category silently resets
    const put = await fetch(`${base}/api/v1/auth/email-preferences`, {
      method: "PUT", headers: auth,
      body: JSON.stringify({ weekly_report: false, marketing_emails: true, monthly_report: "yes" }),
    });
    assert.equal(put.status, 200);
    const putBody = (await put.json()) as Envelope<{ updated: boolean; preferences: Record<string, number>; messageKey: string }>;
    assert.equal(putBody.data.updated, true);
    assert.equal(putBody.data.messageKey, "auth.emailPreferencesUpdated");
    assert.equal(putBody.data.preferences.weekly_report, 0);
    assert.equal(putBody.data.preferences.monthly_report, 1);
    assert.equal(putBody.data.preferences.welcome_email, 1);
    assert.ok(!("marketing_emails" in putBody.data.preferences));
  });
});
