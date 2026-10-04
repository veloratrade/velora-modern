// Rate-limit HTTP contract tests — Phase C increment 7 (PHP dispatch-level
// throttle port, C-14 verified limits). Kernel-level evidence over real HTTP
// (in-process fetch) with the DEFAULT per-app fixed-window limiter (the
// always-on posture PHP applies at dispatch). Auth is deliberately NOT
// configured in most tests: the non-throttled responses are the fail-closed
// 503, which makes the limiter-before-capability ordering directly observable
// (503 → 429 transition after the limit is exhausted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen, throttleKeyFor, THROTTLED_ROUTES, THROTTLED_PATTERN_ROUTES } from "./server.js";
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

async function patch(
  base: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

test("THROTTLED_ROUTES maps exactly the implemented routes to the C-14 keys", () => {
  assert.deepEqual(Object.keys(THROTTLED_ROUTES), [
    "POST /api/v1/auth/register",
    "POST /api/v1/auth/login",
    "POST /api/v1/auth/refresh",
    "POST /api/v1/auth/verify-email",
    "POST /api/v1/auth/change-password",
    // Phase 3B-1 — now implemented, so they join the exact-match guard.
    // resend-verification is 4/3600 per the owner-approved OD-14 contract.
    "POST /api/v1/auth/resend-verification",
    "POST /api/v1/auth/forgot-password",
    "POST /api/v1/auth/reset-password",
    // SEC-02 — the provider/ingress routes (values pinned by the tests below).
    "POST /api/v1/accounts/detect-server",
    "POST /api/v1/webhooks/metaapi",
  ]);
  for (const routeKey of Object.values(THROTTLED_ROUTES)) {
    assert.ok(routeKey in RATE_LIMIT_DEFAULTS);
  }
  // PHP dispatch list: logout, me, preferences, accounts, trades are NOT limited
  assert.equal("POST /api/v1/auth/logout" in THROTTLED_ROUTES, false);
  assert.equal("POST /api/v1/accounts" in THROTTLED_ROUTES, false);
  // SEC-02: the two provider/ingress routes now sit in the exact map. The
  // dynamic connect path lives in the pattern list below (it carries an id).
  assert.equal(THROTTLED_ROUTES["POST /api/v1/accounts/detect-server"], "accounts:detect-server");
  assert.equal(THROTTLED_ROUTES["POST /api/v1/webhooks/metaapi"], "webhooks:metaapi");

  // OD-14: exactly ONE canonical resend endpoint — the Legacy
  // `/auth/resend-verification-email` alias is deliberately not reproduced.
  assert.equal("POST /api/v1/auth/resend-verification-email" in THROTTLED_ROUTES, false);
  // OD-14 approved limit: 4 per hour.
  assert.deepEqual(RATE_LIMIT_DEFAULTS[THROTTLED_ROUTES["POST /api/v1/auth/resend-verification"]!], {
    limit: 4,
    windowSec: 3600,
  });
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


// --------------------------------------------------------------------------
// SEC-02 — provider-touching and ingress routes.
//
// These three carry Legacy's dispatch-level limits (metaapi-connect 5/900,
// metaapi-detect 20/900, metaapi-webhook 120/60). They are the routes whose work
// leaves the process: a broker login verified against MetaAPI, and an ingress a
// third party drives. The bucket keys keep Legacy's operation names so the
// lineage is searchable, and the VALUES are pinned here rather than described.
// --------------------------------------------------------------------------

test("SEC-02: the provider/ingress buckets carry Legacy's exact numbers", () => {
  assert.deepEqual(RATE_LIMIT_DEFAULTS["accounts:metaapi-connect"], { limit: 5, windowSec: 900 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["accounts:detect-server"], { limit: 20, windowSec: 900 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["webhooks:metaapi"], { limit: 120, windowSec: 60 });
});

test("SEC-02: throttle lookup covers the dynamic provisioning path, and only the write", () => {
  // Every dynamic rule is method-scoped, and the table is exactly the three
  // resource-id routes SEC-02 throttles: the provisioning call plus Legacy's two
  // admin user mutations. A new rule cannot appear unnoticed.
  assert.deepEqual(
    THROTTLED_PATTERN_ROUTES.map((r) => `${r.method} ${r.key}`),
    ["POST accounts:metaapi-connect", "PATCH admin:user-action", "PATCH admin:user-action"],
  );
  assert.equal(throttleKeyFor("POST", "/api/v1/accounts/acc-123/metaapi/connect"), "accounts:metaapi-connect");
  assert.equal(throttleKeyFor("POST", "/api/v1/accounts/42/metaapi/connect"), "accounts:metaapi-connect");
  // A read of the same resource must never be throttled by this rule.
  assert.equal(throttleKeyFor("GET", "/api/v1/accounts/acc-123/metaapi/connect"), undefined);
  // Near-misses: a different suffix, a missing segment, an extra segment.
  assert.equal(throttleKeyFor("POST", "/api/v1/accounts/acc-123/metaapi/disconnect"), undefined);
  assert.equal(throttleKeyFor("POST", "/api/v1/accounts/metaapi/connect"), undefined);
  assert.equal(throttleKeyFor("POST", "/api/v1/accounts/acc-123/metaapi/connect/extra"), undefined);
  // Exact matches still win and unrelated routes stay unthrottled.
  assert.equal(throttleKeyFor("POST", "/api/v1/accounts/detect-server"), "accounts:detect-server");
  assert.equal(throttleKeyFor("POST", "/api/v1/webhooks/metaapi"), "webhooks:metaapi");
  assert.equal(throttleKeyFor("POST", "/api/v1/accounts"), undefined);
  assert.equal(throttleKeyFor("GET", "/api/v1/webhooks/metaapi"), undefined);
});

test("SEC-02: the provisioning path is throttled BEFORE auth, so a brute force cannot outrun it", async () => {
  // The limiter runs at dispatch, before the route's own (absent) capability
  // checks — the same ordering PHP used. With auth unconfigured the first five
  // requests reach the fail-closed 503 and the sixth is refused by the limiter.
  await withServer(async (base) => {
    for (let i = 0; i < 5; i++) {
      const r = await post(base, "/api/v1/accounts/acc-1/metaapi/connect", {});
      assert.equal(r.status, 503, `attempt ${i + 1} should reach the unconfigured-capability 503`);
    }
    const blocked = await post(base, "/api/v1/accounts/acc-1/metaapi/connect", {});
    assert.equal(blocked.status, 429);
    assert.equal((blocked.body as Envelope).error?.code, "TOO_MANY_REQUESTS");
    assert.ok(blocked.retryAfter !== null, "429 must advertise Retry-After");
  });
});

test("SEC-02: detect-server and the webhook ingress are throttled at their Legacy limits", async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 20; i++) {
      const r = await post(base, "/api/v1/accounts/detect-server", {});
      assert.equal(r.status, 503);
    }
    assert.equal((await post(base, "/api/v1/accounts/detect-server", {})).status, 429);
  });
  await withServer(async (base) => {
    for (let i = 0; i < 120; i++) {
      const r = await post(base, "/api/v1/webhooks/metaapi", {});
      assert.equal(r.status, 503);
    }
    assert.equal((await post(base, "/api/v1/webhooks/metaapi", {})).status, 429);
  });
});

test("SEC-02: the admin user mutations carry Legacy's admin-user-action limit", () => {
  // Legacy: RateLimiter::hit('admin-user-action', 30, 300) inside
  // UserManagementController::setStatus and ::setRole — the same two operations
  // Modern exposes as PATCH .../role and .../status.
  assert.equal(throttleKeyFor("PATCH", "/api/v1/admin/users/abc-123/role"), "admin:user-action");
  assert.equal(throttleKeyFor("PATCH", "/api/v1/admin/users/abc-123/status"), "admin:user-action");
  assert.equal(RATE_LIMIT_DEFAULTS["admin:user-action"].limit, 30);
  assert.equal(RATE_LIMIT_DEFAULTS["admin:user-action"].windowSec, 300);

  // Reads of the same resource are NOT throttled by that bucket: Legacy only
  // limited the mutations, and a limit that silently covers reads would be a
  // behaviour Modern never had.
  assert.equal(throttleKeyFor("GET", "/api/v1/admin/users/abc-123"), undefined);
  assert.equal(throttleKeyFor("GET", "/api/v1/admin/users/abc-123/login-history"), undefined);
  assert.equal(throttleKeyFor("GET", "/api/v1/admin/users"), undefined);

  // Near misses stay unthrottled rather than matching by accident.
  assert.equal(throttleKeyFor("PATCH", "/api/v1/admin/users/abc-123/role/extra"), undefined);
  assert.equal(throttleKeyFor("PATCH", "/api/v1/admin/users//role"), undefined);
  assert.equal(throttleKeyFor("POST", "/api/v1/admin/users/abc-123/role"), undefined);
});

test("SEC-02: the admin user mutations are throttled in behaviour, before auth", async () => {
  // Legacy put the limiter INSIDE the two handlers, i.e. after authorization.
  // Modern puts it at dispatch (the same place every other limit lives), which
  // is strictly earlier — the ordering is the safe direction: an unauthenticated
  // flood is refused without the server doing any auth work, and an authorized
  // actor still gets exactly Legacy's 30 mutations per 5 minutes.
  await withServer(async (base) => {
    for (let i = 0; i < 30; i++) {
      const r = await patch(base, "/api/v1/admin/users/u-1/status", { status: "active" });
      // 503 = the fail-closed "auth is not configured" answer, i.e. the request
      // reached the route and NOT the limiter, which is the ordering under test.
      assert.equal(r.status, 503, `attempt ${i + 1} is refused by the unconfigured server, not by the limiter`);
    }
    const blocked = await patch(base, "/api/v1/admin/users/u-1/status", { status: "active" });
    assert.equal(blocked.status, 429);
    assert.equal((blocked.body as Envelope).error?.code, "TOO_MANY_REQUESTS");
    assert.equal(blocked.retryAfter, "300");
  });
});

test("SEC-02: the two mutations share ONE bucket, so they cannot be alternated for double the quota", async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 15; i++) {
      assert.equal((await patch(base, "/api/v1/admin/users/u-1/status", {})).status, 503);
    }
    for (let i = 0; i < 15; i++) {
      assert.equal((await patch(base, "/api/v1/admin/users/u-1/role", {})).status, 503);
    }
    assert.equal((await patch(base, "/api/v1/admin/users/u-1/role", {})).status, 429);
    // The bucket is keyed by the caller + key, NOT by the target: changing the
    // target id must not hand out a fresh quota.
    assert.equal((await patch(base, "/api/v1/admin/users/u-2/status", {})).status, 429);
  });
});
