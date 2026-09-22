// API kernel contract tests — frozen external tier behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "./server.js";
import type { Server } from "node:http";
import { AuthService } from "../auth/authService.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { VeloraHasher } from "../auth/hashing.js";
import { JwtService } from "../auth/jwt.js";

async function withKernelServer(
  checks: { database(): Promise<"ok" | "fail"> },
  fn: (base: string) => Promise<void>,
  origins: readonly string[] = ["https://veloratrade.ir"],
  opts: { withAuth?: boolean } = {},
): Promise<void> {
  const auth =
    opts.withAuth === true
      ? new AuthService({
          store: new MemoryUserStore(),
          hasher: new VeloraHasher(),
          jwt: JwtService.create("server-test-auth-secret-0123456789abcdef"),
          mail: new LogMailProvider(), // explicit offline outbox — never a silent no-op
      })
      : undefined;
  const app = createApp({ allowedOrigins: origins, checks, ...(auth !== undefined ? { auth } : {}) });
  const port = await listen(app);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}
const healthy = { database: async () => "ok" as const };

test("health: PHP reference contract (OD-3) — 200, data {status:'ok', time}, 4-field envelope", async () => {
  await withKernelServer(healthy, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      data: { status: string; time: string };
      error: null;
      timestamp: string;
    };
    assert.equal(body.status, "success");
    assert.equal(body.data.status, "ok");
    assert.match(body.data.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/); // gmdate('c')
    assert.equal(body.error, null); // 4-field envelope (C-10)
    assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/);
  });
});

test("health: liveness stays 200 while readiness fails when the DB probe fails (S8 split)", async () => {
  await withKernelServer({ database: async () => "fail" as const }, async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { data: { status: string } }).data.status, "ok");
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503);
  });
});

test("locale routing: X-VELORA-Locale + per-class Cache-Control (C-02, ADR-009)", async () => {
  await withKernelServer(healthy, async (base) => {
    const fa = await fetch(`${base}/fa/checkout`);
    assert.equal(fa.status, 200);
    assert.equal(fa.headers.get("X-VELORA-Locale"), "fa");
    const en = await fetch(`${base}/en/checkout`);
    assert.equal(en.headers.get("X-VELORA-Locale"), "en");
    const home = await fetch(`${base}/`);
    assert.equal(home.headers.get("X-VELORA-Locale"), "fa");
    const enHome = await fetch(`${base}/en/`);
    assert.equal(enHome.headers.get("X-VELORA-Locale"), "en");
    assert.match(enHome.headers.get("Cache-Control")!, /public/); // class C
    const market = await fetch(`${base}/markets`);
    assert.match(market.headers.get("Cache-Control")!, /s-maxage=120/); // class A ≠ class C
    const blog = await fetch(`${base}/blog/forex-trading-journal/`);
    assert.match(blog.headers.get("Cache-Control")!, /s-maxage=3600/); // class B
  });
});

test("origin guard: forged Origin on POST logout → 403 (verified PHP parity)", async () => {
  await withKernelServer(
    healthy,
    async (base) => {
    const evil = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(evil.status, 403);
    assert.equal(((await evil.json()) as { error: { code: string } }).error.code, "ORIGIN_REJECTED");
    const good = await fetch(`${base}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Origin: "https://veloratrade.ir" },
    });
      assert.equal(good.status, 200);
      assert.deepEqual(((await good.json()) as { data: unknown }).data, { loggedOut: true });
    },
    ["https://veloratrade.ir"],
    { withAuth: true },
  );
});

test("CSP: nonce present, unique per request, and no unsafe-inline", async () => {
  await withKernelServer(healthy, async (base) => {
    const a = await fetch(`${base}/`);
    const b = await fetch(`${base}/`);
    const cspA = a.headers.get("Content-Security-Policy")!;
    const cspB = b.headers.get("Content-Security-Policy")!;
    assert.match(cspA, /'nonce-[A-Za-z0-9+/=]{24}'/); // 16 bytes → 24 base64 chars
    assert.notEqual(cspA, cspB); // nonces differ per request
    assert.ok(!cspA.includes("unsafe-inline"));
    assert.match(a.headers.get("X-Request-Id")!, /^[0-9a-f-]{36}$/); // request correlation
    assert.equal(a.headers.get("X-Content-Type-Options"), "nosniff");
  });
});

test("unknown route → 404 error envelope with request id", async () => {
  await withKernelServer(healthy, async (base) => {
    const res = await fetch(`${base}/definitely/not/a/route`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { status: string; error: { code: string; requestId?: string } };
    assert.equal(body.status, "error");
    assert.equal(body.error.code, "NOT_FOUND");
    assert.ok(body.error.requestId);
  });
});

test("CSP (S7): exact directive policy — strict, no weakening", async () => {
  await withKernelServer(healthy, async (base) => {
    const res = await fetch(`${base}/health`);
    const csp = res.headers.get("Content-Security-Policy")!;
    const directives = csp.split(";").map((d) => d.trim());
    assert.ok(directives.includes("default-src 'self'"));
    assert.ok(directives.includes("style-src 'self'"));
    assert.ok(directives.includes("img-src 'self' data: https:"));
    assert.ok(directives.includes("object-src 'none'"));
    assert.ok(directives.includes("base-uri 'self'"));
    assert.ok(directives.includes("form-action 'self'"));
    assert.ok(directives.includes("frame-ancestors 'none'"));
    assert.ok(directives.includes("upgrade-insecure-requests"));
    // script-src is EXACTLY 'self' + the nonce — no hosts, no wildcards
    const nonce = csp.match(/'nonce-([A-Za-z0-9+/=]{24})'/)?.[1];
    assert.ok(nonce, "24-char base64 nonce (16 bytes) must be present");
    assert.ok(directives.includes(`script-src 'self' 'nonce-${nonce}'`));
    // No weakening anywhere in the policy
    assert.ok(!csp.includes("unsafe-inline"));
    assert.ok(!csp.includes("unsafe-eval"));
    assert.ok(!/script-src[^;]*\*/.test(csp), "no wildcard script sources");
    // Security headers present on every response
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
    assert.ok((res.headers.get("X-Request-Id") ?? "").length > 0);
  });
});

test("ready (S8): readiness fails honestly when the durable probe fails", async () => {
  await withKernelServer({ database: async () => "fail" as const }, async (base) => {
    const res = await fetch(`${base}/ready`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { data: { status: string; checks: { database: string } } };
    assert.equal(body.data.status, "not_ready");
    assert.equal(body.data.checks.database, "fail");
    // (liveness is /health — always 200 per the OD-3 PHP contract; covered above)
  });
});
