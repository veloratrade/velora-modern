// Rate-limit decision semantics — PHP Core/RateLimiter.php parity (inc 7).
// Pure-logic tests: the store port is faked; every assertion traces to the
// PHP source (increment-then-check, hits > max blocks, Retry-After math).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRateLimit, type RateLimitStore } from "./rateLimit.js";

test("evaluateRateLimit: the limit-th attempt is allowed, the (limit+1)-th is the first blocked", () => {
  // PHP: `if ($row !== false && (int) $row['hits'] > $maxAttempts)` AFTER the
  // upsert increments — hits 1..limit pass, hits limit+1 blocks.
  const policy = { limit: 5, windowSec: 3600 };
  const now = 1_000_000;
  const start = now - 60_000;
  for (let hits = 1; hits <= 5; hits++) {
    assert.deepEqual(evaluateRateLimit({ hits, windowStartMs: start }, policy, now), { allowed: true });
  }
  assert.deepEqual(evaluateRateLimit({ hits: 6, windowStartMs: start }, policy, now), {
    allowed: false,
    retryAfterSec: 3540,
  });
});

test("evaluateRateLimit: Retry-After counts seconds until window expiry (ceil, min 1)", () => {
  const policy = { limit: 1, windowSec: 300 };
  const start = 0;
  const blockedAt = (nowMs: number) => {
    const decision = evaluateRateLimit({ hits: 2, windowStartMs: start }, policy, nowMs);
    assert.equal(decision.allowed, false);
    return decision.allowed === false ? decision.retryAfterSec : Number.NaN;
  };
  // exactly at expiry → 0 remaining → clamped to 1 (PHP max(1, 0))
  assert.equal(blockedAt(300_000), 1);
  // 400 ms before expiry → ceil(0.4) = 1
  assert.equal(blockedAt(299_600), 1);
  // 1.4 s before expiry → ceil(1.4) = 2
  assert.equal(blockedAt(298_600), 2);
  // past expiry (clock skew) → never 0 or negative → 1 (PHP max(1, negative))
  assert.equal(blockedAt(301_000), 1);
});

test("evaluateRateLimit: blocked hits keep counting — the decision stays blocked", () => {
  const policy = { limit: 8, windowSec: 300 };
  for (let hits = 9; hits <= 40; hits++) {
    assert.equal(evaluateRateLimit({ hits, windowStartMs: 0 }, policy, 1000).allowed, false);
  }
});

test("RateLimitStore port contract shape: hit(bucket, policy, nowMs) → {hits, windowStartMs}", async () => {
  // Compile-time port usage proof with a minimal fake (the memory adapter and
  // the PGlite persistence test implement the same port against real stores).
  const fake: RateLimitStore = {
    async hit(bucket, policy, nowMs) {
      assert.equal(bucket, "auth:login|1.2.3.4");
      assert.equal(policy.windowSec, 300);
      return { hits: 9, windowStartMs: nowMs - 1000 };
    },
  };
  const state = await fake.hit("auth:login|1.2.3.4", { windowSec: 300 }, 10_000);
  assert.deepEqual(evaluateRateLimit(state, { limit: 8, windowSec: 300 }, 10_000), {
    allowed: false,
    retryAfterSec: 299,
  });
});
