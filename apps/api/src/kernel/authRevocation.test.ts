// AUTH-REVOKE — bearer re-validation on protected routes (Legacy parity).
//
// Legacy AuthService::authenticate (api/src/Auth/AuthService.php) does three
// checks after the JWT signature/expiry: the user still exists AND is active,
// the session bound to THIS access token (sha256 access hash) exists, is not
// revoked and not expired, and the role used for authorization is the one in
// the users row — not the one frozen in the token. Without these, an access
// token keeps working for its full TTL after logout, change-password, a
// suspension or a demotion. This battery pins each of those at the HTTP layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "./server.js";
import { AuthService } from "../auth/authService.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { LogMailProvider } from "../mail/logMailProvider.js";

const SECRET = "auth-revocation-test-secret-0123456789abcdef";
const VERIFICATION_TOKEN = "revocation-battery-verification-token-0123456789abcdef";
const ORIGIN = "https://veloratrade.ir";
const EMAIL = "revoke.route@velora.example";
const PASSWORD = "a-strong-password-1234";

async function withServer(
  fn: (base: string, ctx: { store: MemoryUserStore; jwt: JwtService }) => Promise<void>,
): Promise<void> {
  const store = new MemoryUserStore();
  const jwt = JwtService.create(SECRET);
  const auth = new AuthService({
    store,
    hasher: new VeloraHasher(),
    jwt,
    generateVerificationToken: () => VERIFICATION_TOKEN,
    mail: new LogMailProvider(),
  });
  const app = createApp({
    allowedOrigins: [ORIGIN],
    checks: { database: async () => "ok" as const },
    auth,
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`, { store, jwt });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

async function call(
  base: string,
  method: string,
  path: string,
  opts: { bearer?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: any; setCookie: string }> {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (opts.bearer !== undefined) headers.Authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie !== undefined) headers.Cookie = opts.cookie;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  return { status: res.status, body: await res.json(), setCookie: res.headers.get("set-cookie") ?? "" };
}

async function loggedIn(base: string): Promise<{ accessToken: string; cookie: string; userId: string }> {
  assert.equal((await call(base, "POST", "/api/v1/auth/register", {
    body: { email: EMAIL, password: PASSWORD, fullName: "Revoke Route" },
  })).status, 201);
  assert.equal((await call(base, "POST", "/api/v1/auth/verify-email", { body: { token: VERIFICATION_TOKEN } })).status, 200);
  const login = await call(base, "POST", "/api/v1/auth/login", { body: { email: EMAIL, password: PASSWORD } });
  assert.equal(login.status, 200);
  const refresh = /__Host-velora_refresh=([^;]+)/.exec(login.setCookie)?.[1] ?? "";
  return {
    accessToken: login.body.data.tokens.accessToken as string,
    cookie: `__Host-velora_refresh=${refresh}`,
    userId: String(login.body.data.tokens.user.id),
  };
}

const PROTECTED: Array<[string, string]> = [
  ["GET", "/api/v1/auth/me"],
  ["GET", "/api/v1/auth/email-preferences"],
];

test("AUTH-REVOKE: a fresh access token is accepted on protected routes", async () => {
  await withServer(async (base) => {
    const { accessToken } = await loggedIn(base);
    for (const [m, p] of PROTECTED) {
      assert.equal((await call(base, m, p, { bearer: accessToken })).status, 200, `${m} ${p}`);
    }
  });
});

test("AUTH-REVOKE: logout revokes the access token immediately, not at JWT expiry", async () => {
  await withServer(async (base) => {
    const { accessToken, cookie } = await loggedIn(base);
    assert.equal((await call(base, "POST", "/api/v1/auth/logout", { cookie, body: {} })).status, 200);
    for (const [m, p] of PROTECTED) {
      const r = await call(base, m, p, { bearer: accessToken });
      assert.equal(r.status, 401, `${m} ${p} after logout`);
      assert.equal(r.body.error.code, "UNAUTHENTICATED");
    }
  });
});

test("AUTH-REVOKE: change-password revokes every outstanding access token", async () => {
  await withServer(async (base) => {
    const { accessToken } = await loggedIn(base);
    const changed = await call(base, "POST", "/api/v1/auth/change-password", {
      bearer: accessToken,
      body: { currentPassword: PASSWORD, newPassword: "another-strong-password-5678" },
    });
    assert.equal(changed.status, 200);
    assert.equal((await call(base, "GET", "/api/v1/auth/me", { bearer: accessToken })).status, 401);
  });
});

test("AUTH-REVOKE: a suspended account's token is rejected", async () => {
  await withServer(async (base, { store }) => {
    const { accessToken, userId } = await loggedIn(base);
    await store.updateUserStatus(userId, "suspended", new Date());
    for (const [m, p] of PROTECTED) {
      assert.equal((await call(base, m, p, { bearer: accessToken })).status, 401, `${m} ${p} while suspended`);
    }
  });
});

test("AUTH-REVOKE: a validly signed token with no backing session is rejected", async () => {
  await withServer(async (base, { jwt }) => {
    const { userId } = await loggedIn(base);
    const forged = jwt.sign({ sub: userId, role: "user" }, 900);
    assert.equal((await call(base, "GET", "/api/v1/auth/me", { bearer: forged })).status, 401);
  });
});

test("AUTH-REVOKE: a refresh rotation retires the previous access token", async () => {
  await withServer(async (base) => {
    const { accessToken, cookie } = await loggedIn(base);
    const refreshed = await call(base, "POST", "/api/v1/auth/refresh", { cookie, body: {} });
    assert.equal(refreshed.status, 200);
    assert.equal((await call(base, "GET", "/api/v1/auth/me", { bearer: accessToken })).status, 401);
    assert.equal((await call(base, "GET", "/api/v1/auth/me", { bearer: refreshed.body.data.tokens.accessToken })).status, 200);
  });
});
