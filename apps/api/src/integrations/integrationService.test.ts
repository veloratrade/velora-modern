import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIntegrationStore } from "./memoryIntegrationStore.js";
import { IntegrationService } from "./integrationService.js";
import { MasterKey } from "../credentials/credentialCrypto.js";

function mkService(env: Record<string, string> = {}, masterKey: MasterKey | null = MasterKey.fromBase64(Buffer.alloc(32, 7).toString("base64"), 1)): IntegrationService {
  return new IntegrationService({
    store: new MemoryIntegrationStore(),
    masterKey,
    env: (k) => env[k],
  });
}

test("inventory: empty store with no ENV reports not configured", async () => {
  const svc = mkService();
  const inv = await svc.inventory();
  assert.equal(inv.metaapi.configured, false);
  assert.equal(inv.metaapi.hasToken, false);
  assert.equal(inv.metaapi.baseUrl, "https://api.metaapi.cloud");
  assert.equal(inv.email.configured, true); // log driver default is always configured
  assert.equal(inv.email.driver, "log");
});

test("metaapi: update and status round-trip (admin secret precedence over ENV)", async () => {
  const svc = mkService({ METAAPI_PLATFORM_TOKEN: "env-token-should-be-overridden-if-admin-present" });
  // initially token from ENV
  let s = await svc.metaApiStatus();
  assert.equal(s.hasToken, true);
  assert.equal(s.tokenSource, "env");
  // write admin token
  await svc.updateMetaApi({ token: "admin-metaapi-token-1234567890", baseUrl: "https://api.metaapi.cloud" }, "actor-1");
  s = await svc.metaApiStatus();
  assert.equal(s.hasToken, true);
  assert.equal(s.tokenSource, "admin");
  assert.equal(s.baseUrl, "https://api.metaapi.cloud");
  assert.equal(s.baseUrlSource, "admin");
});

test("metaapi: update requires at least one field", async () => {
  const svc = mkService();
  await assert.rejects(() => svc.updateMetaApi({}, null), (e: unknown) => {
    const err = e as { details?: Record<string, readonly string[]> };
    return err.details?.["integration"]?.includes("INTEGRATION_CONFIG_EMPTY") ?? false;
  });
});

test("metaapi: invalid base_url is rejected", async () => {
  const svc = mkService();
  await assert.rejects(() => svc.updateMetaApi({ baseUrl: "http://insecure.example.com" }, null), /MetaAPI base URL/);
  await assert.rejects(() => svc.updateMetaApi({ baseUrl: "https://10.0.0.1" }, null), /MetaAPI base URL/);
});

test("metaapi: clear removes admin token and falls back to ENV", async () => {
  const svc = mkService({ METAAPI_PLATFORM_TOKEN: "env-fallback-token" });
  await svc.updateMetaApi({ token: "admin-token-xyz-12345678" }, "a1");
  let s = await svc.metaApiStatus();
  assert.equal(s.tokenSource, "admin");
  await svc.clearMetaApi();
  s = await svc.metaApiStatus();
  assert.equal(s.hasToken, true);
  assert.equal(s.tokenSource, "env");
});

test("metaapi: test probe returns not_configured when no token", async () => {
  const svc = mkService();
  const r = await svc.testMetaApi();
  assert.equal(r.status, "not_configured");
  assert.equal(r.integration, "metaapi");
});

test("metaapi: test probe with mocked fetch", async () => {
  const store = new MemoryIntegrationStore();
  let called = false;
  const svc = new IntegrationService({
    store,
    masterKey: MasterKey.fromBase64(Buffer.alloc(32, 7).toString("base64"), 1),
    env: () => undefined,
    fetcher: async () => {
      called = true;
      return { status: 200 } as unknown as Response;
    },
  });
  await svc.updateMetaApi({ token: "probe-token-12345678" }, null);
  const r = await svc.testMetaApi();
  assert.equal(called, true);
  assert.equal(r.status, "reachable");
});

test("email: default driver is log when no resend key", async () => {
  const svc = mkService();
  const s = await svc.emailStatus();
  assert.equal(s.driver, "log");
  assert.equal(s.configured, true);
});

test("email: resend driver becomes configured when key present", async () => {
  const svc = mkService();
  await svc.updateEmail({ resendApiKey: "re_12345678901234567890_abcdef" }, "a1");
  const s = await svc.emailStatus();
  assert.equal(s.hasResendApiKey, true);
  // driver defaults to resend when key exists and no explicit driver
  assert.equal(s.driver, "resend");
  assert.equal(s.configured, true);
});

test("email: smtp driver needs host+user+pass", async () => {
  const svc = mkService();
  await svc.updateEmail({ driver: "smtp", host: "smtp.example.com", user: "user@example.com", smtpPassword: "s3cret" }, "a1");
  let s = await svc.emailStatus();
  assert.equal(s.driver, "smtp");
  assert.equal(s.configured, true);
  await svc.clearEmail();
  s = await svc.emailStatus();
  assert.equal(s.driver, "log"); // back to default
});

test("email: invalid driver rejected", async () => {
  const svc = mkService();
  await assert.rejects(() => svc.updateEmail({ driver: "bad" }, null), /Invalid mail driver/);
});

test("email: invalid from rejected", async () => {
  const svc = mkService();
  await assert.rejects(() => svc.updateEmail({ from: "not-an-email" }, null), /Invalid sender email/);
});

test("email: test probe for log driver is reachable", async () => {
  const svc = mkService();
  const r = await svc.testEmail();
  assert.equal(r.integration, "email");
  assert.equal(r.status, "reachable"); // log driver
});

test("master key missing: writing a secret fails closed 503", async () => {
  const svc = mkService({}, null);
  await assert.rejects(() => svc.updateMetaApi({ token: "any-token-123" }, null), (e: unknown) => (e as Error).name === "MasterKeyMissingError");
  await assert.rejects(() => svc.updateEmail({ resendApiKey: "re_123" }, null), (e: unknown) => (e as Error).name === "MasterKeyMissingError");
});
