// SEC-04 — HTTP contract of the edge session probe (`GET /api/v1/auth/session`).
//
// This route exists for exactly one caller (the web proxy's protected-route
// gate) and it is security-bearing: the answer decides whether authenticated
// HTML is served at all. So the battery asserts the things the gate relies on:
// a narrow body, `no-store`, a fail-closed answer when auth is not configured,
// and — most importantly — that asking the question never changes the answer
// (no rotation, so the caller's session survives being probed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "./server.js";
import { AuthService } from "../auth/authService.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";
import { LogMailProvider } from "../mail/logMailProvider.js";

const SECRET = "auth-session-probe-test-secret-0123456789abcdef";
const REFRESH_COOKIE = "__Host-velora_refresh";

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string } | null;
  timestamp: string;
}

async function withServer(
  fn: (base: string, store: MemoryUserStore) => Promise<void>,
  opts: { configureAuth?: boolean } = {},
): Promise<void> {
  const configureAuth = opts.configureAuth ?? true;
  const store = new MemoryUserStore();
  const auth = configureAuth
    ? new AuthService({
        store,
        hasher: new VeloraHasher(),
        jwt: JwtService.create(SECRET),
        generateVerificationToken: () => "probe-battery-verification-token-0123456789abcdef",
        mail: new LogMailProvider(),
      })
    : undefined;
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    ...(auth !== undefined ? { auth } : {}),
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

async function probe(
  base: string,
  cookie?: string,
): Promise<{ status: number; body: Envelope; cacheControl: string | null }> {
  const res = await fetch(`${base}/api/v1/auth/session`, {
    method: "GET",
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
  return {
    status: res.status,
    body: (await res.json()) as Envelope,
    cacheControl: res.headers.get("cache-control"),
  };
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Envelope; setCookie: string }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://veloratrade.ir", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Envelope,
    setCookie: res.headers.get("set-cookie") ?? "",
  };
}

/** The deterministic verification token this battery's service mints. */
const VERIFICATION_TOKEN = "probe-battery-verification-token-0123456789abcdef";

test("SEC-04 probe: no cookie → 200 {authenticated:false, role:null} and no-store", async () => {
  await withServer(async (base) => {
    const r = await probe(base);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, { authenticated: false, role: null });
    assert.equal(r.cacheControl, "no-store", "the answer depends on the caller's credential");
    assert.equal(r.body.error, null);
  });
});

test("SEC-04 probe: an unknown/garbage token is unauthenticated, never an error", async () => {
  await withServer(async (base) => {
    for (const token of ["", "bogus", "a".repeat(64)]) {
      const r = await probe(base, `${REFRESH_COOKIE}=${token}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data, { authenticated: false, role: null });
    }
  });
});

test("SEC-04 probe: a live session reports its own role, and probing does NOT rotate it", async () => {
  await withServer(async (base) => {
    const registered = await post(base, "/api/v1/auth/register", {
      email: "probe.route@velora.example",
      password: "a-strong-password-1234",
      fullName: "Probe Route",
    });
    assert.equal(registered.status, 201);
    // The real verification route, with the token the service really minted.
    const verified = await post(base, "/api/v1/auth/verify-email", { token: VERIFICATION_TOKEN });
    assert.equal(verified.status, 200, "the verification route must accept the minted token");
    const login = await post(base, "/api/v1/auth/login", {
      email: "probe.route@velora.example",
      password: "a-strong-password-1234",
    });
    assert.equal(login.status, 200, "a verified user logs in");
    const token = /__Host-velora_refresh=([^;]+)/.exec(login.setCookie)?.[1] ?? "";
    assert.notEqual(token, "", "login must set the SEC-04 cookie");

    const r = await probe(base, `${REFRESH_COOKIE}=${token}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, { authenticated: true, role: "user" });
    assert.equal(r.cacheControl, "no-store");

    // READ-ONLY proof at the HTTP layer: the very same cookie still refreshes
    // (a probe that consumed or rotated the session would 401 here).
    const refreshed = await post(base, "/api/v1/auth/refresh", {}, { Cookie: `${REFRESH_COOKIE}=${token}` });
    assert.equal(refreshed.status, 200, "probing must not have spent the session");
  });
});

test("SEC-04 probe: an ADMIN session reports the panel role the /admin gate needs", async () => {
  await withServer(async (base, store) => {
    await post(base, "/api/v1/auth/register", {
      email: "probe.admin@velora.example",
      password: "a-strong-password-1234",
      fullName: "Probe Admin",
    });
    await post(base, "/api/v1/auth/verify-email", { token: VERIFICATION_TOKEN });
    const login = await post(base, "/api/v1/auth/login", {
      email: "probe.admin@velora.example",
      password: "a-strong-password-1234",
    });
    const token = /__Host-velora_refresh=([^;]+)/.exec(login.setCookie)?.[1] ?? "";
    assert.deepEqual((await probe(base, `${REFRESH_COOKIE}=${token}`)).body.data, {
      authenticated: true,
      role: "user",
    });

    // Promote through the real store contract (the admin routes' own path).
    const user = await store.findUserByEmail("probe.admin@velora.example");
    await store.updateUserRole(user!.id, "admin", new Date());

    // The SAME session now answers with the panel role: the gate reads authority
    // from storage on every check, not from a claim frozen into the token.
    assert.deepEqual((await probe(base, `${REFRESH_COOKIE}=${token}`)).body.data, {
      authenticated: true,
      role: "admin",
    });

    // …and a demotion takes effect immediately, with no token refresh involved.
    await store.updateUserRole(user!.id, "user", new Date());
    assert.deepEqual((await probe(base, `${REFRESH_COOKIE}=${token}`)).body.data, {
      authenticated: true,
      role: "user",
    });
  });
});

test("SEC-04 probe: the body is narrow — no id, email, plan or token ever appears", async () => {
  await withServer(async (base) => {
    const r = await probe(base, `${REFRESH_COOKIE}=whatever`);
    assert.deepEqual(Object.keys(r.body.data as object).sort(), ["authenticated", "role"]);
    const serialized = JSON.stringify(r.body);
    for (const forbidden of ["@velora.example", "accessToken", "refreshToken", "password", "email"]) {
      assert.equal(serialized.includes(forbidden), false, `the probe body must not carry ${forbidden}`);
    }
  });
});

test("SEC-04 probe: auth not configured → fail closed with 503 (never `authenticated:false`)", async () => {
  await withServer(
    async (base) => {
      const r = await probe(base);
      assert.equal(r.status, 503);
      assert.equal(r.body.error?.code, "SERVICE_UNAVAILABLE");
      // The distinction matters: an unconfigured server must not be mistaken for
      // a signed-out visitor by the web gate, which treats 503 as gate-unavailable
      // and still refuses to serve protected HTML.
      assert.notEqual(r.status, 200);
    },
    { configureAuth: false },
  );
});
