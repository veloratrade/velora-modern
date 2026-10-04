// The sync-window rule — one producer-independent definition (TRD-06).
//
// Before this existed the worker's tick asked for 12 months on a first-ever
// sync while the webhook ingress asked for 24 hours, for the same account and
// the same idempotency key shape. Neither was wrong on its own; together they
// meant "how much history do we import" depended on which trigger fired.
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncWindow, SYNC_INITIAL_LOOKBACK_MS } from "./metaapiSync.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");

test("a durable cursor is the window start", () => {
  const w = syncWindow("2026-09-28T00:00:00.000Z", NOW);
  assert.deepEqual(w, { from: "2026-09-28T00:00:00.000Z", to: "2026-10-04T12:00:00.000Z" });
});

test("no cursor falls back to the 12-month lookback bound (Legacy months<=12)", () => {
  const w = syncWindow(null, NOW);
  assert.ok(w !== null, "a first-ever sync must produce a window");
  assert.equal(w.to, NOW.toISOString());
  assert.equal(Date.parse(w.from), NOW.getTime() - SYNC_INITIAL_LOOKBACK_MS);
  assert.equal(SYNC_INITIAL_LOOKBACK_MS, 365 * 24 * 60 * 60 * 1000);
});

test("a non-ISO cursor is normalized, not echoed to the provider", () => {
  const w = syncWindow("2026-09-28T00:00:00Z", NOW);
  assert.equal(w?.from, "2026-09-28T00:00:00.000Z");
});

test("an unparseable cursor is treated as absent, never forwarded", () => {
  const w = syncWindow("not-a-timestamp", NOW);
  assert.ok(w !== null, "an unparseable cursor must still produce the lookback window");
  assert.equal(Date.parse(w.from), NOW.getTime() - SYNC_INITIAL_LOOKBACK_MS);
});

test("a cursor at or past now yields NO window (never an inverted one)", () => {
  assert.equal(syncWindow(NOW.toISOString(), NOW), null);
  assert.equal(syncWindow("2026-10-05T00:00:00.000Z", NOW), null);
});

test("the window is always half-open and forward in time", () => {
  const w = syncWindow("2026-10-04T11:59:59.999Z", NOW);
  assert.ok(w !== null && w.from < w.to);
  assert.equal(w.to, NOW.toISOString());
});
