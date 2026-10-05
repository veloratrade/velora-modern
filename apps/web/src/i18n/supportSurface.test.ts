/*
 * Support-surface guards — Phase 5 (the support center).
 *
 * WHY THIS FILE EXISTS. The support page is the first screen whose copy was
 * ALREADY in Legacy's catalogs (Legacy shipped the v1.8 ticket UI), so the risk
 * is not invented wording but SILENT DRIFT in three directions:
 *
 *   1. KEYS THAT FALL BACK. Every key the page passes to `t(...)` is extracted
 *      from the page SOURCE and driven through the real translator in both
 *      locales; a key without a catalog entry fails here instead of silently
 *      rendering English inside the Persian UI.
 *   2. COPY THAT STOPS BEING LEGACY'S. The five strings a user actually acts on
 *      (the four status names and the subscribe button) are asserted VERBATIM
 *      against `veloratrade/veloratrade @edede31 public/locales/{fa,en}.json`.
 *   3. CAPABILITY THAT QUIETLY DISAPPEARS FROM THE SCREEN. Legacy's screen had
 *      three KPIs, a split open/closed list, a thread with a reopen button, a
 *      reply box HIDDEN while closed, and a `?ticket=` deep link. Each of those
 *      is asserted against the source, because deleting one leaves a page that
 *      still renders.
 *
 * It also pins the two contract details that are easy to "fix" back into a bug:
 * the wire field is `message` (Legacy's name), and the client never sends
 * `status`/`waiting_for` — the server derives both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTranslator, messagesFor } from "./catalog.js";
import type { Locale } from "../contracts/locale.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..");
const PAGE = join(WEB, "src", "app", "(app)", "support", "page.tsx");
const RESOURCES = join(WEB, "src", "lib", "api", "resources.ts");

const FEATURES = ["common", "errors", "support"] as const;
const LOCALES: readonly Locale[] = ["fa", "en"];

const CORRUPTION = ["\uFFFD", "Ã", "Â", "Ø", "Ù", "ð", "\\u", "&amp;"];
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

/** Same shape-based scan the trades guard uses, so neither style can hide a key. */
function literalKeys(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) out.add(m[1]!);
  for (const m of src.matchAll(/"([a-z][A-Za-z0-9]*\.[A-Za-z0-9._#-]+)"/g)) out.add(m[1]!);
  return [...out];
}

/** Comments stripped: an explanation of a removed control must not satisfy a scan. */
function code(): string {
  return readFileSync(PAGE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
}

const t = (locale: Locale) => createTranslator(locale, [...FEATURES]);

test("the support page renders a real key set (guard against an empty scan)", () => {
  const keys = literalKeys(code());
  assert.ok(keys.length >= 20, `expected the support page to use a real key set, found ${keys.length}`);
  for (const must of [
    "pages.support.label.support_center",
    "pages.support.title.new_ticket",
    "pages.support.label.subject",
    "pages.support.label.message",
    "pages.support.action.submit_ticket",
    "pages.support.action.send_reply",
    "pages.support.action.reopen_ticket",
    "pages.support.badge.unread",
    "pages.support.empty.no_open",
    "pages.support.empty.no_closed",
    "pages.support.err.load_failed",
    "pages.support.toast.ticket_created",
    "support.pageSub",
  ]) {
    assert.ok(keys.includes(must), `${must} is no longer rendered by the support page`);
  }
});

test("every key the support page renders resolves to its own string in BOTH locales", () => {
  const keys = literalKeys(code());
  for (const locale of LOCALES) {
    const tr = t(locale);
    const catalog = messagesFor(locale, [...FEATURES]);
    for (const key of keys) {
      const value = tr(key, null, "\u0000MISSING\u0000");
      assert.ok(!value.includes("MISSING"), `${locale}: ${key} is missing from the catalog`);
      assert.ok(key in catalog, `${locale}: ${key} is not in the loaded catalog`);
      assert.notEqual(catalog[key]!.trim(), "", `${locale}: ${key} is empty`);
      for (const bad of CORRUPTION) {
        assert.ok(!value.includes(bad), `${locale}: ${key} rendered ${JSON.stringify(bad)}`);
      }
    }
  }
});

test("the status and copy shown to a user are Legacy's own words, byte-for-byte", () => {
  const fa = messagesFor("fa", [...FEATURES]);
  const en = messagesFor("en", [...FEATURES]);
  // Legacy `public/locales/{fa,en}.json` @edede31 (v1.8 support UI).
  assert.equal(fa["pages.support.status.open"], "باز");
  assert.equal(en["pages.support.status.open"], "Open");
  assert.equal(fa["pages.support.status.awaiting_your_reply"], "در انتظار پاسخ شما");
  assert.equal(en["pages.support.status.awaiting_your_reply"], "Awaiting your reply");
  assert.equal(fa["pages.support.status.awaiting_support"], "در انتظار پشتیبانی");
  assert.equal(en["pages.support.status.awaiting_support"], "Awaiting support");
  assert.equal(fa["pages.support.status.closed"], "بسته");
  assert.equal(en["pages.support.status.closed"], "Closed");
  assert.equal(fa["pages.support.status.archived"], "بایگانی");
  assert.equal(en["pages.support.status.archived"], "Archived");
  assert.equal(fa["pages.support.badge.unread"], "خوانده‌نشده");
  assert.equal(en["pages.support.badge.unread"], "Unread");
  assert.equal(fa["pages.support.action.submit_ticket"], "ارسال تیکت");
  assert.equal(en["pages.support.action.submit_ticket"], "Submit ticket");
  assert.equal(fa["pages.support.action.reopen_ticket"], "بازگشایی تیکت");
  assert.equal(en["pages.support.action.reopen_ticket"], "Reopen ticket");
  assert.equal(fa["pages.support.empty.no_open"], "هنوز تیکت بازی ندارید. از دکمه «تیکت جدید» استفاده کنید.");
  assert.equal(en["pages.support.empty.no_open"], "You have no open tickets yet. Use “New ticket”.");
  // …and the authored keys are the ONLY ones that are not Legacy's: they carry
  // the `support.` prefix, so the two classes never mix.
  for (const key of literalKeys(code())) {
    const isLegacy = key.startsWith("pages.support.") || key.startsWith("errors.") || key.startsWith("common.");
    assert.ok(isLegacy || key.startsWith("support."), `${key} is neither Legacy copy nor an authored support.* key`);
  }
});

test("the API's error codes are the ones the page translates (no raw English leaks)", () => {
  const src = code();
  for (const code of [
    "SUPPORT_SUBJECT_INVALID",
    "SUPPORT_MESSAGE_INVALID",
    "SUPPORT_TICKET_CLOSED",
    "SUPPORT_INVALID_TRANSITION",
    "SUPPORT_INVALID_ACTION",
    "SUPPORT_STATE_CONFLICT",
    "SERVICE_UNAVAILABLE",
    "TOO_MANY_REQUESTS",
    "UNAUTHENTICATED",
  ]) {
    assert.ok(src.includes(code), `the page does not handle ${code}`);
  }
  // Those codes exist in the errors catalog in both locales — asserted on RENDERED values.
  for (const locale of LOCALES) {
    const tr = t(locale);
    for (const key of ["errors.support.subjectInvalid", "errors.support.messageInvalid", "errors.support.ticketClosed", "errors.support.invalidTransition", "errors.support.invalidAction"]) {
      assert.ok(!tr(key, null, "MISSING").includes("MISSING"), `${locale}: ${key} is missing`);
    }
    assert.ok(!tr("errors.rateLimited", null, "MISSING").includes("MISSING"), `${locale}: errors.rateLimited is missing`);
  }
});

test("the capability Legacy had is still on the screen: KPIs, split list, thread, reopen, hidden reply when closed", () => {
  const src = code();
  // three KPIs, driven by the API's own numbers, not by a hard-coded pair
  for (const bar of ["kpi-grid", "unreadTotal", "open.length", "closed.length"]) {
    assert.ok(src.includes(bar), `the KPI row no longer uses ${bar}`);
  }
  // the split list: open = open|pending, closed = closed|archived (Legacy's rule)
  assert.ok(src.includes('x.status === "open" || x.status === "pending"'), "the open filter changed");
  assert.ok(src.includes('x.status === "closed" || x.status === "archived"'), "the closed filter changed");
  // thread + deep link + reopen + reply visibility
  assert.ok(src.includes("?ticket=") === false, "the deep link is read with URLSearchParams, not string surgery");
  assert.ok(src.includes('new URLSearchParams(window.location.search).get("ticket")'), "the ?ticket= deep link was removed");
  assert.ok(src.includes("reopenSupportTicket("), "the reopen action was removed");
  assert.ok(src.includes("isClosed ? null : ("), "the reply box must be hidden while the ticket is closed");
  // the thread is opened with the READ route (which is what clears the badge)
  assert.ok(src.includes("getSupportTicket("), "opening a ticket no longer goes through the read route");
});

test("VISUAL: no inline styles (the production CSP blocks style attributes) and canonical KPI/date markup", () => {
  const src = code();
  // The build stays green with `style={{…}}`; the BROWSER does not apply it
  // (`style-src 'self' 'nonce-…'`), so the page would render degraded in
  // production while looking correct in every test. Zero is the product rule —
  // the Phase 1 polish established it for the account surface.
  assert.equal(src.includes("style={{"), false, "an inline style attribute was reintroduced — the CSP blocks it");
  // KPIs are blocks, like every other KPI row in the app …
  assert.ok(src.includes('className="kpi-label"'), "the KPI label must be a block element");
  assert.ok(src.includes('className="kpi-value v-latn-num'), "the KPI value must be a block element");
  // … and a FORMATTED date must carry neither `dir="ltr"` nor `.v-latn-num`:
  // both force an LTR embedding, which reorders the Jalali date and the clock
  // time around the comma (reproduced in the browser by character position in
  // the Phase 5 visual QA run; `.v-latn-num` was the phase-1 remedy for a RAW ISO
  // stamp, where the ordering hazard does not exist). Latin digits still come
  // from the formatter's own `toLatin` pass, so `.ts-mixed` is the right class.
  assert.equal(src.includes('dir="ltr"'), false, 'dir="ltr" on a localized date garbles the RTL reading order');
  // Every element that renders a formatted date: its className is read from the
  // lines just above `fmtDateLong`, so the check cannot drift onto a neighbour.
  const lines = src.split("\n");
  const dateClasses: string[] = [];
  lines.forEach((line, i) => {
    if (!line.includes("fmtDateLong")) return;
    for (let back = 0; back <= 3; back += 1) {
      const m = /className="([^"]*)"/.exec(lines[i - back] ?? "");
      if (m !== null) {
        dateClasses.push(m[1]!);
        return;
      }
    }
  });
  assert.ok(dateClasses.length >= 3, `expected the formatted timestamps, found ${dateClasses.length}`);
  for (const cls of dateClasses) {
    assert.ok(!cls.includes("v-latn-num"), `a formatted date carries .v-latn-num (${cls}) — its direction:ltr scrambles date+time in RTL`);
    assert.ok(cls.includes("ts-mixed"), `a formatted date must use .ts-mixed (${cls})`);
  }
});

test("the client sends Legacy's field name and NEVER the derived state", () => {
  const src = readFileSync(RESOURCES, "utf8");
  const support = src.slice(src.indexOf("// --- Support (Phase 5"));
  assert.ok(support.length > 0, "the support resource block was removed");
  assert.ok(support.includes("body: { message }"), "the reply must be sent as `message` (Legacy's field name)");
  assert.ok(support.includes("body: input") && support.includes("{ subject: string; message: string }"), "the create payload shape changed");
  // status / waiting_for are SERVER-derived: a client that sends them is claiming
  // state it does not own (the route ignores it, and a client that believes
  // otherwise renders the wrong badge). The scan looks at the REQUEST CALLS, not
  // the type declarations — `waitingFor: SupportWaiting` is a response type.
  const calls = [...support.matchAll(/api\.request\(([^;]*?)\);/gs)].map((m) => m[1]!);
  assert.ok(calls.length >= 5, `expected the support calls to be found, saw ${calls.length}`);
  for (const call of calls) {
    for (const forbidden of ["waiting_for", "waitingFor", "status"]) {
      assert.ok(!call.includes(forbidden), `a support request sends ${forbidden}: ${call.trim()}`);
    }
  }
  // ids are encoded into the path — an id is opaque, never interpolated raw
  assert.ok(support.includes("encodeURIComponent(id)"), "ticket ids must be URL-encoded");
});
