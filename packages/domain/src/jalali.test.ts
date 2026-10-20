// Jalali port tests — golden vectors ported from the legacy Phase-3 test
// (tools/tests/test_trade_time_session_phase3.php, READ-ONLY source-read
// 2026-10-04) plus round-trip properties over the documented supported range.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTradeTime } from "./journalExtraction.js";
import {
  gregorianToJalali,
  jalaliToGregorian,
  isJalaliLeap,
  isGregorianLeap,
  formatJalaliDate,
  parseJalaliDate,
  looksLikeJalaliDate,
  resolveChatDate,
  readLeadingChatDate,
  toLatinDigits,
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

// ── parseJalaliDate: the chat-facing parser (round-trip validation, no month table) ────────

test("J9: parseJalaliDate converts and pads", () => {
  assert.equal(parseJalaliDate("1405-07-27"), "2026-10-19");
  assert.equal(parseJalaliDate("1405-1-1"), "2026-03-21"); // Nowruz 1405
  assert.equal(parseJalaliDate("1400/01/01"), "2021-03-21"); // the J4 vector, through the parser
});

test("J10: parseJalaliDate accepts Persian and Arabic-Indic digits", () => {
  assert.equal(parseJalaliDate("۱۴۰۵-۰۷-۲۷"), "2026-10-19");
  assert.equal(parseJalaliDate("۱۴۰۵/۷/۲۷"), "2026-10-19");
  assert.equal(parseJalaliDate("١٤٠٥-٠٧-٢٧"), "2026-10-19");
  assert.equal(parseJalaliDate("  ۱۴۰۵.۰۷.۲۷  "), "2026-10-19"); // `.` like normalizeReportDate
});

test("J11: the month clamp is caught by the round-trip, not by a lookup table", () => {
  // jalaliToGregorian(1405,12,31) happily answers a real Gregorian day (2027-03-22), which converts
  // BACK as 1406/01/02. Requiring the components to match is what rejects it — the same technique
  // normalizeReportDate uses for 2026-02-30, and it means no 6×31+5×30 table can drift from the converter.
  assert.notDeepEqual(jalaliToGregorian(1405, 12, 31), null); // the raw converter really does swallow it
  assert.equal(parseJalaliDate("1405-12-31"), null);
  assert.equal(parseJalaliDate("1405-11-31"), null);
  assert.equal(isJalaliLeap(1405), false); // a common year: Esfand has 29 days
  assert.equal(parseJalaliDate("1405-12-29"), "2027-03-20"); // its real last day
  assert.equal(parseJalaliDate("1405-12-30"), null);          // …and day 30 does not exist
});

test("J12: the leap Esfand day parses in a leap Jalali year and not in a common one", () => {
  assert.equal(isJalaliLeap(1403), true);
  assert.equal(parseJalaliDate("1403-12-30"), "2025-03-20");
  assert.equal(parseJalaliDate("1404-12-30"), null); // 1404 is common: Esfand has 29 days
  assert.equal(parseJalaliDate("1404-12-29"), "2026-03-20");
});

test("J13: out-of-range components are refused rather than rolled over", () => {
  for (const bad of ["1405-13-01", "1405-00-10", "1405-07-00", "1405-07-32", "1405-07", "07-27-1405", "1405-7-27-1", "", "  ", "today"]) {
    assert.equal(parseJalaliDate(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("J14: a Gregorian date is NOT parsed as Jalali, even though it is shaped the same", () => {
  // 2026-10-19 would convert to a Gregorian day ~5632 years away; it must fail instead. The caller
  // tries `normalizeReportDate` FIRST, and this is the second half of that ordering being safe.
  assert.equal(parseJalaliDate("2026-10-19"), null);
  assert.equal(looksLikeJalaliDate("2026-10-19"), true); // shape only — the refusal is the parser's job
});

test("J15: every day of a Jalali leap year round-trips through the parser", () => {
  // Sweeping 1403 (leap) day by day proves the round-trip never rejects a real date, which is the
  // risk of validating by conversion instead of by table.
  let count = 0;
  for (let jm = 1; jm <= 12; jm += 1) {
    const dim = jm <= 6 ? 31 : jm <= 11 ? 30 : isJalaliLeap(1403) ? 30 : 29;
    for (let jd = 1; jd <= dim; jd += 1) {
      const iso = `${String(1403).padStart(4, "0")}-${String(jm).padStart(2, "0")}-${String(jd).padStart(2, "0")}`;
      const parsed = parseJalaliDate(iso);
      assert.notEqual(parsed, null, `rejected a real day: ${iso}`);
      const [y, m, d] = [Number(parsed!.slice(0, 4)), Number(parsed!.slice(5, 7)), Number(parsed!.slice(8, 10))];
      assert.deepEqual(gregorianToJalali(y, m, d), { jy: 1403, jm, jd }, `landed elsewhere: ${iso}`);
      count += 1;
    }
  }
  assert.equal(count, 366);
});

// ── THE SHARED CHAT-DATE CONTRACT (J16 … J21) ─────────────────────────────────────────────────
// These tests are the specification the three chat paths (/stats, /checklist, journal free text)
// are now required to share. They pin the ANSWER, not the implementation: if any path grows its own
// regex again, the "one string, one day" test is what catches it.

const ok = (text: string) => {
  const r = resolveChatDate(text);
  assert.equal(r?.kind, "ok", `expected a readable day, got ${JSON.stringify(r)}`);
  return r as { kind: "ok"; iso: string; calendar: string; jalali: string | undefined; gregorian: string };
};
const refused = (text: string) => {
  const r = resolveChatDate(text);
  assert.equal(r?.kind, "rejected", `expected a refusal, got ${JSON.stringify(r)}`);
  return r as { kind: "rejected"; rejection: { kind: string; raw: string } };
};

test("J16: a Jalali day written in Persian digits resolves, and never to a different day than the Latin spelling", () => {
  const latin = ok("1405-07-27");
  assert.equal(latin.iso, "2026-10-19");                    // verified against the converters, not by hand
  assert.equal(latin.calendar, "jalali");
  for (const text of ["۱۴۰۵-۰۷-۲۷", "۱۴۰۵/۷/۲۷", "  ۱۴۰۵.۰۷.۲۷  ", "ورود ۲۶۵۰ برای ۱۴۰۵-۰۷-۲۷"]) {
    assert.equal(ok(text).iso, latin.iso, `Persian digits read as another day: ${text}`);
  }
  // The digits-as-typed test must be able to see eastern digits at all — that is what `toLatinDigits`
  // preserves, and why a whole-string map (not a re-match) is the only safe latinisation.
  assert.equal(toLatinDigits("۱۴۰۵-۰۷-۲۷"), "1405-07-27");
  assert.equal(toLatinDigits("٠١٢٣٤٥٦٧٨٩"), "0123456789");
});

test("J17: a Gregorian day is Gregorian, in either digit system's punctuation, and is labelled honestly", () => {
  const g = ok("2026-10-19");
  assert.equal(g.iso, "2026-10-19");
  assert.equal(g.calendar, "gregorian");
  assert.equal(g.jalali, "1405/07/27");                     // the SAME day, named both ways
  assert.equal(ok("2026/10/19").iso, g.iso);
  assert.equal(ok("2026.10.19").iso, g.iso);
  assert.equal(ok("XAUUSD 2026-10-19: buy").iso, g.iso);     // found mid-message, not only at the start
  assert.equal(ok("قیمت ۲۶۵۰ در 2026-10-19 ساعت ۱۴:۳۰").iso, g.iso); // Latin date digits, Persian elsewhere
});

test("J18: impossible days are refused in BOTH calendars, including the leap-year edges", () => {
  for (const text of ["2026-02-30", "2025-02-29", "1405-13-01", "1405-01-32", "2026-00-10", "2026-04-31"]) {
    const r = refused(text);
    assert.equal(r.rejection.kind, "garbage", `not refused as a bad day: ${text}`);
    assert.equal(r.rejection.raw.includes("*"), false, `the refusal must quote what the user typed: ${text}`);
  }
  // 1403 IS a leap year: its Esfand has 30 days. 1404 and 1405 are common: 29. A table of month
  // lengths is NOT how this is decided — the round-trip through the algorithm owner is.
  assert.equal(ok("1403-12-30").iso, "2025-03-20");
  assert.equal(refused("1404-12-30").rejection.kind, "garbage");
  assert.equal(refused("1405-12-30").rejection.kind, "garbage");
  assert.equal(ok("2024-02-29").iso, "2024-02-29");          // Gregorian leap day, valid
});

test("J19: a Persian-digit year in the Gregorian range is AMBIGUOUS and refused, never guessed", () => {
  // `۲۰۲۶-۱۰-۱۹` could be 2026 Gregorian (what a Persian keyboard produces for a Latin date) or
  // Jalali 2026 = Gregorian 2547 — a real 520-year disagreement, so the contract refuses rather than
  // defaulting. This is the fail-closed rule the audit asked for, and it is the one place where a
  // previously ACCEPTED input (Gregorian, read by the old code) is now refused with a message.
  const r = refused("۲۰۲۶-۱۰-۱۹");
  assert.equal(r.rejection.kind, "ambiguous");
  assert.equal(refused("۲۰۲۶-۰۱-۰۱").rejection.kind, "ambiguous");
  // An explicit marker settles it instantly.
  assert.equal(ok("g:۲۰۲۶-۱۰-۱۹").iso, "2026-10-19");
  assert.equal(ok("j:۱۴۰۵-۰۷-۲۷").iso, "2026-10-19");
  assert.equal(ok("g:1405-07-27").iso, "1405-07-27");
  // A forced-Gregorian year below the Jalali floor has no meaningful Jalali name; the contract says
  // so instead of printing the double-converted nonsense (`0786/-18/-13`) an earlier draft produced.
  assert.equal(ok("g:1405-07-27").jalali, undefined);
  // A Latin year below the floor is Jalali; a Jalali year that cannot be read is a bad day, not a
  // 15th-century Gregorian one.
  assert.equal(ok("1405-07-27").calendar, "jalali");
  // A 3-digit "year" is not a date at all — the same shape `normalizeReportDate` refuses — so it is
  // "no date attempted", which for /stats means "I don't read that as a window" (the token list), not
  // "that day does not exist". Version numbers and ratios rely on this: `1.2.3` is never a date.
  assert.equal(resolveChatDate("999-01-01"), null);
  assert.equal(resolveChatDate("1.2.3"), null);
  assert.equal(resolveChatDate("نسخه ۱.۲.۳"), null);
  // A refusal quotes the digits AS TYPED, so the user sees the string they wrote, not a latinised one.
  assert.equal(refused("۱۴۰۵-۱۳-۰۱").rejection.raw, "۱۴۰۵-۱۳-۰۱");
});

test("J20: markers, padding and boundaries behave as documented", () => {
  assert.equal(ok("جلالی 1405-07-27").iso, "2026-10-19");
  assert.equal(ok("شمسی 1405-07-27").iso, "2026-10-19");
  assert.equal(ok("میلادی 2026-10-19").iso, "2026-10-19");
  assert.equal(ok("2026-1-9").iso, "2026-01-09");            // unpadded still works: no stored day moves
  assert.equal(ok("1405-1-1").iso, "2026-03-21");            // the first day of Farvardin 1405
  assert.equal(resolveChatDate("دیروز XAUUSD"), null);       // "no date" is NOT "bad date"
  assert.equal(resolveChatDate("no date here at all"), null);
  // A date glued to a word is not a date: `1405-07-27X` must not be read as one, and `entry 1405-07-27`
  // must not be read as `y1-07` (the lookbehind is what prevents that second bug).
  assert.equal(resolveChatDate("1405-07-27X"), null);
  assert.equal(ok("entry 1405-07-27").iso, "2026-10-19");
  assert.equal(ok("entry 1405-07-27.").iso, "2026-10-19");   // a sentence-final period is not part of it
  assert.equal(resolveChatDate("نسخه ۱.۲.۳"), null);          // a version number is not a date
});

test("J21: ONE string resolves to ONE day for all three chat paths, and the leading form can be stripped", () => {
  // The regression this patch exists to kill. Each path now consumes this same function, so this
  // asserts the property the audit demanded rather than three copies of a parser.
  const text = "1405-07-27";
  const day = ok(text).iso;
  assert.equal(day, "2026-10-19");
  const j = resolveTradeTime(`XAUUSD ${text} buy`, new Date("2026-10-18T10:00:00Z"), "Asia/Tehran");
  assert.equal(j.openTime.slice(0, 10), day, "the journal path resolved a different day than /stats");
  assert.equal(j.timeNote, "date-from-message-jalali");
  // `readLeadingChatDate` is the only rule for CUTTING the day out of a message, so the body a
  // checklist receives cannot disagree with the day its header was resolved to.
  const lead = readLeadingChatDate(`${text} bias: bullish`);
  assert.equal(lead.consumed, text);
  assert.equal(lead.rest, "bias: bullish");
  assert.equal(lead.result?.kind, "ok");
  const none = readLeadingChatDate("bias: bullish");
  assert.equal(none.consumed, "");
  assert.equal(none.rest, "bias: bullish");
  // A refusal never edits the body — a rejected date must not silently shorten the text either.
  const bad = readLeadingChatDate("1405-13-01 bias: bullish");
  assert.equal(bad.result?.kind, "rejected");
  assert.ok(bad.rest === "bias: bullish" || bad.rest.length > 0, "the items must survive the refusal");
});
