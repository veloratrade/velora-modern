// The composition root's own contract: WHICH capabilities a Worker deployment has, and what it does
// when the environment refuses to boot.
//
// No database is touched. `buildApiConfig` only CONSTRUCTS stores; every one of them issues its query
// lazily, so a fake pool that throws on use proves the point — if any store reached for a connection
// at boot, these tests would fail.
import test from "node:test";
import assert from "node:assert/strict";

import { buildApiConfig, createFetch } from "./runtime.js";
import type { PoolLike } from "../../worker-cf/src/pgHyperdrive.js";
import { BootError } from "../../api/src/kernel/boot.js";

const fakePool = (): PoolLike => ({
  query: async () => {
    throw new Error("no database in this test");
  },
  connect: async () => {
    throw new Error("no database in this test");
  },
  end: async () => undefined,
});

/** Exactly the vars in `wrangler.jsonc`, plus the two secrets a deploy supplies. */
const stagingEnv = () => ({
  HYPERDRIVE: { // No credentials in the test file, by policy: the value is never dialled, and a credential-shaped
  // literal here would (rightly) trip `tools/secret-scan.sh`.
  connectionString: "postgres://pooler.example.test:5432/velora_journal" },
  APP_ENV: "staging",
  APP_ORIGIN: "https://velora-modern-staging.yadgar-s-ict.workers.dev",
  CANONICAL_STAGING_ORIGINS: "https://velora-modern-staging.yadgar-s-ict.workers.dev",
  API_ALLOWED_ORIGINS: "https://velora-modern-staging.yadgar-s-ict.workers.dev",
  PERSISTENCE: "postgres",
  JWT_SECRET: "test-only-secret-value-of-sufficient-length-0123456789",
});

test("a correctly configured staging Worker wires auth, sessions, admin users and the admin console", () => {
  const { config, boot } = buildApiConfig(stagingEnv(), fakePool());
  assert.equal(boot.environment, "staging");
  assert.equal(boot.appOrigin, "https://velora-modern-staging.yadgar-s-ict.workers.dev");
  assert.deepEqual(boot.allowedOrigins, ["https://velora-modern-staging.yadgar-s-ict.workers.dev"]);
  // The panel's needs, one by one. `auth` carries the session surface; `adminUsers` + `adminConsole`
  // are what /admin renders from; `authEvents` is the login history the security tab reads.
  assert.ok(config.auth !== undefined, "auth capability");
  assert.ok(config.authEvents !== undefined, "auth events");
  assert.ok(config.adminUsers !== undefined, "admin user management");
  assert.ok(config.adminConsole !== undefined, "admin console");
  assert.ok(config.ownership !== undefined, "ownership (System Owner bootstrap)");
});

test("capabilities this host does not wire are ABSENT, so the kernel answers 503 instead of inventing data", () => {
  const { config } = buildApiConfig(stagingEnv(), fakePool());
  for (const capability of ["accounts", "trades", "credentials", "provisioning", "ai", "support"] as const) {
    assert.equal((config as Record<string, unknown>)[capability], undefined, `${capability} must not be wired`);
  }
});

test("the database health check reports the truth, not liveness", async () => {
  const { config } = buildApiConfig(stagingEnv(), fakePool());
  assert.equal(await config.checks.database?.(), "fail", "a pool that throws is not a healthy database");
});

test("a staging env with no JWT secret is refused at boot — the kernel's rule, not a Worker-specific one", () => {
  const env = { ...stagingEnv(), JWT_SECRET: undefined };
  assert.throws(
    () => buildApiConfig(env, fakePool()),
    (error: unknown) => error instanceof BootError && error.findings.some((f) => f.code === "SC-001"),
  );
});

test("a staging env that contradicts its own origin is refused (ADR-013)", () => {
  const env = { ...stagingEnv(), APP_ORIGIN: "https://not-a-declared-canonical-origin.example.test" };
  assert.throws(() => buildApiConfig(env, fakePool()), BootError);
});

test("createFetch answers 503 BOOT_BLOCKED with codes — never a crash, never a value", async () => {
  const env = { ...stagingEnv(), JWT_SECRET: "short" };
  const res = await createFetch(env as never)(new Request("https://api.example.test/health"));
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  assert.equal(body.error?.code, "BOOT_BLOCKED");
  assert.match(body.error?.message ?? "", /SC-002/);
  assert.ok(!JSON.stringify(body).includes("short"), "the offending VALUE must not be echoed");
});
