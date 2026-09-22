// FixedWindowRateLimiter — composition of the frozen C-14 policies with the
// domain window semantics (inc 7). Injected clock → deterministic sequences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMIT_DEFAULTS } from "@velora/contracts";
import { FixedWindowRateLimiter } from "./rateLimiter.js";
import { MemoryRateLimitStore } from "./memoryRateLimitStore.js";

test("policies come from the frozen C-14 contract (register 5/3600, login 8/300)", async () => {
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:register"], { limit: 5, windowSec: 3600 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:login"], { limit: 8, windowSec: 300 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:refresh"], { limit: 30, windowSec: 300 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:verify-email"], { limit: 20, windowSec: 900 });
  assert.deepEqual(RATE_LIMIT_DEFAULTS["auth:change-password"], { limit: 8, windowSec: 900 });
});

test("register: 5 attempts allowed, the 6th is blocked with Retry-After = 3600", async () => {
  let now = 1_000_000;
  const limiter = new FixedWindowRateLimiter(new MemoryRateLimitStore(), () => now);
  for (let i = 1; i <= 5; i++) {
    assert.deepEqual(await limiter.hit("auth:register", "203.0.113.9"), { allowed: true });
  }
  assert.deepEqual(await limiter.hit("auth:register", "203.0.113.9"), {
    allowed: false,
    retryAfterSec: 3600, // window anchored at the first hit, blocked immediately after
  });
  // blocked attempts keep counting — still blocked
  assert.equal((await limiter.hit("auth:register", "203.0.113.9")).allowed, false);
});

test("window passes → a fresh window starts (clock-advanced sequence)", async () => {
  let now = 0;
  const limiter = new FixedWindowRateLimiter(new MemoryRateLimitStore(), () => now);
  for (let i = 0; i < 8; i++) await limiter.hit("auth:login", "198.51.100.1");
  const blocked = await limiter.hit("auth:login", "198.51.100.1");
  assert.deepEqual(blocked, { allowed: false, retryAfterSec: 300 });
  now = 300_001; // past the login window
  assert.deepEqual(await limiter.hit("auth:login", "198.51.100.1"), { allowed: true });
});

test("bucket keys separate client IPs (per-IP isolation at the limiter level)", async () => {
  let now = 0;
  const limiter = new FixedWindowRateLimiter(new MemoryRateLimitStore(), () => now);
  for (let i = 0; i < 5; i++) await limiter.hit("auth:register", "203.0.113.9");
  assert.equal((await limiter.hit("auth:register", "203.0.113.9")).allowed, false);
  assert.deepEqual(await limiter.hit("auth:register", "203.0.113.10"), { allowed: true });
});

test("store failures propagate to the caller (kernel renders the fail-closed 503)", async () => {
  const exploding = {
    async hit(): Promise<{ hits: number; windowStartMs: number }> {
      throw new Error("store down");
    },
  };
  const limiter = new FixedWindowRateLimiter(exploding, () => 0);
  await assert.rejects(() => limiter.hit("auth:login", "1.2.3.4"), /store down/);
});
