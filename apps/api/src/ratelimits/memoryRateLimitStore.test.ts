// Memory rate-limit store semantics — PHP Core/RateLimiter.php parity (inc 7):
// window anchored at the first hit, preserved on increment, reset strictly
// after the bucket's own window, per-bucket isolation, 48h stale sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRateLimitStore } from "./memoryRateLimitStore.js";

test("first hit starts a window anchored at now; increments preserve windowStart", async () => {
  const store = new MemoryRateLimitStore();
  const first = await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 10_000);
  assert.deepEqual(first, { hits: 1, windowStartMs: 10_000 });
  const second = await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 11_000);
  assert.deepEqual(second, { hits: 2, windowStartMs: 10_000 });
  const third = await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 12_500);
  assert.deepEqual(third, { hits: 3, windowStartMs: 10_000 });
});

test("window expires strictly after windowSec (edge: exactly at the edge keeps the window)", async () => {
  const store = new MemoryRateLimitStore();
  await store.hit("auth:register|1.2.3.4", { windowSec: 3600 }, 0);
  // PHP: DELETE … WHERE window_start < now − windowSec → strictly older expires
  const atEdge = await store.hit("auth:register|1.2.3.4", { windowSec: 3600 }, 3_600_000);
  assert.deepEqual(atEdge, { hits: 2, windowStartMs: 0 }); // still the same window
  const pastEdge = await store.hit("auth:register|1.2.3.4", { windowSec: 3600 }, 3_600_001);
  assert.deepEqual(pastEdge, { hits: 1, windowStartMs: 3_600_001 }); // fresh window
});

test("buckets are isolated by key (route + IP)", async () => {
  const store = new MemoryRateLimitStore();
  await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 0);
  await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 1);
  const otherIp = await store.hit("auth:login|5.6.7.8", { windowSec: 300 }, 2);
  assert.deepEqual(otherIp, { hits: 1, windowStartMs: 2 });
  const otherRoute = await store.hit("auth:register|1.2.3.4", { windowSec: 3600 }, 3);
  assert.deepEqual(otherRoute, { hits: 1, windowStartMs: 3 });
});

test("a bucket with a longer policy is not shortened by another bucket's window (PHP comment parity)", async () => {
  // PHP: "Expire this bucket using its own window. A global cleanup based on
  // the caller's window would incorrectly shorten buckets that use a longer
  // policy (for example, registration's one-hour window)."
  const store = new MemoryRateLimitStore();
  await store.hit("auth:register|1.2.3.4", { windowSec: 3600 }, 0);
  // a login bucket (300s) on the same IP expires its own window…
  await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 400_000);
  await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 900_000); // reset (fresh login window)
  // …but the register bucket's one-hour window is untouched
  const stillRegisterWindow = await store.hit("auth:register|1.2.3.4", { windowSec: 3600 }, 900_000);
  assert.deepEqual(stillRegisterWindow, { hits: 2, windowStartMs: 0 });
});

test("48h stale sweep removes ancient buckets (storage hygiene, PHP parity)", async () => {
  const store = new MemoryRateLimitStore();
  await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 0);
  // a hit 49h later sweeps the ancient login bucket and starts a fresh window
  const fresh = await store.hit("auth:login|5.6.7.8", { windowSec: 300 }, 176_400_000);
  assert.deepEqual(fresh, { hits: 1, windowStartMs: 176_400_000 });
  const afterSweep = await store.hit("auth:login|1.2.3.4", { windowSec: 300 }, 176_400_001);
  assert.deepEqual(afterSweep, { hits: 1, windowStartMs: 176_400_001 }); // swept → fresh, not hits=2
});
