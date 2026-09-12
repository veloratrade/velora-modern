// Rate-limit HTTP contract tests — Phase C increment 7 (PHP dispatch-level
// throttle port, C-14 verified limits). Kernel-level evidence over real HTTP
// (in-process fetch) with the DEFAULT per-app fixed-window limiter (the
// always-on posture PHP applies at dispatch). Auth is deliberately NOT
// configured in most tests: the non-throttled responses are the fail-closed
// 503, which makes the limiter-before-capability ordering directly observable
// (503 → 429 transition after the limit is exhausted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen, THROTTLED_AUTH_ROUTES } from "./server.js";
import { RATE_LIMIT_DEFAULTS } from "@velora/contracts";
import type { RateLimiter } from "../ratelimits/rateLimiter.js";

interface Envelope<T = unknown> {
  status: string;
  data: T;
  error: { code: string; message: string; requestId?: string; details?: Record<string, string> } | null;
  timestamp: string;
}

async function withServer(
  fn: (base: string) => Promise<void>,
  opts: { trustedProxyCidrs?: string[]; rateLimiter?: RateLimiter } = {},
): Promise<void> {
  const app = createApp({
    allowedOrigins: ["https://veloratrade.ir"],
    checks: { database: async () => "ok" as const },
    ...(opts.trustedProxyCidrs !== undefined ? { trustedProxyCidrs: opts.trustedProxyCidrs } : {}),
    ...(opts.rateLimiter !== undefined ? { rateLimiter: opts.rateLimiter } : {}),
  });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

async function post(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

test("THROTTLED_AUTH_ROUTES maps exactly the implemented auth routes to the C-14 keys", () => {
  assert.deepEqual(Object.keys(THROTTLED_AUTH_ROUTES), [
    "POST /api/v1/auth/register",
    "POST /api/v1/auth/login",
    "POST /api/v1/auth/refresh",
    "POST /api/v1/auth/verify-email",
    "POST /api/v1/auth/change-password",
  ]);
  for (const routeKey of Object.values(THROTTLED_AUTH_ROUTES)) {
    assert.ok(routeKey in RATE_LIMIT_DEFAULTS);
  }
  // PHP dispatch list: logout, me, preferences, accounts, trades are NOT limited
  assert.equal("POST /api/v1/auth/logout" in THROTTLED_AUTH_ROUTES, false);
  assert.equal("POST /api/v1/accounts" in THROTTLED_AUTH_ROUTES, false);
});

test("register: 5 attempts pass, the 6th is 429 TOO_MANY_REQUESTS with the PHP envelope + Retry-After", async () => {
  await withServer(async (base) => {
    for (let i = 1; i <= 5; i++) {
      const r = await post(base, "/api/v1/auth/register", {});
      assert.equal(r.status, 503, `attempt ${i}: not throttled yet (auth unconfigured → fail-closed 503)`);
    }
    const blocked = await post(base, "/api/v1/auth/register", {
      email: "sixth@velora.example",
      password: "a-strong-password-123",
      fullName: "Sixth",
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.retryAfter, "3600"); // window anchored at the first hit
    const env = blocked.body as Envelope<null>;
    assert.equal(env.status, "error");
    assert.equal(env.data, null);
    assert.equal(env.error?.code, "TOO_MANY_REQUESTS");
    assert.equal(env.error?.message, "Too many requests.");
    assert.equal(env.error?.details?.messageKey, "errors.rateLimited");
    assert.ok(typeof env.error?.requestId === "string" && env.error.requestId.length > 0);
    assert.ok(!Number.isNaN(Date.parse(env.timestamp)));
    // blocked attempts keep counting (PHP: counter grows inside the window)
    const still = await post(base, "/api/v1/auth/register", {});
    assert.equal(still.status, 429);
    assert.equal(still.retryAfter, "3600");
  });
});

test("attempts count BEFORE validation/auth (PHP dispatch-level ordering)", async () => {
  await withServer(async (base) => {
    // 5 malformed-register attempts (validation would 400 them) consume the window
    for (let i = 0; i < 5; i++) {
      const r = await post(base, "/api/v1/auth/register", { email: "not-an-email" });
      assert.equal(r.status, 503); // limiter passed, then auth-unconfigured 503 (validation is inside the route)
    }
    // a VALID register body is now throttled — the 6th attempt never reaches the handler
    const blocked = await post(base, "/api/v1/auth/register", {
      email: "valid@velora.example",
      password: "a-strong-password-123",
      fullName: "Valid",
    });
    assert.equal(blocked.status, 429);
  });
});

test("login: 8 attempts pass, the 9th is 429 with Retry-After 300", async () => {
  await withServer(async (base) => {
    for (let i = 1; i <= 8; i++) {
      const r = await post(base, "/api/v1/auth/login", { email: "a@velora.example", password: "wrong" });
      assert.equal(r.status, 503, `attempt ${i}`);
    }
    const blocked = await post(base, "/api/v1/auth/login", { email: "a@velora.example", password: "wrong" });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.retryAfter, "300");
    assert.equal(((blocked.body) as Envelope<null>).error?.code, "TOO_MANY_REQUESTS");
  });
});

test("verify-email: 20 attempts pass, the 21st is 429", async () => {
  await withServer(async (base) => {
    for (let i = 1; i <= 20; i++) {
      const r = await post(base, "/api/v1/auth/verify-email", { token: "t".repeat(24) });
      assert.equal(r.status, 503, `attempt ${i}`);
    }
    const blocked = await post(base, "/api/v1/auth/verify-email", { token: "t".repeat(24) });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.retryAfter, "900");
  });
});

test("refresh: 30 attempts pass, the 31st is 429 (PHP limits refresh; Remote does not)", async () => {
  await withServer(async (base) => {
    for (let i = 1; i <= 30; i++) {
      const r = await post(base, "/api/v1/auth/refresh", {});
      assert.equal(r.status, 503, `attempt ${i}`); // limiter passed → auth-unconfigured 503
    }
    const blocked = await post(base, "/api/v1/auth/refresh", {});
    assert.equal(blocked.status, 429);
    assert.equal(blocked.retryAfter, "300");
  });
});

test("change-password: limiter precedes the auth check (8 pass, the 9th is 429)", async () => {
  await withServer(async (base) => {
    for (let i = 1; i <= 8; i++) {
      const r = await post(base, "/api/v1/auth/change-password", {});
      assert.equal(r.status, 503, `attempt ${i}`); // unauthenticated + unconfigured → 503
    }
    const blocked = await post(base, "/api/v1/auth/change-password", {});
    assert.equal(blocked.status, 429);
    assert.equal(blocked.retryAfter, "900");
  });
});

test("X-Forwarded-For is NEVER honored without a trusted-proxy config (fail-closed)", async () => {
  await withServer(async (base) => {
    // 5 spoofed-XFF attempts — they land in the peer's (127.0.0.1) bucket
    for (let i = 0; i < 5; i++) {
      const r = await post(base, "/api/v1/auth/register", {}, { "X-Forwarded-For": `203.0.113.${i}` });
      assert.equal(r.status, 503);
    }
    // a different spoofed XFF cannot escape the bucket either
    const blocked = await post(base, "/api/v1/auth/register", {}, { "X-Forwarded-For": "198.51.100.99" });
    assert.equal(blocked.status, 429);
    // …nor can dropping the header
    const also = await post(base, "/api/v1/auth/register", {});
    assert.equal(also.status, 429);
  });
});

test("trusted proxy configured → X-Forwarded-For clients get independent buckets", async () => {
  await withServer(async (base) => {
    const xff = (ip: string) => ({ "X-Forwarded-For": ip });
    for (let i = 0; i < 5; i++) {
      const r = await post(base, "/api/v1/auth/register", {}, xff("203.0.113.9"));
      assert.equal(r.status, 503);
    }
    const blocked = await post(base, "/api/v1/auth/register", {}, xff("203.0.113.9"));
    assert.equal(blocked.status, 429); // that XFF client exhausted ITS bucket
    const otherClient = await post(base, "/api/v1/auth/register", {}, xff("203.0.113.10"));
    assert.equal(otherClient.status, 503); // different XFF client → untouched bucket
  }, { trustedProxyCidrs: ["127.0.0.1/32"] });
});

test("limiter store failure → fail-closed 503 SERVICE_UNAVAILABLE (never a silent pass-through)", async () => {
  const exploding: RateLimiter = {
    async hit(): Promise<never> {
      throw new Error("store down");
    },
  };
  await withServer(async (base) => {
    const r = await post(base, "/api/v1/auth/login", { email: "a@velora.example", password: "x" });
    assert.equal(r.status, 503);
    const env = r.body as Envelope<null>;
    assert.equal(env.error?.code, "SERVICE_UNAVAILABLE");
    assert.notEqual(env.error?.code, "TOO_MANY_REQUESTS");
  }, { rateLimiter: exploding });
});
