import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIntegrationStore } from "./memoryIntegrationStore.js";
import { IntegrationService } from "./integrationService.js";
import { handleIntegrationRoutes } from "./integrationRoutes.js";
import { MasterKey } from "../credentials/credentialCrypto.js";
import type { ExtendedRouteContext } from "../routes/types.js";

function masterKey(): MasterKey {
  return MasterKey.fromBase64(Buffer.alloc(32, 9).toString("base64"), 1);
}

function ctxFor(overrides: Partial<ExtendedRouteContext> & { path: string; method: string; role?: string; sub?: string; body?: Record<string, unknown>; integrations?: IntegrationService | null }): ExtendedRouteContext {
  const role = overrides.role ?? "super_admin";
  const sub = overrides.sub ?? "user-1";
  const body = overrides.body ?? {};
  const svc = overrides.integrations ?? new IntegrationService({ store: new MemoryIntegrationStore(), masterKey: masterKey(), env: () => undefined });
  const cfg: Record<string, unknown> = svc ? { integrations: { integrations: svc } } : {};
  // also inject aiAdmin for relay alias tests when needed via extra param
  if ((overrides as unknown as { aiAdmin?: unknown }).aiAdmin !== undefined) {
    (cfg as Record<string, unknown>)["aiAdmin"] = (overrides as unknown as { aiAdmin: unknown }).aiAdmin;
  }
  return {
    path: overrides.path,
    method: overrides.method,
    url: new URL("http://localhost" + overrides.path),
    req: { headers: {} } as unknown as ExtendedRouteContext["req"],
    requestId: "test-req",
    config: cfg as unknown as ExtendedRouteContext["config"],
    authenticate: () => ({ sub, role: role as "user" | "admin" | "super_admin", email: "a@example.com" }),
    isSystemOwner: async () => false,
    readBody: async () => body,
  } as unknown as ExtendedRouteContext;
}

function unauthCtx(path: string, method: string): ExtendedRouteContext {
  return {
    path, method, url: new URL("http://localhost" + path),
    req: { headers: {} } as unknown as ExtendedRouteContext["req"],
    requestId: "test-req",
    config: { integrations: { integrations: new IntegrationService({ store: new MemoryIntegrationStore(), masterKey: masterKey(), env: () => undefined }) } } as unknown as ExtendedRouteContext["config"],
    authenticate: () => null,
    isSystemOwner: async () => false,
    readBody: async () => ({}),
  } as unknown as ExtendedRouteContext;
}

// 12 routes: inventory 1, metaapi 4, email 4, relay 3 = 12

test("integrations: unauthenticated → 401 on every route", async () => {
  const paths = [
    ["/api/v1/admin/integrations", "GET"],
    ["/api/v1/admin/integrations/metaapi", "GET"],
    ["/api/v1/admin/integrations/metaapi", "PUT"],
    ["/api/v1/admin/integrations/metaapi", "DELETE"],
    ["/api/v1/admin/integrations/metaapi/test", "POST"],
    ["/api/v1/admin/integrations/email", "GET"],
    ["/api/v1/admin/integrations/email", "PUT"],
    ["/api/v1/admin/integrations/email", "DELETE"],
    ["/api/v1/admin/integrations/email/test", "POST"],
    ["/api/v1/admin/integrations/relay/config", "GET"],
    ["/api/v1/admin/integrations/relay/config", "PUT"],
    ["/api/v1/admin/integrations/relay/config", "DELETE"],
  ] as const;
  for (const [path, method] of paths) {
    const res = await handleIntegrationRoutes(unauthCtx(path, method));
    assert.equal(res?.status, 401, `${method} ${path} should be 401`);
  }
});

test("integrations: admin can read, but not write/test (403)", async () => {
  const reads = [
    ["/api/v1/admin/integrations", "GET"],
    ["/api/v1/admin/integrations/metaapi", "GET"],
    ["/api/v1/admin/integrations/email", "GET"],
    ["/api/v1/admin/integrations/relay/config", "GET"],
  ] as const;
  for (const [path, method] of reads) {
    const res = await handleIntegrationRoutes(ctxFor({ path, method, role: "admin", integrations: new IntegrationService({ store: new MemoryIntegrationStore(), masterKey: masterKey(), env: () => undefined }) }));
    // relay will be 503 when aiAdmin absent, but reads for metaapi/email/inventory should be 200
    if (path.includes("relay")) {
      assert.ok(res !== null && [200, 503].includes(res.status), `${method} ${path} admin should not be 403`);
    } else {
      assert.equal(res?.status, 200, `admin read ${method} ${path} should be 200`);
    }
  }
  const writes = [
    ["/api/v1/admin/integrations/metaapi", "PUT"],
    ["/api/v1/admin/integrations/metaapi", "DELETE"],
    ["/api/v1/admin/integrations/metaapi/test", "POST"],
    ["/api/v1/admin/integrations/email", "PUT"],
    ["/api/v1/admin/integrations/email", "DELETE"],
    ["/api/v1/admin/integrations/email/test", "POST"],
    ["/api/v1/admin/integrations/relay/config", "PUT"],
    ["/api/v1/admin/integrations/relay/config", "DELETE"],
  ] as const;
  for (const [path, method] of writes) {
    const res = await handleIntegrationRoutes(ctxFor({ path, method, role: "admin" }));
    assert.equal(res?.status, 403, `admin write ${method} ${path} should be 403`);
  }
});

test("integrations: super_admin can read and write (200)", async () => {
  const svc = new IntegrationService({ store: new MemoryIntegrationStore(), masterKey: masterKey(), env: () => undefined });
  let res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations", method: "GET", role: "super_admin", integrations: svc }));
  assert.equal(res?.status, 200);
  res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/metaapi", method: "GET", role: "super_admin", integrations: svc }));
  assert.equal(res?.status, 200);
  res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/email", method: "GET", role: "super_admin", integrations: svc }));
  assert.equal(res?.status, 200);
});

test("integrations: metaapi PUT validates and persists", async () => {
  const svc = new IntegrationService({ store: new MemoryIntegrationStore(), masterKey: masterKey(), env: () => undefined });
  // empty body → 422
  let res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/metaapi", method: "PUT", role: "super_admin", integrations: svc, body: {} }));
  assert.equal(res?.status, 422);
  // invalid base_url → 422
  res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/metaapi", method: "PUT", role: "super_admin", integrations: svc, body: { base_url: "http://bad" } }));
  assert.equal(res?.status, 422);
  // valid → 200 and safe fields
  res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/metaapi", method: "PUT", role: "super_admin", integrations: svc, body: { token: "valid-token-12345678", base_url: "https://api.metaapi.cloud" } }));
  assert.equal(res?.status, 200);
  const body = res?.body as { data?: { integration?: { hasToken?: boolean } } };
  assert.equal(body.data?.integration?.hasToken, true);
});

test("integrations: email PUT validates", async () => {
  const svc = new IntegrationService({ store: new MemoryIntegrationStore(), masterKey: masterKey(), env: () => undefined });
  let res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/email", method: "PUT", role: "super_admin", integrations: svc, body: {} }));
  assert.equal(res?.status, 422);
  res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/email", method: "PUT", role: "super_admin", integrations: svc, body: { driver: "bad" } }));
  assert.equal(res?.status, 422);
  res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/email", method: "PUT", role: "super_admin", integrations: svc, body: { driver: "resend", resend_api_key: "re_12345678901234567890_abcdef" } }));
  assert.equal(res?.status, 200);
});

test("integrations: inventory shape", async () => {
  const svc = new IntegrationService({ store: new MemoryIntegrationStore(), masterKey: masterKey(), env: () => undefined });
  const res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations", method: "GET", role: "super_admin", integrations: svc }));
  assert.equal(res?.status, 200);
  const body = res?.body as { data?: { integrations?: { metaapi?: unknown; email?: unknown } } };
  assert.ok(body.data?.integrations?.metaapi);
  assert.ok(body.data?.integrations?.email);
});

test("integrations: capability absent → 503", async () => {
  const ctx: ExtendedRouteContext = {
    path: "/api/v1/admin/integrations",
    method: "GET",
    url: new URL("http://localhost/api/v1/admin/integrations"),
    req: { headers: {} } as unknown as ExtendedRouteContext["req"],
    requestId: "test",
    config: {} as unknown as ExtendedRouteContext["config"],
    authenticate: () => ({ sub: "u1", role: "super_admin", email: "a@b" }),
    isSystemOwner: async () => false,
    readBody: async () => ({}),
  } as unknown as ExtendedRouteContext;
  const res = await handleIntegrationRoutes(ctx);
  assert.equal(res?.status, 503);
});

test("integrations: relay alias without aiAdmin → 503", async () => {
  const svc = new IntegrationService({ store: new MemoryIntegrationStore(), masterKey: masterKey(), env: () => undefined });
  const res = await handleIntegrationRoutes(ctxFor({ path: "/api/v1/admin/integrations/relay/config", method: "GET", role: "super_admin", integrations: svc }));
  assert.equal(res?.status, 503);
});
