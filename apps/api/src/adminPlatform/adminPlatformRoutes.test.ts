import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryAdminPlatformStore } from "./memoryAdminPlatformStore.js";
import { AdminPlatformService } from "./adminPlatformService.js";
import { handleAdminPlatformRoutes } from "./adminPlatformRoutes.js";
import type { ExtendedRouteContext } from "../routes/types.js";

function makePlatform() {
  const store = new MemoryAdminPlatformStore({ users: [{ id: "1", email: "a@example.com", plan: "free" }] });
  const svc = new AdminPlatformService({ store });
  return { store, svc };
}

function ctxFor(overrides: { path: string; method: string; role?: string; sub?: string; body?: Record<string, unknown>; query?: string; svc?: AdminPlatformService; store?: MemoryAdminPlatformStore }): ExtendedRouteContext {
  const role = overrides.role ?? "super_admin";
  const sub = overrides.sub ?? "1";
  const body = overrides.body ?? {};
  const { svc, store } = overrides.svc ? { svc: overrides.svc, store: overrides.store! } : makePlatform();
  const url = new URL("http://localhost" + overrides.path + (overrides.query ? `?${overrides.query}` : ""));
  return {
    path: overrides.path,
    method: overrides.method,
    url,
    req: { headers: {} } as unknown as ExtendedRouteContext["req"],
    requestId: "test-req",
    config: { adminPlatform: { platform: svc, store } } as unknown as ExtendedRouteContext["config"],
    authenticate: () => ({ sub, role: role as "user" | "admin" | "super_admin", email: "a@example.com" }),
    isSystemOwner: async () => false,
    readBody: async () => body,
  } as unknown as ExtendedRouteContext;
}

function unauthCtx(path: string, method: string): ExtendedRouteContext {
  const { svc, store } = makePlatform();
  return {
    path, method, url: new URL("http://localhost" + path),
    req: { headers: {} } as unknown as ExtendedRouteContext["req"],
    requestId: "test-req",
    config: { adminPlatform: { platform: svc, store } } as unknown as ExtendedRouteContext["config"],
    authenticate: () => null,
    isSystemOwner: async () => false,
    readBody: async () => ({}),
  } as unknown as ExtendedRouteContext;
}

// 8 routes

test("adminPlatform: unauthenticated → 401", async () => {
  const paths = [
    ["/api/v1/admin/settings", "GET"],
    ["/api/v1/admin/settings/platform.default_locale", "PUT"],
    ["/api/v1/admin/settings/platform.default_locale", "DELETE"],
    ["/api/v1/admin/feature-flags", "GET"],
    ["/api/v1/admin/feature-flags/ai_assistant", "PATCH"],
    ["/api/v1/admin/logs/system", "GET"],
    ["/api/v1/admin/billing", "GET"],
    ["/api/v1/admin/billing/users/1", "GET"],
  ] as const;
  for (const [path, method] of paths) {
    const res = await handleAdminPlatformRoutes(unauthCtx(path, method));
    assert.equal(res?.status, 401, `${method} ${path}`);
  }
});

test("adminPlatform: admin can read settings/flags/logs/billing, but not write settings/flags", async () => {
  const reads: Array<[string, string]> = [
    ["/api/v1/admin/settings", "GET"],
    ["/api/v1/admin/feature-flags", "GET"],
    ["/api/v1/admin/logs/system", "GET"],
    ["/api/v1/admin/billing", "GET"],
    ["/api/v1/admin/billing/users/1", "GET"],
  ];
  for (const [path, method] of reads) {
    const res = await handleAdminPlatformRoutes(ctxFor({ path, method, role: "admin" }));
    assert.equal(res?.status, 200, `admin ${method} ${path}`);
  }
  const writes: Array<[string, string]> = [
    ["/api/v1/admin/settings/platform.default_locale", "PUT"],
    ["/api/v1/admin/settings/platform.default_locale", "DELETE"],
    ["/api/v1/admin/feature-flags/ai_assistant", "PATCH"],
  ];
  for (const [path, method] of writes) {
    const res = await handleAdminPlatformRoutes(ctxFor({ path, method, role: "admin", body: { value: "en", enabled: true, rollout: 100 } }));
    assert.equal(res?.status, 403, `admin write ${method} ${path} should be 403`);
  }
});

test("adminPlatform: super_admin can read and write", async () => {
  const { svc, store } = makePlatform();
  let res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/settings", method: "GET", role: "super_admin", svc, store }));
  assert.equal(res?.status, 200);
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/settings/platform.default_locale", method: "PUT", role: "super_admin", svc, store, body: { value: "en" } }));
  assert.equal(res?.status, 200);
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/feature-flags", method: "GET", role: "super_admin", svc, store }));
  assert.equal(res?.status, 200);
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/feature-flags/ai_assistant", method: "PATCH", role: "super_admin", svc, store, body: { enabled: true, rollout: 100 } }));
  assert.equal(res?.status, 200);
});

test("adminPlatform: settings PUT validates", async () => {
  const { svc, store } = makePlatform();
  // empty → 422
  let res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/settings/platform.default_locale", method: "PUT", role: "super_admin", svc, store, body: {} }));
  assert.equal(res?.status, 422);
  // invalid choice
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/settings/platform.default_locale", method: "PUT", role: "super_admin", svc, store, body: { value: "de" } }));
  assert.equal(res?.status, 422);
  // unknown key → 422
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/settings/unknown.key", method: "PUT", role: "super_admin", svc, store, body: { value: "x" } }));
  assert.equal(res?.status, 422);
  // valid
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/settings/platform.default_locale", method: "PUT", role: "super_admin", svc, store, body: { value: "fa" } }));
  assert.equal(res?.status, 200);
});

test("adminPlatform: settings GET inventory shape", async () => {
  const { svc, store } = makePlatform();
  const res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/settings", method: "GET", role: "super_admin", svc, store }));
  assert.equal(res?.status, 200);
  const body = res?.body as { data?: { settings?: unknown[] } };
  assert.ok(Array.isArray(body.data?.settings));
  const item = (body.data?.settings as Array<{ key: string; writable: boolean }>).find((r) => r.key === "platform.default_locale");
  assert.ok(item);
  assert.equal(item.writable, true);
});

test("adminPlatform: feature-flags GET returns 4, PATCH validates", async () => {
  const { svc, store } = makePlatform();
  let res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/feature-flags", method: "GET", role: "super_admin", svc, store }));
  assert.equal(res?.status, 200);
  const body = res?.body as { data?: { flags?: unknown[] } };
  assert.equal((body.data?.flags as unknown[]).length, 4);

  // missing enabled → 422
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/feature-flags/ai_assistant", method: "PATCH", role: "super_admin", svc, store, body: { rollout: 50 } }));
  assert.equal(res?.status, 422);
  // bad rollout
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/feature-flags/ai_assistant", method: "PATCH", role: "super_admin", svc, store, body: { enabled: true, rollout: 200 } }));
  assert.equal(res?.status, 422);
  // unknown feature
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/feature-flags/unknown", method: "PATCH", role: "super_admin", svc, store, body: { enabled: true, rollout: 100 } }));
  assert.equal(res?.status, 422);
  // valid
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/feature-flags/ai_assistant", method: "PATCH", role: "super_admin", svc, store, body: { enabled: true, rollout: 50 } }));
  assert.equal(res?.status, 200);
});

test("adminPlatform: system logs GET supports filters and pagination", async () => {
  const { svc, store } = makePlatform();
  await store.createSystemLog({ severity: "ERROR", source: "worker", message: "boom" });
  let res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/logs/system", method: "GET", role: "admin", svc, store, query: "severity=ERROR" }));
  assert.equal(res?.status, 200);
  const body = res?.body as { data?: { total?: number } };
  assert.equal(body.data?.total, 1);

  // invalid per_page
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/logs/system", method: "GET", role: "admin", svc, store, query: "per_page=200" }));
  assert.equal(res?.status, 422);
});

test("adminPlatform: billing GET overview and user", async () => {
  const { svc, store } = makePlatform();
  let res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/billing", method: "GET", role: "admin", svc, store }));
  assert.equal(res?.status, 200);
  const body = res?.body as { data?: { provider?: { available: boolean } } };
  assert.equal(body.data?.provider?.available, false);

  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/billing/users/1", method: "GET", role: "admin", svc, store }));
  assert.equal(res?.status, 200);

  // invalid id
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/billing/users/abc", method: "GET", role: "admin", svc, store }));
  assert.equal(res?.status, 422);
  // not found
  res = await handleAdminPlatformRoutes(ctxFor({ path: "/api/v1/admin/billing/users/999", method: "GET", role: "admin", svc, store }));
  assert.equal(res?.status, 404);
});

test("adminPlatform: capability absent → 503", async () => {
  const ctx: ExtendedRouteContext = {
    path: "/api/v1/admin/settings",
    method: "GET",
    url: new URL("http://localhost/api/v1/admin/settings"),
    req: { headers: {} } as unknown as ExtendedRouteContext["req"],
    requestId: "test",
    config: {} as unknown as ExtendedRouteContext["config"],
    authenticate: () => ({ sub: "1", role: "super_admin", email: "a@b" }),
    isSystemOwner: async () => false,
    readBody: async () => ({}),
  } as unknown as ExtendedRouteContext;
  const res = await handleAdminPlatformRoutes(ctx);
  assert.equal(res?.status, 503);
});
