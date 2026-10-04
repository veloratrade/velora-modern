// TradingSessionEngine port tests — golden vectors ported from the legacy
// Phase-3 test (tools/tests/test_trade_time_session_phase3.php, READ-ONLY
// source-read 2026-10-04), S1..S21. The configured windows here are explicit
// fixtures to exercise the engine, NOT shipped product defaults (legacy rule:
// the engine never invents windows).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TradingSessionEngine,
  parseSessionWindow,
  isValidIanaTimezone,
  TRADING_SESSION_ENGINE_VERSION,
} from "./tradingSession.js";

const LONDON_NY_WINDOWS = [
  { id: "london", label: "London", timezone: "Europe/London", start: "08:00", end: "16:30", daysOfWeek: [1, 2, 3, 4, 5] },
  { id: "newyork", label: "New York", timezone: "America/New_York", start: "08:00", end: "17:00", daysOfWeek: [1, 2, 3, 4, 5] },
] as const;

const ids = (r: { sessions: Array<{ id: string }> }): string[] => r.sessions.map((s) => s.id);

test("S1/S6: unconfigured engine has no windows; version constant exposed", () => {
  const empty = new TradingSessionEngine();
  assert.equal(empty.hasConfiguredWindows(), false);
  assert.equal(empty.engineVersion(), TRADING_SESSION_ENGINE_VERSION);
  assert.equal(TRADING_SESSION_ENGINE_VERSION, 1);
});

test("S2/S3: unconfigured engine returns 'unconfigured' but still derives hourUtc/dayOfWeekUtc", () => {
  const r = new TradingSessionEngine().classify("2026-08-31 13:00:00");
  assert.equal(r.status, "unconfigured");
  assert.deepEqual(r.sessions, []);
  assert.equal(r.hourUtc, 13);
  assert.equal(r.dayOfWeekUtc, 1); // Monday (ISO)
});

test("S4: null canonical -> 'unresolved'", () => {
  assert.equal(new TradingSessionEngine().classify(null).status, "unresolved");
  assert.equal(new TradingSessionEngine().classify("   ").status, "unresolved");
});

test("S5: invalid canonical -> 'invalid'", () => {
  assert.equal(new TradingSessionEngine().classify("not-a-date").status, "invalid");
  assert.equal(new TradingSessionEngine().classify("2026-08-31 12:00").status, "invalid"); // non-canonical shape
});

test("S7: configured engine counts its windows", () => {
  const engine = new TradingSessionEngine(LONDON_NY_WINDOWS);
  assert.equal(engine.hasConfiguredWindows(), true);
  assert.equal(engine.windowCount(), 2);
});

test("S8: overlap — 12:00Z Monday opens both london+newyork (BST/EDT)", () => {
  const r = new TradingSessionEngine(LONDON_NY_WINDOWS).classify("2026-08-31 12:00:00");
  assert.equal(r.status, "open");
  assert.deepEqual(ids(r), ["london", "newyork"]);
  assert.equal(r.hourUtc, 12);
  assert.equal(r.dayOfWeekUtc, 1);
});

test("S9/S10: London open boundary is inclusive at 07:00Z (08:00 BST), closed at 06:59Z", () => {
  const engine = new TradingSessionEngine(LONDON_NY_WINDOWS);
  assert.ok(ids(engine.classify("2026-08-31 07:00:00")).includes("london"));
  assert.ok(!ids(engine.classify("2026-08-31 06:59:00")).includes("london"));
});

test("S11/S12: DST WINTER — London 08:00 GMT = 08:00Z (not 07:00Z)", () => {
  const engine = new TradingSessionEngine(LONDON_NY_WINDOWS);
  assert.ok(ids(engine.classify("2026-01-05 08:15:00")).includes("london")); // Monday, GMT
  assert.ok(!ids(engine.classify("2026-01-05 07:59:00")).includes("london")); // would match if the offset were fixed
});

test("S13: DST WINTER — New York 08:00 EST = 13:00Z", () => {
  const r = new TradingSessionEngine(LONDON_NY_WINDOWS).classify("2026-01-05 13:15:00");
  assert.ok(ids(r).includes("newyork"));
});

test("S14: Sunday outside weekday-filtered windows", () => {
  const r = new TradingSessionEngine(LONDON_NY_WINDOWS).classify("2026-08-30 12:00:00"); // Sunday
  assert.equal(r.status, "outside");
  assert.deepEqual(r.sessions, []);
});

test("S15: Monday 03:00Z outside both (London 04:00 BST, NY 23:00 prev day)", () => {
  const r = new TradingSessionEngine(LONDON_NY_WINDOWS).classify("2026-08-31 03:00:00");
  assert.equal(r.status, "outside");
  assert.deepEqual(r.sessions, []);
});

test("S16/S17: cross-midnight window NY 22:00->02:00 local", () => {
  const cross = new TradingSessionEngine([
    { id: "late", label: "Late", timezone: "America/New_York", start: "22:00", end: "02:00" },
  ]);
  // 03:00Z = NY 23:00 (still inside; window started 22:00 local Sunday).
  assert.ok(ids(cross.classify("2026-08-31 03:00:00")).includes("late"));
  // 07:30Z = NY 03:30 — after the 02:00 close, outside.
  assert.ok(!ids(cross.classify("2026-08-31 07:30:00")).includes("late"));
});

test("cross-midnight early-hours: an instant after local midnight belongs to yesterday's window", () => {
  const cross = new TradingSessionEngine([
    { id: "late", label: "Late", timezone: "America/New_York", start: "22:00", end: "02:00" },
  ]);
  // 05:30Z = NY 01:30 — inside the window that started yesterday 22:00 local.
  assert.ok(ids(cross.classify("2026-08-31 05:30:00")).includes("late"));
  // 06:30Z = NY 02:30 — after close.
  assert.ok(!ids(cross.classify("2026-08-31 06:30:00")).includes("late"));
});

test("half-open [start, end): the end boundary itself is outside", () => {
  const engine = new TradingSessionEngine(LONDON_NY_WINDOWS);
  // London closes 16:30 local BST = 15:30Z; at exactly 15:30Z it is closed.
  assert.ok(ids(engine.classify("2026-08-31 15:29:00")).includes("london"));
  assert.ok(!ids(engine.classify("2026-08-31 15:30:00")).includes("london"));
});

test("S18: window with EST abbreviation timezone rejected (not IANA)", () => {
  assert.throws(
    () => parseSessionWindow({ id: "x", label: "X", timezone: "EST", start: "08:00", end: "16:00" }),
    /IANA/,
  );
  assert.equal(isValidIanaTimezone("EST"), false);
  assert.equal(isValidIanaTimezone("GMT+3"), false);
  assert.equal(isValidIanaTimezone("Europe/London"), true);
  assert.equal(isValidIanaTimezone("Asia/Tehran"), true);
});

test("S19: out-of-range time rejected", () => {
  assert.throws(
    () => parseSessionWindow({ id: "x", timezone: "Europe/London", start: "25:00", end: "16:00" }),
    /HH:MM/,
  );
});

test("S20: start == end rejected", () => {
  assert.throws(
    () => parseSessionWindow({ id: "x", label: "X", timezone: "Europe/London", startMinute: 480, endMinute: 480 }),
    /must differ/,
  );
});

test("window validation: id/label/daysOfWeek rules (legacy constructor)", () => {
  assert.throws(() => parseSessionWindow({ id: "", timezone: "Europe/London", start: "08:00", end: "16:00" }), /id/);
  assert.throws(
    () => parseSessionWindow({ id: "x", label: "y".repeat(61), timezone: "Europe/London", start: "08:00", end: "16:00" }),
    /label/,
  );
  assert.throws(
    () => parseSessionWindow({ id: "x", timezone: "Europe/London", start: "08:00", end: "16:00", daysOfWeek: [0, 8] }),
    /weekdays/,
  );
  // Valid minimal window: label defaults to id; daysOfWeek null = every day.
  const w = parseSessionWindow({ id: "tokyo", timezone: "Asia/Tokyo", start: "09:00", end: "15:00" });
  assert.equal(w.label, "tokyo");
  assert.equal(w.daysOfWeek, null);
  assert.equal(w.startMinute, 540);
});

test("S21 (structural): classification is independent of the runtime environment", () => {
  // Legacy had to re-set PHP's default timezone four times to prove this.
  // Here every timezone and the formatter locale are explicit in the engine,
  // so there is no default to read — pinned by construction and asserted by
  // repeatability on both sides of the classification.
  const engine = new TradingSessionEngine(LONDON_NY_WINDOWS);
  const a = engine.classify("2026-08-31 12:00:00");
  const b = engine.classify("2026-08-31 12:00:00");
  assert.deepEqual(a, b);
  assert.equal(a.status, "open");
});
