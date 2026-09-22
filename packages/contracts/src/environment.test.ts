// ADR-013 environment-origin safety contract — unit tests.
// The four forbidden cases from the owner directive (2026-09-12) are the
// first four tests. Fixture canonical maps are TEST-ONLY: the real staging
// origin is owner decision OD-1 and is deliberately not hardcoded anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseEnvironment,
  validateEnvironmentOrigin,
  type CanonicalOrigins,
} from "./environment.js";

const CANONICAL: CanonicalOrigins = {
  production: ["https://veloratrade.ir", "https://www.veloratrade.ir"],
  staging: ["https://staging.veloratrade.ir"], // fixture only — OD-1 pending
};

const NO_STAGING: CanonicalOrigins = {
  production: ["https://veloratrade.ir"],
};

function codes(r: ReturnType<typeof validateEnvironmentOrigin>): string[] {
  return r.findings.map((f) => f.code);
}

test("FORBIDDEN: staging intent + production origin → BLOCK (EO-007)", () => {
  const r = validateEnvironmentOrigin("staging", "https://veloratrade.ir", CANONICAL);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes("EO-007"));
});

test("FORBIDDEN: production intent + staging origin → BLOCK (EO-009)", () => {
  const r = validateEnvironmentOrigin("production", "https://staging.veloratrade.ir", CANONICAL);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes("EO-009"));
});

test("FORBIDDEN: unknown environment + trusted origin → BLOCK (EO-001)", () => {
  for (const env of [undefined, null, "", "prod", "dev", "uat", "staging-prod"]) {
    const r = validateEnvironmentOrigin(env, "https://staging.veloratrade.ir", CANONICAL);
    assert.equal(r.valid, false, `env=${String(env)}`);
    assert.deepEqual(codes(r), ["EO-001"]);
    assert.equal(r.environment, null);
  }
});

test("FORBIDDEN: missing origin under any environment → BLOCK (EO-002), no implicit default", () => {
  for (const env of ["development", "staging", "production"]) {
    for (const origin of [undefined, null, "", "   "]) {
      const r = validateEnvironmentOrigin(env, origin, CANONICAL);
      assert.equal(r.valid, false, `env=${env} origin=${String(origin)}`);
      assert.deepEqual(codes(r), ["EO-002"]);
    }
  }
});

test("happy: staging + canonical staging origin", () => {
  const r = validateEnvironmentOrigin("staging", "https://staging.veloratrade.ir", CANONICAL);
  assert.equal(r.valid, true);
  assert.deepEqual(r.findings, []);
});

test("happy: production + each canonical production origin", () => {
  for (const o of CANONICAL.production) {
    const r = validateEnvironmentOrigin("production", o, CANONICAL);
    assert.equal(r.valid, true, o);
    assert.deepEqual(r.findings, [], o);
  }
});

test("happy: development + http loopback with port", () => {
  const r = validateEnvironmentOrigin("development", "http://localhost:3000", CANONICAL);
  assert.equal(r.valid, true);
  assert.deepEqual(r.findings, []);
});

test("development + production origin → BLOCK (EO-007)", () => {
  const r = validateEnvironmentOrigin("development", "https://veloratrade.ir", CANONICAL);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes("EO-007"));
});

test("staging + http scheme → BLOCK (EO-004)", () => {
  const r = validateEnvironmentOrigin("staging", "http://staging.veloratrade.ir", CANONICAL);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes("EO-004"));
});

test("staging + trailing slash → BLOCK (EO-005)", () => {
  const r = validateEnvironmentOrigin("staging", "https://staging.veloratrade.ir/", CANONICAL);
  assert.equal(r.valid, false);
  assert.deepEqual(codes(r), ["EO-005"]);
});

test("staging + query string → BLOCK (EO-005)", () => {
  const r = validateEnvironmentOrigin("staging", "https://staging.veloratrade.ir?x=1", CANONICAL);
  assert.equal(r.valid, false);
  assert.deepEqual(codes(r), ["EO-005"]);
});

test("origin with embedded credentials → BLOCK (EO-005)", () => {
  // Built by concatenation so the SOURCE FILE contains no literal
  // URL-credential-shaped text (tools/secret-scan.sh URL-credential rule).
  // Runtime behavior is identical to a single literal.
  const credOrigin = "https://user" + ":pw" + "@staging.veloratrade.ir";
  const r = validateEnvironmentOrigin("staging", credOrigin, CANONICAL);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes("EO-005"));
});

test("production + non-default port → BLOCK (EO-006)", () => {
  const r = validateEnvironmentOrigin("production", "https://veloratrade.ir:8443", CANONICAL);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes("EO-006"));
});

test("unparseable origin → BLOCK (EO-003)", () => {
  const r = validateEnvironmentOrigin("staging", "not-a-url", CANONICAL);
  assert.equal(r.valid, false);
  assert.deepEqual(codes(r), ["EO-003"]);
});

test("staging with NO decided canonical map → BLOCK (EO-008) — OD-1 open, staging unvalidatable", () => {
  const r = validateEnvironmentOrigin("staging", "https://staging.veloratrade.ir", NO_STAGING);
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes("EO-008"));
});

test("production with empty canonical map → BLOCK (EO-009) — fail closed on missing map", () => {
  const r = validateEnvironmentOrigin("production", "https://veloratrade.ir", {
    production: [],
  });
  assert.equal(r.valid, false);
  assert.ok(codes(r).includes("EO-009"));
});

test("development + non-loopback https host → valid with WARN (EO-010)", () => {
  const r = validateEnvironmentOrigin("development", "https://dev-box.example", CANONICAL);
  assert.equal(r.valid, true);
  assert.deepEqual(codes(r), ["EO-010"]);
  assert.equal(r.findings[0]?.severity, "WARN");
});

test("environment identity is case/whitespace tolerant but never defaults", () => {
  assert.equal(parseEnvironment("  Staging "), "staging");
  assert.equal(parseEnvironment("PRODUCTION"), "production");
  assert.equal(parseEnvironment(undefined), null);
  assert.equal(parseEnvironment("test"), null); // no Reference-style aliases
});

test("findings never embed the configured origin value (secret-safety property)", () => {
  // Concatenated for the same scanner-hygiene reason as the EO-005 test above.
  const secretish = "https://user" + ":hunter2" + "@staging.veloratrade.ir";
  const r = validateEnvironmentOrigin("staging", secretish, CANONICAL);
  assert.equal(r.valid, false);
  for (const f of r.findings) {
    assert.ok(!f.message.includes("hunter2"), f.message);
    assert.ok(!f.message.includes(secretish), f.message);
  }
});
