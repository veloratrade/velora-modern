import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_ROUTES, resolvePublicRoute, CACHE_POLICY, LOCALE_HEADER,
  canonicalEmail, buildVerifyEmailLink, buildResetPasswordLink,
  RATE_LIMIT_DEFAULTS, ARGON2ID_PARAMS, SCALES, ok, fail, WEBHOOK_SOURCES, ERROR_CODES,
  LEGACY_TZ_INTERPRETATION,
} from "./index.js";

test("locale URL contract (ADR-009/D-14): checkout exists in BOTH locales at decided paths", () => {
  const fa = resolvePublicRoute("/fa/checkout");
  const en = resolvePublicRoute("/en/checkout");
  assert.deepEqual([fa?.locale, fa?.routeClass], ["fa", "C"]);
  assert.deepEqual([en?.locale, en?.routeClass], ["en", "C"]);
});

test("'/' is fa-default; '/en/' is the English home (frozen contract C-02/C-03)", () => {
  assert.equal(resolvePublicRoute("/")?.locale, "fa");
  assert.equal(resolvePublicRoute("/en/")?.locale, "en");
  assert.equal(resolvePublicRoute("/en")?.locale, undefined); // no bare /en — explicit trailing form only
});

test("blog articles resolve as class B (editorial); markets as class A", () => {
  assert.equal(resolvePublicRoute("/blog/what-is-trading-journal/")?.routeClass, "B");
  assert.equal(resolvePublicRoute("/en/blog/forex-trading-journal/")?.routeClass, "B");
  assert.equal(resolvePublicRoute("/markets")?.routeClass, "A");
});

test("cache classes differ by route class (market ≠ editorial ≠ static)", () => {
  assert.notEqual(CACHE_POLICY.A, CACHE_POLICY.B);
  assert.notEqual(CACHE_POLICY.B, CACHE_POLICY.C);
  assert.equal(CACHE_POLICY.D, "private, no-store");
});

test("locale header name preserved", () => {
  assert.equal(LOCALE_HEADER, "X-VELORA-Locale");
});

test("email canonicalization (ADR-003/D-02): lowercase + trim at every write", () => {
  assert.equal(canonicalEmail("  John@X.COM "), "john@x.com");
});

test("email link formats match the verified PHP formats exactly (C-06/C-07)", () => {
  assert.equal(buildVerifyEmailLink("https://veloratrade.ir", "abc%def"), "https://veloratrade.ir/verify-email#token=abc%25def");
  assert.equal(buildResetPasswordLink("https://veloratrade.ir/", "tok"), "https://veloratrade.ir/reset-password#token=tok");
});

test("rate-limit defaults carry the verified PHP limits (C-14)", () => {
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:register"], { limit: 5, windowSec: 3600 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:login"], { limit: 8, windowSec: 300 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["trades:extract-screenshot"], { limit: 8, windowSec: 300 });
  // inc 7: the remaining auth limits verified against the PHP dispatch table
  // (api/index.php 260–289) — all eight auth routes match exactly.
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:verify-email"], { limit: 20, windowSec: 900 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:resend-verification"], { limit: 4, windowSec: 3600 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:forgot-password"], { limit: 4, windowSec: 3600 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:reset-password"], { limit: 6, windowSec: 3600 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:refresh"], { limit: 30, windowSec: 300 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:change-password"], { limit: 8, windowSec: 900 });
});

test("error taxonomy carries the evidenced 429 code TOO_MANY_REQUESTS (inc 7)", () => {
  // Both lineages emit TOO_MANY_REQUESTS on 429 (PHP Response::defaultCode +
  // RateLimiter ApiException; Remote ApiError). The earlier RATE_LIMITED
  // placeholder appeared in neither lineage and was corrected (inc-7
  // inventory §6 D3) before any endpoint ever emitted it.
  assert.equal(ERROR_CODES.TOO_MANY_REQUESTS, "TOO_MANY_REQUESTS");
});

test("Argon2id parameters match owner decision D-04", () => {
  assert.deepEqual(ARGON2ID_PARAMS, { memoryKiB: 19456, iterations: 2, parallelism: 1 });
});

test("scale matrix matches ADR-001", () => {
  assert.deepEqual(SCALES, { price: 8, volume: 8, contractSize: 8, currency: 2, rMultiple: 8 });
});

test("envelope shape (C-10: PHP 4-field envelope, Phase C port)", () => {
  const success = ok({ status: "ok" }, new Date("2026-09-12T10:00:00.500Z"));
  assert.deepEqual(success, {
    status: "success",
    data: { status: "ok" },
    error: null,
    timestamp: "2026-09-12T10:00:00+00:00", // PHP gmdate('c') format (OD-5)
  });
  const error = fail("NOT_FOUND", "x", "req-1", undefined, new Date("2026-09-12T10:00:00.500Z"));
  assert.equal(error.status, "error");
  assert.equal(error.data, null);
  assert.equal(error.error.code, "NOT_FOUND");
  assert.equal(error.error.requestId, "req-1");
  assert.equal(error.timestamp, "2026-09-12T10:00:00+00:00");
});

test("webhook sources: metaapi configured with ±5 min tolerance (D-05)", () => {
  assert.equal(WEBHOOK_SOURCES.length, 1);
  assert.equal(WEBHOOK_SOURCES[0]!.toleranceMs, 5 * 60 * 1000);
});

test("legacy timezone remains evidence-gated (ADR-004)", () => {
  assert.equal(LEGACY_TZ_INTERPRETATION.status, "BLOCKED_ON_SAMPLING");
});
