// Boot gate tests — Phase B (S2/S8). Unit-level policy verification of the
// fail-closed startup path: every blocking rule and the loud development
// allowances. The process entrypoint (server-main.ts) is a thin shell over
// this pure function — labeled accordingly in the Phase B record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertBootable, BootError, type BootFinding } from "./boot.js";

const PROD_SECRET = "boot-unit-test-jwt-secret-0123456789abcdefgh"; // 43 chars, test-only
const DB_URL = "postgresql://127.0.0.1:5432/velora"; // credential-less, test-only

type Env = Record<string, string | undefined>;

function prodEnv(overrides: Env = {}): Env {
  return {
    APP_ENV: "production",
    APP_ORIGIN: "https://veloratrade.ir",
    CANONICAL_PRODUCTION_ORIGINS: "https://veloratrade.ir",
    CANONICAL_STAGING_ORIGINS: "https://staging.veloratrade.ir",
    API_ALLOWED_ORIGINS: "https://veloratrade.ir",
    JWT_SECRET: PROD_SECRET,
    PERSISTENCE: "postgres",
    DATABASE_URL: DB_URL,
    ...overrides,
  };
}

/** Assert that boot is BLOCKED and return the BootError for inspection. */
function expectBlock(env: Env): BootError {
  try {
    assertBootable(env);
  } catch (e) {
    if (e instanceof BootError) return e;
    throw e;
  }
  assert.fail("expected BootError but boot succeeded");
}

function codes(findings: readonly BootFinding[]): string[] {
  return findings.map((f) => f.code);
}

test("production happy path: complete explicit configuration boots", () => {
  const cfg = assertBootable(prodEnv({ PORT: "8443" }));
  assert.equal(cfg.environment, "production");
  assert.equal(cfg.port, 8443);
  assert.equal(cfg.appOrigin, "https://veloratrade.ir");
  assert.deepEqual(cfg.persistence, { kind: "postgres", databaseUrl: DB_URL });
  assert.equal(cfg.jwtSecret, PROD_SECRET);
  assert.deepEqual(cfg.allowedOrigins, ["https://veloratrade.ir"]);
  assert.deepEqual(cfg.warnings, []);
});

test("S8 GATE: APP_ENV=production + PERSISTENCE=memory is a startup failure (SC-004)", () => {
  const err = expectBlock(prodEnv({ PERSISTENCE: "memory" }));
  assert.ok(codes(err.findings).includes("SC-004"));
});

test("S8: staging + memory persistence is a startup failure", () => {
  const err = expectBlock(
    prodEnv({
      APP_ENV: "staging",
      APP_ORIGIN: "https://staging.veloratrade.ir",
      PERSISTENCE: "memory",
    }),
  );
  assert.ok(codes(err.findings).includes("SC-004"));
});

test("S8: production without explicit PERSISTENCE fails (SC-005)", () => {
  const err = expectBlock(prodEnv({ PERSISTENCE: undefined }));
  assert.ok(codes(err.findings).includes("SC-005"));
});

test("S8: postgres persistence without DATABASE_URL fails (SC-006)", () => {
  const err = expectBlock(prodEnv({ DATABASE_URL: undefined }));
  assert.ok(codes(err.findings).includes("SC-006"));
});

test("S1 GATE: production without JWT_SECRET fails startup (SC-001)", () => {
  const err = expectBlock(prodEnv({ JWT_SECRET: undefined }));
  assert.ok(codes(err.findings).includes("SC-001"));
});

test("S1: production with a too-short JWT_SECRET fails startup (SC-002)", () => {
  const err = expectBlock(prodEnv({ JWT_SECRET: "short-secret-123" }));
  assert.ok(codes(err.findings).includes("SC-002"));
});

test("S2 GATE: production without explicit API_ALLOWED_ORIGINS fails (SC-007)", () => {
  const err = expectBlock(prodEnv({ API_ALLOWED_ORIGINS: undefined }));
  assert.ok(codes(err.findings).includes("SC-007"));
});

test("EO-001: missing APP_ENV fails startup (no implicit environment default)", () => {
  const err = expectBlock(prodEnv({ APP_ENV: undefined }));
  assert.ok(codes(err.findings).includes("EO-001"));
});

test("EO-002: missing APP_ORIGIN fails startup (no implicit origin default)", () => {
  const err = expectBlock(prodEnv({ APP_ORIGIN: undefined }));
  assert.ok(codes(err.findings).includes("EO-002"));
});

test("EO-009: production origin outside the declared canonical set fails", () => {
  const err = expectBlock(prodEnv({ APP_ORIGIN: "https://evil.example" }));
  assert.ok(codes(err.findings).includes("EO-009"));
});

test("EO-009: production with NO declared canonical origins fails closed", () => {
  const err = expectBlock(prodEnv({ CANONICAL_PRODUCTION_ORIGINS: undefined }));
  assert.ok(codes(err.findings).includes("EO-009"));
});

test("EO-008: staging with no canonical staging origin fails (undecided by design)", () => {
  const err = expectBlock(
    prodEnv({
      APP_ENV: "staging",
      APP_ORIGIN: "https://staging.veloratrade.ir",
      CANONICAL_STAGING_ORIGINS: undefined,
    }),
  );
  assert.ok(codes(err.findings).includes("EO-008"));
});

test("staging happy path: owner-declared candidate origin + full config boots", () => {
  const cfg = assertBootable(
    prodEnv({ APP_ENV: "staging", APP_ORIGIN: "https://staging.veloratrade.ir" }),
  );
  assert.equal(cfg.environment, "staging");
});

test("EO-007: staging intent with a production origin fails (cross-environment binding)", () => {
  const err = expectBlock(prodEnv({ APP_ENV: "staging" })); // APP_ORIGIN stays production
  assert.ok(codes(err.findings).includes("EO-007"));
});

test("EO-005: APP_ORIGIN with a path fails (bare origin required)", () => {
  const err = expectBlock(prodEnv({ APP_ORIGIN: "https://veloratrade.ir/app" }));
  assert.ok(codes(err.findings).includes("EO-005"));
});

test("development boots with loud WARN allowances (memory default, no secret)", () => {
  const cfg = assertBootable({ APP_ENV: "development", APP_ORIGIN: "http://127.0.0.1:8080" });
  assert.equal(cfg.environment, "development");
  assert.deepEqual(cfg.persistence, { kind: "memory" });
  assert.equal(cfg.jwtSecret, undefined);
  const warnCodes = codes(cfg.warnings);
  assert.ok(warnCodes.includes("SC-008"));
  assert.ok(warnCodes.includes("SC-009"));
  assert.deepEqual(cfg.allowedOrigins, ["http://127.0.0.1:8080"]);
});

test("development with explicit memory + secret boots without those warnings", () => {
  const cfg = assertBootable({
    APP_ENV: "development",
    APP_ORIGIN: "http://127.0.0.1:3000",
    PERSISTENCE: "memory",
    JWT_SECRET: PROD_SECRET,
    PORT: "3000",
  });
  const warnCodes = codes(cfg.warnings);
  assert.ok(!warnCodes.includes("SC-008"));
  assert.ok(!warnCodes.includes("SC-009"));
  assert.deepEqual(cfg.allowedOrigins, ["http://127.0.0.1:3000"]);
});

test("development with postgres persistence still requires DATABASE_URL", () => {
  const err = expectBlock({
    APP_ENV: "development",
    APP_ORIGIN: "http://127.0.0.1:8080",
    PERSISTENCE: "postgres",
  });
  assert.ok(codes(err.findings).includes("SC-006"));
});

test("development with an invalid PERSISTENCE value fails (SC-003)", () => {
  const err = expectBlock({
    APP_ENV: "development",
    APP_ORIGIN: "http://127.0.0.1:8080",
    PERSISTENCE: "sqlite",
  });
  assert.ok(codes(err.findings).includes("SC-003"));
});

test("EO-010: development non-loopback https origin warns but boots", () => {
  const cfg = assertBootable({
    APP_ENV: "development",
    APP_ORIGIN: "https://dev.internal.example",
  });
  assert.ok(codes(cfg.warnings).includes("EO-010"));
});

test("BOOT-001: invalid PORT fails startup deterministically", () => {
  for (const bad of ["not-a-port", "0", "-1", "99999", "80.5", ""]) {
    const err = expectBlock(prodEnv({ PORT: bad }));
    assert.ok(codes(err.findings).includes("BOOT-001"), `PORT=${bad} must block`);
  }
});

test("multiple blocking findings are ALL reported in one BootError", () => {
  const err = expectBlock(
    prodEnv({ APP_ORIGIN: undefined, JWT_SECRET: undefined, PERSISTENCE: undefined }),
  );
  const c = codes(err.findings);
  for (const expected of ["EO-002", "SC-001", "SC-005"]) {
    assert.ok(c.includes(expected), `expected ${expected} in ${c.join(",")}`);
  }
});

test("BootError message lists blocking codes without any configured value", () => {
  const err = expectBlock(prodEnv({ JWT_SECRET: undefined, PERSISTENCE: "memory" }));
  assert.match(err.message, /SC-001/);
  assert.match(err.message, /SC-004/);
  assert.ok(!err.message.includes(PROD_SECRET));
  assert.ok(!JSON.stringify(err.findings).includes(PROD_SECRET));
});
