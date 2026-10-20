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

// ── Parsing a Jalali date a human typed ─────────────────────────────────────
//
// WHY THIS EXISTS SEPARATELY FROM `normalizeReportDate`.
//   `normalizeReportDate` (journalChecklist.ts) is the checklist's accepted-date rule and the
//   `/checklist` error copy is written around it. It is deliberately NOT widened here: a chat
//   command that reads a stats window can accept a Persian calendar date without changing what a
//   stored review date may be. The two leniency rules stay independent and both are small.
//
// VALIDATION IS A ROUND-TRIP, NOT A LOOKUP TABLE.
//   `jalaliToGregorian` is component arithmetic ported from the legacy normalizer (the single
//   algorithm owner) and it happily swallows 1405/12/31 — the month clamp turns it into the last
//   day of Esfand. Converting the result BACK and requiring the components to match is what rejects
//   it, and it is the same technique `normalizeReportDate` uses for 2026-02-30. No month-length
//   table is duplicated here, so the 6×31 + 5×30 + 29/30 rule cannot drift from the converter.
//
// DIGITS. Persian (۰-۹) and Arabic-Indic (٠-٩) are accepted because a `fa` keyboard produces them;
// an out-of-range month/day is a REFUSAL (`null`), never a rollover into a neighbouring month.

const EASTERN_DIGITS = /[۰-۹٠-٩]/;

/** True when the string contains Persian (۰-۹) or Arabic-Indic (٠-٩) digits — one test for that, here. */
export function hasEasternDigits(text: string): boolean {
  return EASTERN_DIGITS.test(text);
}
const DIGIT_MAP: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/** `۱۴۰۵/۰۷/۲۷`, `1405-7-27`, `1405/07/27` → `YYYY-MM-DD` Gregorian. Impossible dates answer null. */
export function parseJalaliDate(input: string): string | null {
  let t = input.trim();
  if (EASTERN_DIGITS.test(t)) t = [...t].map((ch) => DIGIT_MAP[ch] ?? ch).join("");
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m === null) return null;
  const jy = Number(m[1]), jm = Number(m[2]), jd = Number(m[3]);
  if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  if (!Number.isInteger(jy) || jy < 1 || jy > 9999) return null;
  const g = jalaliToGregorian(jy, jm, jd);
  if (g.gm < 1 || g.gm > 12 || g.gd < 1 || g.gd > 31) return null;
  const back = gregorianToJalali(g.gy, g.gm, g.gd);
  if (back.jy !== jy || back.jm !== jm || back.jd !== jd) return null; // e.g. 1405/12/31
  return `${String(g.gy).padStart(4, "0")}-${String(g.gm).padStart(2, "0")}-${String(g.gd).padStart(2, "0")}`;
}

/** Is this string shaped like a Jalali request at all? Used to pick the right refusal copy. */
export function looksLikeJalaliDate(input: string): boolean {
  const t = input.trim();
  const candidate = EASTERN_DIGITS.test(t) ? [...t].map((ch) => DIGIT_MAP[ch] ?? ch).join("") : t;
  return /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(candidate);
}

// ── The one chat date contract ──────────────────────────────────────────────
//
// WHY THIS EXISTS, AND WHY THERE IS ONLY ONE OF IT.
//   Three chat surfaces accept a date — `/stats <window>`, `/checklist <date> <text>`, and the date
//   inside a free-text journal message. They used to parse it three different ways, which is how a
//   Persian-calendar day became three different answers: `/stats 1405-07-27` meant 2026-10-19,
//   `/checklist 1405-07-27` meant 1405-07-27 (a real Gregorian date in the 15th century, stored as
//   such), and the journal text meant the same 15th-century day. Same words, different day, no error.
//   Everything below is therefore the ONLY grammar for a typed date; each surface calls it.
//
// THE RULE, IN ORDER:
//   1. `j:` / `م:` forces Jalali, `g:` / `میلادی` forces Gregorian. Explicit beats inference.
//   2. Latin digits, year >= GREGORIAN_YEAR_FLOOR (1700)  -> Gregorian, validated by round-trip.
//   3. Persian/Arabic-Indic digits, year >= 1700            -> AMBIGUOUS (it could be today, in
//      Persian digits, or a Jalali year five centuries ahead — the two readings differ by 520 years).
//   4. year in [1000, 1700) (any digits), valid as Jalali   -> Jalali.
//   5. year in [1000, 1700), NOT a valid Jalali day          -> GARBAGE ("that day does not exist").
//      A year below 1000 in Latin digits is AMBIGUOUS.
// In every AMBIGUOUS case the answer is a refusal that offers the prefix, never a defaulted guess.
//   6. Anything that parses as neither calendar              -> garbage: REJECTED.
//      Rule 6 is a deliberate behaviour change for free text: an unreadable date used to be dropped
//      silently and the trade landed on today. A wrong day is far more expensive than a refused one,
//      so an unreadable date is now reported (timeNote `date-invalid`) and the user is told.
//
// WHAT IT NEVER DOES: rewrite stored dates. `report_date` is a DATE column keyed by
// UNIQUE (user_id, report_date) and `occurred_close_at_utc` is TIMESTAMPTZ — the rule only changes
// how a typed string is read. Every input the OLD parsers accepted still resolves to the SAME day
// (asserted in the tests); the only newly-accepted inputs are Jalali and Persian digits, and the
// only newly-rejected ones are dates that were already broken.

/** Below this, a Latin-digit year is treated as Jalali. See rule 2/4 above. */
export const GREGORIAN_YEAR_FLOOR = 1700;

export type ChatDateSource = "gregorian" | "jalali";

export interface ChatDate {
  /** The day, as `YYYY-MM-DD` Gregorian — the only form the stores take. */
  readonly iso: string;
  readonly calendar: ChatDateSource;
  /** What to show the user, in the calendar they used to ask. `undefined` only when the resolved
   * Gregorian year is outside the Jalali algorithm's usable range (an explicit `g:` before 1700 CE):
   * no label beats a fabricated one. */
  readonly jalali: string | undefined;
  readonly gregorian: string;
}

export type ChatDateRejection =
  /** A date-shaped string that neither calendar can read (rule 6). */
  | { readonly kind: "garbage"; readonly raw: string }
  /** A pre-1700 Latin-digit year that is not a valid Jalali day (rule 5). */
  | { readonly kind: "ambiguous"; readonly raw: string };

/** A date the contract could read. `iso` is the only value a store may be written with. */
export type ChatDateOk = { readonly kind: "ok" } & ChatDate;

export type ChatDateResult =
  | ChatDateOk
  | { readonly kind: "rejected"; readonly rejection: ChatDateRejection };

const EASTERN = /[۰-۹٠-٩]/;
const TO_LATIN: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII. Whole-string, order preserving. */
export function toLatinDigits(text: string): string {
  if (!EASTERN.test(text)) return text;
  return [...text].map((ch) => TO_LATIN[ch] ?? ch).join("");
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/**
 * Find and read the first date token in a message. `null` means "no date was attempted" — which is
 * NOT the same as a rejected one, because a journal message with no date simply means today.
 */
export function resolveChatDate(text: string): ChatDateResult | null {
  const raw = text.trim();
  // TWO mutually exclusive patterns rather than one with an optional prefix, because an optional
  // group matches EMPTY at position 0 and would silently shift every capture index.
  //   RE_MARKED — a calendar marker must be at the start; mid-text `ج:` is prose, not a marker.
  //   RE_PLAIN  — a bare date may appear anywhere (a journal message opens with the symbol).
  // The marker alternatives are LENGTH-PRESERVING between `raw` and its latinised copy (`جلالی`,
  // `شمسی`, `میلادی` carry no digits and Latin users write `j:`/`g:`), so `toLatinDigits` changes
  // only digit characters and every index below is valid in BOTH strings. A Latin word such as
  // `gregorian` would break that invariant, which is why it is not offered as a marker.
  // WHERE A DATE MAY END. A date glued to a word, another digit, a hyphen-run or a decimal is not a
  // date — it is a price (`1405-07-27.50`), a longer number (`1405-07-27-05`) or a typo
  // (`1405-07-27X`) — so the next character may not be `[0-9A-Za-z_.-]`. Two lookaheads, deliberately
  // NOT one alternation: inside `(?!A|B)` a match of EITHER branch rejects the date, so a single
  // `(?![…]|[.])` would refuse every date at end of input, and `(?![0-9A-Za-z_.-])` would refuse
  // `entry 1405-07-27.`, a form the code accepted BEFORE this patch (J20 pins the difference). Hence:
  // a `.` is only disqualifying when a DIGIT follows it.
  //
  // What is deliberately NOT here: Arabic LETTERS. An earlier draft listed `\u0600-\u06FF` in the
  // "may not follow" set, and that range also contains U+060C `،` and U+061B `؛` — the two ways a
  // Persian sentence closes a date. `…۲۰۲۶-۱۰-۱۹، ورود 2650` then read as "no date"; because "no date"
  // means TODAY in a journal message, the cost of that false negative was a trade journalled on the
  // wrong day. A false positive is a refusal the user can see; a silent wrong day is not.
  const NOT_AFTER = String.raw`(?![0-9A-Za-z_\-])(?!\.[0-9])`;
  const RE_MARKED = new RegExp(String.raw`^(j|g|جلالی|شمسی|میلادی)\s*[:=]?\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})` + NOT_AFTER, "u");
  const RE_PLAIN = new RegExp(String.raw`(?<![\p{L}\p{N}_])(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})` + NOT_AFTER, "u");
  const latin = toLatinDigits(raw);
  const marked = RE_MARKED.exec(latin);
  const scan: RegExpExecArray | null = marked ?? RE_PLAIN.exec(latin);
  if (scan === null) return null;
  const base = marked === null ? 1 : 2;          // year group, fixed by WHICH pattern matched
  const gYear = scan[base]!, gMonth = scan[base + 1]!, gDay = scan[base + 2]!;
  const marker = (marked === null ? "" : scan[1]!.toLowerCase());
  const forced: ChatDateSource | null =
    marker === "j" || marker === "جلالی" || marker === "شمسی" ? "jalali"
      : marker === "g" || marker === "میلادی" ? "gregorian"
        : null;
  // The date is the LAST `NNNN-NN-NN` characters of the match in both strings, and counting back
  // from the end is what makes this immune to the one asymmetry left: a MARKER can be longer in one
  // string than the other (`g:` is 2 characters, `ج:` is 3, and `میلادی`/`جلالی` are 6), while the
  // digits themselves are always one-for-one. Measuring from the front once returned an empty "raw"
  // in a refusal, which then quoted the user's own date back to them as nothing at all.
  const dateLength = gYear.length + gMonth.length + gDay.length + 2;
  const spanEnd = (scan.index ?? 0) + scan[0]!.length;
  const typed = raw.slice(spanEnd - dateLength, spanEnd);
  const latinDate = scan[0]!.slice(-dateLength);
  // Eastern digits in the DATE (not merely somewhere in the message) is what makes a 4-digit year
  // ambiguous rather than Jalali, so this test is deliberately on the date span alone.
  const digitsAreEastern = typed !== latinDate;
  // A refusal quotes the digits AS TYPED: rewriting `۱۴۰۵-۱۳-۰۱` into `1405-13-01` would have the user
  // hunting for a date they never wrote.
  const rawDigits = typed;
  const year = Number(gYear), month = Number(gMonth), day = Number(gDay);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return { kind: "rejected", rejection: { kind: "garbage", raw: rawDigits } };
  }

  const gregorianIso = (): string | null => {
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  };
  const jalaliIso = (): string | null => parseJalaliDate(`${pad(year, 4)}-${pad(month)}-${pad(day)}`);
  // The display label is always derived FROM THE RESOLVED GREGORIAN DAY, never from the typed
  // components: feeding `gregorianToJalali` a year that is already Jalali converts twice (an earlier
  // draft printed year 786 for `g:1405-07-27`). One conversion, one direction.
  const ok = (iso: string, calendar: ChatDateSource): ChatDateResult => {
    const gy = Number(iso.slice(0, 4));
    // `gregorianToJalali` is an arithmetic port with no representation floor: a year such as 1405 CE
    // (reachable only through an explicit `g:`) returns a meaningless triple, and a label built from
    // it once printed `0786/-18/-13`. No Jalali label is far better than a false one.
    const jalali = gy < GREGORIAN_YEAR_FLOOR || gy > 9998
      ? undefined
      : (() => { const j = gregorianToJalali(gy, Number(iso.slice(5, 7)), Number(iso.slice(8, 10)));
        return `${pad(j.jy, 4)}/${pad(j.jm)}/${pad(j.jd)}`; })();
    return { kind: "ok", iso, calendar, jalali, gregorian: iso };
  };
  const garbage = (): ChatDateResult => ({ kind: "rejected", rejection: { kind: "garbage", raw: rawDigits } });
  const ambiguous = (): ChatDateResult => ({ kind: "rejected", rejection: { kind: "ambiguous", raw: rawDigits } });

  if (forced === "gregorian") {
    const iso = gregorianIso();
    return iso === null ? garbage() : ok(iso, "gregorian");
  }
  if (forced === "jalali") {
    if (year < 1000 || year >= GREGORIAN_YEAR_FLOOR) return garbage(); // outside the usable Jalali range
    const iso = jalaliIso();
    if (iso === null) return garbage();
    return ok(iso, "jalali");
  }
  if (year >= GREGORIAN_YEAR_FLOOR && !digitsAreEastern) {
    const iso = gregorianIso();                                // rule 2
    return iso === null ? garbage() : ok(iso, "gregorian");
  }
  if (year >= GREGORIAN_YEAR_FLOOR && digitsAreEastern) {
    return ambiguous();                                        // rule 3
  }
  if (year >= 1000) {
    const iso = jalaliIso();                                   // rules 4 and 5
    if (iso !== null) return ok(iso, "jalali");
    return garbage();
  }
  return ambiguous();
}

/**
 * Read a date a user LEAD a message with, and say what is left of the message once it is removed.
 *
 * This is the only place that knows how wide the date token is, so it is the only place that may cut
 * it out of the body. A caller that re-implemented the cut (a fixed slice length, a second regex) is
 * how three paths drifted apart in the first place — hence the helper rather than three copies.
 * `rest` is the message with the leading date token removed; when no date is present the WHOLE text
 * comes back untouched, including in the rejected case, so a refusal never silently edits the body.
 */
export function readLeadingChatDate(text: string): {
  readonly result: ChatDateResult | null;
  readonly consumed: string;
  readonly rest: string;
} {
  const raw = text.trim();
  const result = resolveChatDate(raw);
  if (result === null) return { result: null, consumed: "", rest: text };
  // Locate the same 4-2/2-2 digits in the ORIGINAL, anchored at the latinised match's end, and let
  // the date END (not its latinised length) decide how much is consumed — the trailing-boundary rule
  // in `resolveChatDate` is what `rest` must respect, or the two halves of this helper would
  // disagree about where the date stopped.
  const latin = toLatinDigits(raw);
  const hit = RE_PLAIN_END.exec(latin);
  if (hit === null) return { result, consumed: "", rest: text };
  const consumedThrough = hit.index + hit[0].length;
  return { result, consumed: raw.slice(0, consumedThrough), rest: raw.slice(consumedThrough).trim() };
}

/** The leading-date token itself, measured where a date can legally end. */
const RE_PLAIN_END = /^(?:\s*(?:j|g|جلالی|شمسی|میلادی)\s*[:=]?\s*)?\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?![0-9A-Za-z_\-])(?!\.[0-9])/;

/** Convenience for callers that only want the stored form. `null` = no date present. */
export function chatDateIso(text: string): string | null {
  const r = resolveChatDate(text);
  return r?.kind === "ok" ? r.iso : null;
}
