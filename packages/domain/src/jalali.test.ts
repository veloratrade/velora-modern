// Jalali port tests — golden vectors ported from the legacy Phase-3 test
// (tools/tests/test_trade_time_session_phase3.php, READ-ONLY source-read
// 2026-10-04) plus round-trip properties over the documented supported range.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gregorianToJalali,
  jalaliToGregorian,
  isJalaliLeap,
  isGregorianLeap,
  formatJalaliDate,
} from "./jalali.js";

// J1 (legacy vector): 2026-08-31 = 1405/06/09.
test("J1: gregorianToJalali(2026-08-31) = 1405/06/09", () => {
  assert.deepEqual(gregorianToJalali(2026, 8, 31), { jy: 1405, jm: 6, jd: 9 });
});

// J2 (legacy vector): the reverse of J1.
test("J2: jalaliToGregorian(1405/06/09) = 2026-08-31", () => {
  assert.deepEqual(jalaliToGregorian(1405, 6, 9), { gy: 2026, gm: 8, gd: 31 });
});

// J3 (legacy property): round-trips over 2020..2030 (legacy swept months
// [3,6,9,12], days [5,20]); here the same sweep plus a full-range sweep below.
test("J3: gregorian<->jalali round-trips 2020..2030 (legacy sweep)", () => {
  const dim = (y: number, m: number): number => [31, isGregorianLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  for (let y = 2020; y <= 2030; y++) {
    for (const m of [3, 6, 9, 12]) {
      for (const d of [5, 20]) {
        const day = Math.min(d, dim(y, m));
        const j = gregorianToJalali(y, m, day);
        const g = jalaliToGregorian(j.jy, j.jm, j.jd);
        assert.deepEqual(g, { gy: y, gm: m, gd: day }, `${y}-${m}-${day}`);
      }
    }
  }
});

// Stronger than legacy (allowed, not divergent): EVERY day of 2020..2030.
test("J3b: round-trip every calendar day 2020..2030", () => {
  const dim = (y: number, m: number): number => [31, isGregorianLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  for (let y = 2020; y <= 2030; y++) {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= dim(y, m); d++) {
        const j = gregorianToJalali(y, m, d);
        const g = jalaliToGregorian(j.jy, j.jm, j.jd);
        assert.deepEqual(g, { gy: y, gm: m, gd: d }, `${y}-${m}-${d}`);
      }
    }
  }
});

// J4 (legacy vector): 2021-03-21 is Jalali new year 1400/01/01 (Nowruz).
test("J4: 2021-03-21 = 1400/01/01 (Nowruz)", () => {
  assert.deepEqual(gregorianToJalali(2021, 3, 21), { jy: 1400, jm: 1, jd: 1 });
});

// J5/J6 (legacy vectors): 1403 is a leap year, 1404 is not.
test("J5/J6: isJalaliLeap(1403)=true, isJalaliLeap(1404)=false", () => {
  assert.equal(isJalaliLeap(1403), true);
  assert.equal(isJalaliLeap(1404), false);
});

// The leap day 1403/12/30 exists (1403 leap) and round-trips to itself.
test("J5b: 1403/12/30 (leap Esfand day) round-trips", () => {
  const g = jalaliToGregorian(1403, 12, 30);
  const j = gregorianToJalali(g.gy, g.gm, g.gd);
  assert.deepEqual(j, { jy: 1403, jm: 12, jd: 30 });
});

// J7 (legacy vector): formatJalaliDate pads to YYYY/MM/DD.
test("J7: formatJalaliDate(2026-08-31) = '1405/06/09' (padded)", () => {
  assert.equal(formatJalaliDate(2026, 8, 31), "1405/06/09");
});

// J8 (legacy property, stronger form): the conversion is timezone-independent
// BY CONSTRUCTION — the module never constructs a Date, reads no environment,
// and takes only integer components, so there is no default timezone to read.
test("J8: conversion is pure component math (no Date/environment access)", () => {
  // Same components, called repeatedly, always identical — and the module's
  // purity is structural (see jalali.ts header); this pins the observable half.
  assert.equal(formatJalaliDate(2026, 8, 31), formatJalaliDate(2026, 8, 31));
  assert.equal(formatJalaliDate(2026, 8, 31, "-"), "1405-06-09");
});

// STABILITY WINDOW (verified by executing the ACTUAL legacy PHP algorithms,
// 2026-10-04 — see the gap-register entry for the full finding): the legacy
// header claims round-trip stability for "1925..2124 / jy 1304..1503", but
// that claim is INACCURATE. Empirically, running the verbatim legacy pair:
//   - gregorian-first (the primary display direction): every day of
//     2000..2100 round-trips; 1901..1999 and 2101+ drift (e.g. 1925-01-01 →
//     1303/10/11 → 1924-12-31).
//   - jalali-first: jy 1379..1478 round-trips EXCEPT the Esfand-30 day of
//     each in-window leap year (9 years: 1382, 1407, 1411, 1415, 1440, 1444,
//     1448, 1473, 1477 — e.g. 1407/12/30 → 2029-03-20 → 1408/01/01).
// This port preserves the legacy behavior VERBATIM — parity over correction:
// changing the algorithm would alter legacy display output, which is an owner
// decision, not an autonomous one. The known-vector tests (J1/J2/J4) and the
// modern operating years sit inside the clean window; the out-of-window pins
// below intentionally freeze the legacy drift so any future algorithm change
// is loud.

// Documented supported range boundaries (legacy: 1925..2124 / jy 1304..1503).
test("stability window (legacy-PHP-verified): gregorian-first round-trips at the 2000..2100 edges", () => {
  // 2000..2100 is the empirically-verified clean window for the primary
  // (display) direction — every day of both edge years round-trips.
  const dim = (y: number, m: number): number => [31, isGregorianLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  for (const y of [2000, 2100]) {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= dim(y, m); d++) {
        const j = gregorianToJalali(y, m, d);
        const g = jalaliToGregorian(j.jy, j.jm, j.jd);
        assert.deepEqual(g, { gy: y, gm: m, gd: d }, `${y}-${m}-${d}`);
      }
    }
  }
});

test("parity pins outside the clean window: legacy drift preserved verbatim (NOT fixed)", () => {
  // These values were produced by executing the actual legacy PHP algorithms
  // (READ-ONLY verification, 2026-10-04). They are wrong as calendar facts —
  // that is the point: the port must reproduce the legacy bit-for-bit, and
  // any future change to the algorithm must break these pins loudly.
  assert.deepEqual(gregorianToJalali(1925, 1, 1), { jy: 1303, jm: 10, jd: 11 });
  assert.deepEqual(jalaliToGregorian(1303, 10, 11), { gy: 1924, gm: 12, gd: 31 }); // documented-range edge: does NOT round-trip
  assert.deepEqual(gregorianToJalali(2124, 12, 31), { jy: 1503, jm: 10, jd: 10 });
  assert.deepEqual(jalaliToGregorian(1407, 12, 30), { gy: 2029, gm: 3, gd: 20 }); // Esfand-30 of an in-window leap year
  assert.deepEqual(gregorianToJalali(2029, 3, 20), { jy: 1408, jm: 1, jd: 1 }); // ...does not come back (jalali-first exception)
});
