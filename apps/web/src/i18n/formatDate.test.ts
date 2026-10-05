/*
 * Date-formatting guard — the crash that took /trades down.
 *
 * `fmtDateLong` defaulted to `dateStyle: "long"` and merged caller options on
 * top. Intl forbids `dateStyle` together with explicit components, so the first
 * component formatter (`{ year, month, day, hour, minute }`) threw
 * `TypeError: Invalid option : option` INSIDE a React render — the error
 * boundary replaced the whole trade journal with "This page couldn't load".
 * Nothing caught it: tsc cannot see it, the build passed, and the page's other
 * tests were source scans. These assertions are the missing executable check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtDateLong } from "./format.js";

const ISO = "2026-09-28T09:00:00.000Z";

test("component options are accepted (no dateStyle clash)", () => {
  const out = fmtDateLong("fa", ISO, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  assert.notEqual(out, "—");
  assert.ok(out.length > 0);
  const ltr = fmtDateLong("en", ISO, { year: "numeric", month: "2-digit", day: "2-digit" });
  assert.match(ltr, /2026/);
});

test("the phase-1 behaviour is unchanged: no options → long date, Jalali for fa", () => {
  const fa = fmtDateLong("fa", ISO);
  const en = fmtDateLong("en", ISO);
  assert.match(en, /2026/);
  assert.notEqual(fa, en, "fa must not fall back to the Gregorian English string");
  assert.equal(fmtDateLong("fa", "not a date"), "—");
});

test("explicit dateStyle/timeStyle are still honoured", () => {
  assert.match(fmtDateLong("en", ISO, { dateStyle: "short" }), /2026/);
  const withTime = fmtDateLong("en", ISO, { dateStyle: "medium", timeStyle: "short" });
  assert.match(withTime, /2026/);
});

test("digits stay Latin in both locales (product rule)", () => {
  const fa = fmtDateLong("fa", ISO, { year: "numeric", month: "2-digit", day: "2-digit" });
  assert.ok(!/[۰-۹٠-٩]/.test(fa), `Persian digits leaked: ${fa}`);
});
