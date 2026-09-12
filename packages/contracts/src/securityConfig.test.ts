// Security boot configuration tests — Phase B (S1/S2/S8). Unit-level policy
// verification: every rule fires exactly as specified, findings never embed
// values, and no path produces a usable fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSecurityBoot,
  JWT_SECRET_MIN_CHARS,
  type SecurityBootEnv,
} from "./securityConfig.js";

const STRONG_SECRET = "unit-test-jwt-secret-0123456789abcdefghijklmnop"; // 46 chars, test-only
const DB_URL = "postgresql://127.0.0.1:5432/velora"; // credential-less, test-only

function codes(findings: readonly { code: string }[]): string[] {
  return findings.map((f) => f.code);
}

function prodEnv(overrides: Partial<SecurityBootEnv> = {}): SecurityBootEnv {
  return {
    JWT_SECRET: STRONG_SECRET,
    PERSISTENCE: "postgres",
    DATABASE_URL: DB_URL,
    API_ALLOWED_ORIGINS: "https://veloratrade.ir",
    ...overrides,
  };
}

test("S8 GATE: production + PERSISTENCE=memory is a BLOCK (startup failure)", () => {
  const r = validateSecurityBoot(prodEnv({ PERSISTENCE: "memory" }), "production");
  assert.equal(r.valid, false);
  assert.ok(codes(r.findings).includes("SC-004"));
  assert.equal(r.persistence, null); // no partial config escapes
});

test("S8: staging + PERSISTENCE=memory is a BLOCK", () => {
  const r = validateSecurityBoot(prodEnv({ PERSISTENCE: "memory" }), "staging");
  assert.equal(r.valid, false);
  assert.ok(codes(r.findings).includes("SC-004"));
});

test("S8: production without explicit PERSISTENCE is a BLOCK (no implicit default)", () => {
  const r = validateSecurityBoot(prodEnv({ PERSISTENCE: undefined }), "production");
  assert.equal(r.valid, false);
  assert.ok(codes(r.findings).includes("SC-005"));
});

test("S8: postgres persistence without DATABASE_URL is a BLOCK", () => {
  const r = validateSecurityBoot(prodEnv({ DATABASE_URL: undefined }), "production");
  assert.equal(r.valid, false);
  assert.ok(codes(r.findings).includes("SC-006"));
  const dev = validateSecurityBoot(prodEnv({ DATABASE_URL: "  " }), "development");
  assert.equal(dev.valid, false);
  assert.ok(codes(dev.findings).includes("SC-006"));
});

test("S8: invalid PERSISTENCE value is a BLOCK (case-sensitive)", () => {
  for (const bad of ["Memory", "POSTGRES", "mysql", "redis"]) {
    const r = validateSecurityBoot(prodEnv({ PERSISTENCE: bad }), "production");
    assert.equal(r.valid, false, `PERSISTENCE=${bad} must block`);
    assert.ok(codes(r.findings).includes("SC-003"));
  }
});

test("S1 GATE: production without JWT_SECRET is a BLOCK", () => {
  const r = validateSecurityBoot(prodEnv({ JWT_SECRET: undefined }), "production");
  assert.equal(r.valid, false);
  assert.ok(codes(r.findings).includes("SC-001"));
});

test("S1: whitespace-only JWT_SECRET counts as missing", () => {
  const r = validateSecurityBoot(prodEnv({ JWT_SECRET: "   \t  " }), "production");
  assert.equal(r.valid, false);
  assert.ok(codes(r.findings).includes("SC-001"));
});

test("S1: too-short JWT_SECRET is a BLOCK (boundary at exactly 32)", () => {
  const short = "a".repeat(JWT_SECRET_MIN_CHARS - 1); // 31 chars
  const rShort = validateSecurityBoot(prodEnv({ JWT_SECRET: short }), "production");
  assert.equal(rShort.valid, false);
  assert.ok(codes(rShort.findings).includes("SC-002"));

  const exact = "b".repeat(JWT_SECRET_MIN_CHARS); // exactly 32 chars
  const rExact = validateSecurityBoot(prodEnv({ JWT_SECRET: exact }), "production");
  assert.equal(rExact.valid, true);
});

test("S1: valid secret is returned UNMUTATED (raw value, never trimmed)", () => {
  const padded = "x".repeat(40); // no padding case needed for equality check below
  const r = validateSecurityBoot(prodEnv({ JWT_SECRET: padded }), "production");
  assert.equal(r.jwtSecret, padded);
});

test("S1: findings never embed the configured secret value", () => {
  const r = validateSecurityBoot(prodEnv({ JWT_SECRET: "a".repeat(31) }), "production");
  const text = JSON.stringify(r.findings);
  assert.ok(!text.includes("aaaaaaaa"));
});

test("S2 GATE: production without API_ALLOWED_ORIGINS is a BLOCK", () => {
  const r = validateSecurityBoot(prodEnv({ API_ALLOWED_ORIGINS: undefined }), "production");
  assert.equal(r.valid, false);
  assert.ok(codes(r.findings).includes("SC-007"));
  const empty = validateSecurityBoot(prodEnv({ API_ALLOWED_ORIGINS: " , ," }), "production");
  assert.equal(empty.valid, false);
  assert.ok(codes(empty.findings).includes("SC-007"));
});

test("dev allowances: memory default and absent secret WARN but stay valid", () => {
  const r = validateSecurityBoot(
    { PERSISTENCE: undefined, JWT_SECRET: undefined },
    "development",
  );
  assert.equal(r.valid, true);
  assert.deepEqual(codes(r.findings).sort(), ["SC-008", "SC-009"]);
  assert.deepEqual(r.persistence, { kind: "memory" }); // loud, dev-only default
  assert.equal(r.jwtSecret, undefined);
});

test("dev: explicit PERSISTENCE=memory is valid without warnings for it", () => {
  const r = validateSecurityBoot({ PERSISTENCE: "memory" }, "development");
  assert.equal(r.valid, true);
  assert.ok(!codes(r.findings).includes("SC-008"));
  assert.deepEqual(r.persistence, { kind: "memory" });
});

test("dev: postgres persistence still requires DATABASE_URL", () => {
  const r = validateSecurityBoot({ PERSISTENCE: "postgres" }, "development");
  assert.equal(r.valid, false);
  assert.ok(codes(r.findings).includes("SC-006"));
});

test("dev: strong secret supplied is carried through", () => {
  const r = validateSecurityBoot({ JWT_SECRET: STRONG_SECRET }, "development");
  assert.equal(r.valid, true);
  assert.equal(r.jwtSecret, STRONG_SECRET);
});

test("production happy path: full explicit configuration is valid", () => {
  const r = validateSecurityBoot(prodEnv(), "production");
  assert.equal(r.valid, true);
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.persistence, { kind: "postgres", databaseUrl: DB_URL });
  assert.equal(r.jwtSecret, STRONG_SECRET);
});
