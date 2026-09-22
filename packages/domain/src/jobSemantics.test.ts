import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffMs, shouldDeadLetter, leaseNeedsRenewal, isLeaseExpired } from "./jobSemantics.js";

const policy = { maxAttempts: 5, backoffBaseMs: 1000, backoffMaxMs: 60000 };

test("full jitter: delay is within [0, cap) and deterministic under injected rng", () => {
  assert.equal(computeBackoffMs(1, policy, () => 0), 0);
  assert.equal(computeBackoffMs(1, policy, () => 0.999), 999); // cap=1000
  assert.equal(computeBackoffMs(2, policy, () => 0.5), 1000); // cap=2000 → 1000
  assert.equal(computeBackoffMs(10, policy, () => 0.999), 59940); // capped at 60000
});

test("backoff grows exponentially until the cap", () => {
  const caps = [1, 2, 3, 4, 5].map((a) => computeBackoffMs(a, policy, () => 1));
  assert.deepEqual(caps, [1000, 2000, 4000, 8000, 16000]);
  assert.equal(computeBackoffMs(7, policy, () => 1), 60000); // 2^6*1000=64000 → cap 60000
});

test("DLQ boundary: attempts >= maxAttempts dead-letters", () => {
  assert.equal(shouldDeadLetter(4, policy), false);
  assert.equal(shouldDeadLetter(5, policy), true);
});

test("lease renewal at 50% elapsed; expiry at deadline", () => {
  assert.equal(leaseNeedsRenewal(149, 300), false);
  assert.equal(leaseNeedsRenewal(150, 300), true);
  assert.equal(isLeaseExpired(299, 300), false);
  assert.equal(isLeaseExpired(300, 300), true);
});
