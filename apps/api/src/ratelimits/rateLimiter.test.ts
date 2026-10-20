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

test("a concurrent burst is limited exactly, not bypassed and not over-blocked", async () => {
  // The shape a Telegram webhook actually produces: several updates for one identity, handled without
  // awaiting each other. Two ways to get this wrong, and the memory store had the second one:
  //   • read-modify-write with an await between → the limit is bypassed (too many allowed);
  //   • returning the live bucket object → every caller sees the FINAL count and the whole burst is
  //     blocked, including the requests that were first in line.
  // A limit that is bypassable is a hole; a limit that blocks a legitimate burst is an outage. This
  // assertion is both halves of the same requirement.
  const limiter = new FixedWindowRateLimiter(new MemoryRateLimitStore(), () => 1_000);
  const decisions = await Promise.all(Array.from({ length: 20 }, () => limiter.hit("auth:register", "203.0.113.9")));
  const allowed = decisions.filter((d) => d.allowed);
  assert.equal(allowed.length, 5, "exactly the policy limit gets through a burst of 20");
  // The 15 refusals each carry the window's own Retry-After, read through the discriminated union so a
  // `{allowed:true}` decision cannot be asked for a field it does not have.
  const retryAfters = decisions.flatMap((d) => (d.allowed ? [] : [d.retryAfterSec]));
  assert.deepEqual(retryAfters, Array(15).fill(3600));
});

test("a per-tool Telegram bucket is independent of the analysis bucket it replaced", async () => {
  // `telegram:search` and `telegram:capture` exist so one user's browsing cannot spend their analysis
  // budget. That separation is only true if the buckets are separately anchored, which is what this
  // proves: exhaust search, and capture and analysis are still open; exhaust capture, and the numbers
  // still disagree.
  const limiter = new FixedWindowRateLimiter(new MemoryRateLimitStore(), () => 2_000);
  for (let i = 0; i < RATE_LIMIT_DEFAULTS["telegram:search"].limit; i++) {
    assert.equal((await limiter.hit("telegram:search", "tg:77")).allowed, true);
  }
  assert.deepEqual(await limiter.hit("telegram:search", "tg:77"), { allowed: false, retryAfterSec: 3600 });
  assert.deepEqual(await limiter.hit("telegram:capture", "tg:77"), { allowed: true });
  assert.deepEqual(await limiter.hit("telegram:analyze", "tg:77"), { allowed: true });
  // One identity, three budgets: the bucket text carries the key, so two tools never share a counter.
  for (let i = 1; i < RATE_LIMIT_DEFAULTS["telegram:capture"].limit; i++) await limiter.hit("telegram:capture", "tg:77");
  assert.deepEqual(await limiter.hit("telegram:capture", "tg:77"), { allowed: false, retryAfterSec: 3600 });
  assert.deepEqual(await limiter.hit("telegram:search", "tg:78"), { allowed: true }, "another identity is unaffected");
});

test("the window resets once, and only after the bucket's own window", async () => {
  let now = 10_000;
  const limiter = new FixedWindowRateLimiter(new MemoryRateLimitStore(), () => now);
  const cap = RATE_LIMIT_DEFAULTS["telegram:capture"].limit;
  for (let i = 0; i < cap; i++) await limiter.hit("telegram:capture", "tg:91");
  assert.equal((await limiter.hit("telegram:capture", "tg:91")).allowed, false);
  now += 3_599_000; // one second short of the hour
  assert.equal((await limiter.hit("telegram:capture", "tg:91")).allowed, false, "a window that resets early is no window at all");
  now += 2_000;
  assert.deepEqual(await limiter.hit("telegram:capture", "tg:91"), { allowed: true }, "and a fresh window starts counting from one");
});
