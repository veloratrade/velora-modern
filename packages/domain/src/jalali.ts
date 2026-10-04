// Jalali (Solar Hijri) calendar conversion — the port of legacy
// api/src/Trades/JalaliCalendar.php (Phase 3; READ-ONLY source-read
// 2026-10-04, MG-DOMAIN-LEGACY-ONLY / audit §9.3).
//
// CONTRACT (identical to legacy):
//   DISPLAY/HELPER ONLY. This module never participates in canonical-time
//   resolution — it converts ALREADY-established date components to a display
//   calendar, or provides calendar primitives. Canonical-time work lives
//   elsewhere (legacy: TradeTimeNormalizer; modern: ADR-004 time policy).
//
// PURE: no DB, no globals, no Date object, no timezone data — it operates on
// integer date components only, so it is timezone-independent BY CONSTRUCTION
// (legacy test J8 asserted this against PHP's default timezone; here there is
// no default timezone to read, which is the stronger form of the same proof).
//
// ALGORITHM PROVENANCE:
//   - gregorianToJalali: legacy JalaliCalendar::gregorianToJalali, verbatim
//     (proleptic Gregorian, day-count basis shared with the reverse function
//     so the pair round-trips).
//   - jalaliToGregorian + isJalaliLeap: legacy delegated these to
//     TradeTimeNormalizer (the single algorithm owner — "no duplicate math");
//     both are ported verbatim from there into this single owner on the
//     modern side.
//   - The 33-year intercalation cycle — leap years are (jy mod 33) ∈
//     {1,5,9,13,17,22,26,30} — matches legacy.
//
// STABILITY WINDOW (empirical, verified by executing the ACTUAL legacy PHP
// algorithms on 2026-10-04 — READ-ONLY verification): the legacy header
// claims round-trip stability for "1925..2124 (jy 1304..1503)"; that claim is
// INACCURATE. The measured truth:
//   - gregorian-first (the primary display direction): EVERY day of
//     2000..2100 round-trips; 1901..1999 and 2101..2160 drift by 1-30 days
//     (e.g. 1925-01-01 → 1303/10/11 → 1924-12-31).
//   - jalali-first: jy 1379..1478 round-trips EXCEPT the Esfand-30 day of
//     each in-window leap year (9 years: 1382, 1407, 1411, 1415, 1440, 1444,
//     1448, 1473, 1477), which lands one day into the next year's Nowruz.
// This port preserves the legacy behavior VERBATIM — parity over correction:
// altering the algorithm would change legacy display output, which is an
// owner decision recorded in the gap register (MG-DOMAIN-LEGACY-ONLY), not
// one made here. jalali.test.ts pins both the clean-window edges and the
// out-of-window drift vectors so any future change is loud.
//
// DIVERGENCE (cosmetic, documented): legacy returns [jy, jm, jd] arrays;
// modern returns named fields — same values, type-checked access.

/** Integer division truncating toward zero — PHP intdiv semantics. */
function intdiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

export interface JalaliDate {
  jy: number;
  jm: number; // 1..12
  jd: number; // 1..31 (1..30 in months 7..12; 1..29/30 in Esfand)
}

export interface GregorianDate {
  gy: number;
  gm: number; // 1..12
  gd: number; // 1..31
}

/** Proleptic Gregorian leap rule (legacy JalaliCalendar::isGregorianLeap). */
export function isGregorianLeap(gy: number): boolean {
  return (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
}

/** 33-year cycle: leap years are (jy mod 33) ∈ {1,5,9,13,17,22,26,30} (legacy TradeTimeNormalizer::isJalaliLeap). */
export function isJalaliLeap(jy: number): boolean {
  const r = (((jy - 474) % 33) + 33) % 33;
  return r === 1 || r === 5 || r === 9 || r === 13 || r === 17 || r === 22 || r === 26 || r === 30;
}

/** Gregorian (proleptic) → Jalali. Ported verbatim from legacy JalaliCalendar. */
export function gregorianToJalali(gy: number, gm: number, gd: number): JalaliDate {
  const gDaysInMonth = [31, isGregorianLeap(gy) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  const gy2 = gy - 1600;
  const gm2 = gm - 1;
  const gd2 = gd - 1;

  let gDayNo = 365 * gy2 + intdiv(gy2 + 3, 4) - intdiv(gy2 + 99, 100) + intdiv(gy2 + 399, 400);
  for (let i = 0; i < gm2; i++) {
    gDayNo += gDaysInMonth[i]!;
  }
  gDayNo += gd2;

  // Jalali epoch 0979/01/01 corresponds to gDayNo of 79 (1600/01/1 frame).
  let jDayNo = gDayNo - 79;

  const jNp = intdiv(jDayNo, 12053);
  jDayNo %= 12053;

  let jy = 979 + 33 * jNp + 4 * intdiv(jDayNo, 1461);
  jDayNo %= 1461;

  if (jDayNo >= 366) {
    jy += intdiv(jDayNo - 1, 365);
    jDayNo = (jDayNo - 1) % 365;
  }

  // jDayNo is now the 0-based day of the Jalali year.
  let jm: number;
  let jd: number;
  if (jDayNo < 186) {
    jm = 1 + intdiv(jDayNo, 31);
    jd = 1 + (jDayNo % 31);
  } else {
    const rest = jDayNo - 186;
    jm = 7 + intdiv(rest, 30);
    jd = 1 + (rest % 30);
  }

  return { jy, jm, jd };
}

/** Jalali → Gregorian. Ported verbatim from legacy TradeTimeNormalizer::jalaliToGregorian (the single algorithm owner). */
export function jalaliToGregorian(jy: number, jm: number, jd: number): GregorianDate {
  const y = jy + 1595;
  let days =
    -355668 +
    365 * y +
    intdiv(y, 33) * 8 +
    intdiv((y % 33) + 3, 4) +
    jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);

  let gy = 400 * intdiv(days, 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * intdiv(days - 1, 36524);
    days = (days - 1) % 36524;
  }
  gy += 4 * intdiv(days, 1461);
  days %= 1461;
  if (days > 365) {
    gy += intdiv(days - 1, 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const salA = [31, isGregorianLeap(gy) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  for (const dim of salA) {
    gm++;
    if (gd <= dim) {
      break;
    }
    gd -= dim;
  }
  return { gy, gm, gd };
}

/** Format Gregorian components as a Jalali YYYY/MM/DD display string (legacy sprintf '%04d%s%02d%s%02d'). */
export function formatJalaliDate(gy: number, gm: number, gd: number, separator = "/"): string {
  const { jy, jm, jd } = gregorianToJalali(gy, gm, gd);
  return `${String(jy).padStart(4, "0")}${separator}${String(jm).padStart(2, "0")}${separator}${String(jd).padStart(2, "0")}`;
}
