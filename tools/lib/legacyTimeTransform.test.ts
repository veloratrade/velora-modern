// Unit tests for the ADR-004 Amendment A-3 timestamp interpretation (Asia/Tehran standby).
// Pure: no database, no I/O, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretNaiveInstant, parseIsoNaive, KNOWN_TZ_OFFSET_MINUTES, ADR004_STANDBY_TIMEZONE } from "./legacyTimeTransform.ts";

test("KNOWN_TZ_OFFSET_MINUTES has Asia/Tehran = +210 (+03:30) and UTC = 0", () => {
  assert.strictEqual(KNOWN_TZ_OFFSET_MINUTES["Asia/Tehran"], 210);
  assert.strictEqual(KNOWN_TZ_OFFSET_MINUTES["UTC"], 0);
});

test("ADR004_STANDBY_TIMEZONE is Asia/Tehran", () => {
  assert.strictEqual(ADR004_STANDBY_TIMEZONE, "Asia/Tehran");
});

test("parseIsoNaive handles space and T separators, optional seconds", () => {
  assert.deepStrictEqual(parseIsoNaive("2026-09-04 09:00"), {
    year: 2026, month: 9, day: 4, hour: 9, minute: 0, second: 0,
  });
  assert.deepStrictEqual(parseIsoNaive("2026-09-04T09:00:30"), {
    year: 2026, month: 9, day: 4, hour: 9, minute: 0, second: 30,
  });
  assert.strictEqual(parseIsoNaive("1403/06/15 10:00"), null); // Jalali: unconfirmed calendar
  assert.strictEqual(parseIsoNaive("not-a-date"), null);
  assert.strictEqual(parseIsoNaive(""), null);
});

test("interpretNaiveInstant: ISO naive + Asia/Tehran -> UTC minus +03:30", () => {
  // 2026-09-04 09:00 Asia/Tehran (+03:30) = 2026-09-04T05:30:00.000Z
  const r = interpretNaiveInstant("2026-09-04 09:00", "Asia/Tehran");
  assert.ok(r !== null);
  assert.strictEqual(r!.occurredAtUtc, "2026-09-04T05:30:00.000Z");
  assert.strictEqual(r!.sourceTzOffset, "+03:30");
});

test("interpretNaiveInstant: ISO naive + UTC -> same instant", () => {
  const r = interpretNaiveInstant("2026-09-04 09:00", "UTC");
  assert.ok(r !== null);
  assert.strictEqual(r!.occurredAtUtc, "2026-09-04T09:00:00.000Z");
  assert.strictEqual(r!.sourceTzOffset, "+00:00");
});

test("interpretNaiveInstant: null timezone falls back to Asia/Tehran standby", () => {
  const withTz = interpretNaiveInstant("2026-09-04 09:00", "Asia/Tehran");
  const withoutTz = interpretNaiveInstant("2026-09-04 09:00", null);
  assert.deepStrictEqual(withoutTz, withTz);
});

test("interpretNaiveInstant: empty/null input -> null (never invent)", () => {
  assert.strictEqual(interpretNaiveInstant(null, "Asia/Tehran"), null);
  assert.strictEqual(interpretNaiveInstant("", "Asia/Tehran"), null);
  assert.strictEqual(interpretNaiveInstant("   ", "Asia/Tehran"), null);
});

test("interpretNaiveInstant: Jalali/unconfirmed calendar -> null (quarantine, never invent)", () => {
  assert.strictEqual(interpretNaiveInstant("1403/06/15 10:00", "Asia/Tehran"), null);
  assert.strictEqual(interpretNaiveInstant("1403/06/15 10:00", null), null);
});

test("interpretNaiveInstant: owner-gated unknown zone -> null (quarantine)", () => {
  assert.strictEqual(interpretNaiveInstant("2026-09-04 09:00", "America/New_York"), null);
});

test("interpretNaiveInstant: out-of-range values -> null", () => {
  assert.strictEqual(interpretNaiveInstant("2026-13-04 09:00", "Asia/Tehran"), null); // month 13
  assert.strictEqual(interpretNaiveInstant("2026-09-04 25:00", "Asia/Tehran"), null); // hour 25
});
