// AC-46: effectiveConfig + diagnostics + activity + refresh (in-memory)
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryAdminConsoleStore } from "./adminConsoleStore.js";
import { AdminConsoleService, refreshBuckets } from "./adminConsoleService.js";
import { handleAdminConsoleRoutes } from "./adminConsoleRoutes.js";
import type { AdminUserService } from "../auth/adminUserService.js";
import { AuthError } from "../auth/authService.js";

function fakeUsers(overrides: Record<string, unknown> = {}): AdminUserService {
  return {
    // only getUser is needed for activity existence check
    async getUser(id: string) {
      if (id === "999999") throw new AuthError(404, "USER_NOT_FOUND", "User not found.");
      return { id, email: `${id}@test.com`, fullName: "Test", role: "user", status: "active", emailVerified: true, emailVerifiedAt: null, createdAt: new Date().toISOString() } as never;
    },
    async listSessions() {
      return { items: [], total: 0, page: 1, perPage: 25 } as never;
    },
    async listDevices() {
      return [] as never;
    },
    async revokeSessions() {
      return {} as never;
    },
    async verifyEmail() {
      return {} as never;
    },
    ...overrides,
  } as unknown as AdminUserService;
}

function claims(sub: string, role: string) {
  return { sub, role, email: `${sub}@test.com` };
}

function ctxFor(path: string, method: string, role: string, sub = "1") {
  const url = new URL(`http://localhost${path}`);
  return {
    path,
    method,
    url,
    requestId: "diag-test",
    req: {} as never,
    config: { adminConsole: { console: new AdminConsoleService({ store: new MemoryAdminConsoleStore(), users: fakeUsers() }), users: fakeUsers() } } as never,
    authenticate: () => claims(sub, role) as never,
    isSystemOwner: async () => false,
    readBody: async () => ({}),
  } as never;
}

test("SERVICE: effectiveConfig returns secret-free inventory", async () => {
  const svc = new AdminConsoleService({ store: new MemoryAdminConsoleStore(), users: fakeUsers() });
  const cfg = (await svc.effectiveConfig()) as Record<string, unknown>;
  assert.ok(Array.isArray(cfg["providers"]));
  assert.ok(Array.isArray(cfg["features"]));
  const route = cfg["globalRoute"] as Record<string, unknown>;
  assert.equal(route["effective"], "direct");
  const integ = cfg["integrations"] as Record<string, unknown>;
  assert.ok(integ["metaapi"] !== undefined);
  const prec = cfg["precedence"] as Record<string, string>;
  assert.ok(typeof prec["credential"] === "string");
});

test("SERVICE: diagnostics returns 8 components with honest statuses", async () => {
  const svc = new AdminConsoleService({ store: new MemoryAdminConsoleStore(), users: fakeUsers() });
  const snap = (await svc.diagnostics()) as { checkedAt: string; components: { component: string; status: string }[] };
  assert.ok(snap.checkedAt);
  assert.equal(snap.components.length, 8);
  const keys = snap.components.map((c) => c.component);
  for (const k of ["api", "database", "redis", "workers", "metaapi", "n8n_relay", "ai", "email"]) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
});

test("SERVICE: refreshDiagnostics rate-limits 5 per 120s", async () => {
  refreshBuckets.clear();
  const svc = new AdminConsoleService({ store: new MemoryAdminConsoleStore(), users: fakeUsers() });
  for (let i = 0; i < 5; i++) {
    const r = (await svc.refreshDiagnostics("actor-1")) as { probe: Record<string, unknown>; health: unknown };
    assert.ok(r.probe);
  }
  await assert.rejects(() => svc.refreshDiagnostics("actor-1"), (e: unknown) => {
    assert.ok(e instanceof AuthError);
    assert.equal((e as AuthError).status, 429);
    return true;
  });
  refreshBuckets.clear();
  // different actor is not limited
  const ok = (await svc.refreshDiagnostics("actor-2")) as { probe: Record<string, unknown> };
  assert.ok(ok.probe);
  refreshBuckets.clear();
});

test("SERVICE: userActivity validates existence and pages", async () => {
  const users = fakeUsers();
  const svc = new AdminConsoleService({ store: new MemoryAdminConsoleStore(), users });
  await assert.rejects(() => svc.userActivity("999999", new URLSearchParams()), (e: unknown) => {
    assert.ok(e instanceof AuthError);
    assert.equal((e as AuthError).status, 404);
    return true;
  });
  const page = (await svc.userActivity("1", new URLSearchParams("page=2&perPage=10"))) as Record<string, unknown>;
  assert.equal(page["page"], 2);
  assert.equal(page["perPage"], 10);
});

test("ROUTES: config/effective requires settings.view", async () => {
  const base = ctxFor("/api/v1/admin/config/effective", "GET", "user");
  const res = (await handleAdminConsoleRoutes(base as never)) as { status: number };
  assert.equal(res.status, 403);
  const admin = ctxFor("/api/v1/admin/config/effective", "GET", "admin");
  const ok = (await handleAdminConsoleRoutes(admin as never)) as { status: number; body: { data: unknown } };
  assert.equal(ok.status, 200);
});

test("ROUTES: diagnostics refresh is rate-limited per actor", async () => {
  refreshBuckets.clear();
  const mk = (sub: string) => ({
    path: "/api/v1/admin/system/diagnostics/refresh",
    method: "POST",
    url: new URL("http://localhost/api/v1/admin/system/diagnostics/refresh"),
    requestId: "r",
    req: {} as never,
    config: {
      adminConsole: {
        console: new AdminConsoleService({ store: new MemoryAdminConsoleStore(), users: fakeUsers() }),
        users: fakeUsers(),
      },
    } as never,
    authenticate: () => claims(sub, "admin") as never,
    isSystemOwner: async () => false,
    readBody: async () => ({}),
  });
  for (let i = 0; i < 5; i++) {
    const r = (await handleAdminConsoleRoutes(mk("actor-r") as never)) as { status: number };
    assert.equal(r.status, 200);
  }
  const limited = (await handleAdminConsoleRoutes(mk("actor-r") as never)) as { status: number; body: { error: { code: string } } };
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "TOO_MANY_REQUESTS");
  refreshBuckets.clear();
});

test("ROUTES: activity returns 404 for unknown user", async () => {
  const c = ctxFor("/api/v1/admin/users/999999/activity", "GET", "admin");
  const res = (await handleAdminConsoleRoutes(c as never)) as { status: number };
  assert.equal(res.status, 404);
});

test("ROUTES: anonymous gets 401 on every new route", async () => {
  for (const p of ["/api/v1/admin/config/effective", "/api/v1/admin/system/diagnostics", "/api/v1/admin/users/1/activity"]) {
    const c = {
      path: p,
      method: "GET",
      url: new URL(`http://localhost${p}`),
      requestId: "anon",
      req: {} as never,
      config: { adminConsole: { console: new AdminConsoleService({ store: new MemoryAdminConsoleStore(), users: fakeUsers() }), users: fakeUsers() } } as never,
      authenticate: () => null,
      isSystemOwner: async () => false,
      readBody: async () => ({}),
    };
    const r = (await handleAdminConsoleRoutes(c as never)) as { status: number };
    assert.equal(r.status, 401, p);
  }
  const anonRefresh = {
    path: "/api/v1/admin/system/diagnostics/refresh",
    method: "POST",
    url: new URL("http://localhost/api/v1/admin/system/diagnostics/refresh"),
    requestId: "anon",
    req: {} as never,
    config: { adminConsole: { console: new AdminConsoleService({ store: new MemoryAdminConsoleStore(), users: fakeUsers() }), users: fakeUsers() } } as never,
    authenticate: () => null,
    isSystemOwner: async () => false,
    readBody: async () => ({}),
  };
  const rr = (await handleAdminConsoleRoutes(anonRefresh as never)) as { status: number };
  assert.equal(rr.status, 401);
});
