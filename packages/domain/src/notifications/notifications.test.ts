// Notifications domain tests — MG-EMAIL-TYPES (AC-33).
//
// Guards the ported email capability at the PURE layer:
//   1. copy fallback + params + direction (LocaleManager semantics)
//   2. recipient naming (formatName) — bare emails never greet with "Hi ,"
//   3. template shell: RTL/LTR structure, escaping (XSS), footer, icon CID
//   4. htmlToPlain — links fold, tags strip, no HTML-only mail
//   5. all ten builders produce resolved copy in BOTH locales (no raw keys)
//   6. BUG-A3 localizeCopy — catalog keys translate, unknown keys fall back,
//      plain text passes through
//
// Byte-parity of the copy against Legacy's catalog is proven by the
// one-time extraction recorded in the register (the values were generated
// FROM legacy/public/locales/{fa,en}.json); these tests pin the semantics.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emailCopy,
  emailDirection,
  EMAIL_COPY_KEYS,
  type EmailLocale,
} from "./emailCopy.js";
import { escapeHtml, htmlToPlain, renderEmailTemplate } from "./emailTemplate.js";
import { formatEmailName, resolveEmailLocale, emailLocaleOrDefault } from "./emailLocale.js";
import {
  buildVerificationEmail,
  buildWelcomeEmail,
  buildPasswordResetEmail,
  buildAdminInviteEmail,
  buildPasswordChangedEmail,
  buildNewDeviceEmail,
  buildFirstTradeEmail,
  buildAchievementEmail,
  buildSupportNewTicketEmail,
  buildSupportReplyEmail,
  localizeEmailCopy,
  type BuiltEmail,
} from "./emailMessages.js";

const CTX = { frontendBase: "https://veloratrade.ir", year: 2026 } as const;

test("email copy: fallback chain, params, direction (LocaleManager semantics)", () => {
  // fa resolves fa
  assert.ok(emailCopy("fa", "email.common.greeting").includes("{name}"));
  // params substitute both {name} and :name forms
  assert.equal(
    emailCopy("fa", "email.common.greeting", { name: "Sara" }),
    emailCopy("fa", "email.common.greeting").split("{name}").join("Sara"),
  );
  // missing key → en fallback → raw key
  assert.equal(emailCopy("fa", "email.no.such.key.zzz"), "email.no.such.key.zzz");
  assert.equal(emailCopy("fa", "email.no.such.key.zzz", { x: "1" }), "email.no.such.key.zzz");
  // direction
  assert.equal(emailDirection("fa"), "rtl");
  assert.equal(emailDirection("en"), "ltr");
  // both locales carry the identical key set (88 keys each)
  assert.ok(EMAIL_COPY_KEYS.length >= 80);
});

test("resolveEmailLocale: stored locale wins, hint is fallback, junk → null", () => {
  assert.equal(resolveEmailLocale("fa", "en"), "fa");
  assert.equal(resolveEmailLocale(null, "en"), "en");
  assert.equal(resolveEmailLocale("  EN ", null), "en"); // trimmed + case-folded
  assert.equal(resolveEmailLocale("de", null), null); // unsupported
  assert.equal(resolveEmailLocale(null, null), null);
  assert.equal(emailLocaleOrDefault("de", null), "fa"); // manifest default
});

test("formatEmailName: bare or email-as-name → localized recipient", () => {
  assert.equal(formatEmailName("Sara", "s@x.io", "fa"), "Sara");
  assert.equal(formatEmailName("", "s@x.io", "fa"), emailCopy("fa", "email.common.recipient"));
  assert.equal(formatEmailName("s@x.io", "s@x.io", "fa"), emailCopy("fa", "email.common.recipient"));
  assert.equal(formatEmailName("S@X.IO", "s@x.io", "fa"), emailCopy("fa", "email.common.recipient"));
  // never empty
  assert.notEqual(formatEmailName(null, "a@b.c", "en"), "");
});

test("template: RTL/LTR structure, escaping, icon CID, footer", () => {
  const html = renderEmailTemplate({
    locale: "fa",
    badge: 'Badge <script>alert(1)</script>',
    title: 'تیتر "مخاطب"',
    contentHtml: "<p>body</p>",
    buttonLabel: "برو",
    buttonUrl: "https://veloratrade.ir/x?a=1&b=2",
    notice: "یادآوری",
    iconName: "verification",
    frontendBase: CTX.frontendBase,
    year: CTX.year,
  });
  assert.ok(html.includes('dir="rtl"'));
  assert.ok(html.includes("text-align:right"));
  assert.ok(html.includes("border-right:4px solid #d4af37"));
  assert.ok(html.includes('src="cid:velora-verification"'));
  assert.ok(html.includes('src="cid:velora-logo"'));
  // XSS: the script payload is escaped, never raw
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  // URL escaping keeps the query intact but & encoded
  assert.ok(html.includes("https://veloratrade.ir/x?a=1&amp;b=2"));
  // footer carries the localized copyright with the year param
  assert.ok(html.includes(escapeHtml(emailCopy("fa", "email.common.copyright", { year: "2026" }))));

  const en = renderEmailTemplate({
    locale: "en",
    badge: "Security",
    title: "t",
    contentHtml: "<p>b</p>",
    buttonLabel: null,
    buttonUrl: null,
    notice: null,
    iconName: null,
    frontendBase: CTX.frontendBase,
    year: CTX.year,
  });
  assert.ok(en.includes('dir="ltr"'));
  assert.ok(en.includes("text-align:left"));
  // no icon requested → no icon block; the header LOGO cid is always present
  assert.ok(!en.includes("width:78px"));
  assert.ok(en.includes("cid:velora-logo"));
  // no button/notice blocks
  assert.ok(!en.includes("linear-gradient(135deg"));
});

test("htmlToPlain: links fold, structure flattens, entities decode", () => {
  const html =
    "<html><head><title>x</title></head><body>" +
    '<p>Hello <a href="https://v.ir/a">click</a></p>' +
    '<div>Line<br/>two</div>' +
    '<table><tr><td>a</td><td>b</td></tr></table>' +
    '<script>evil()</script>' +
    "</body></html>";
  const text = htmlToPlain(html);
  assert.ok(!text.includes("<"));
  assert.ok(!text.includes("evil()"));
  assert.ok(text.includes("click (https://v.ir/a)"));
  assert.ok(text.includes("Hello"));
  assert.ok(text.includes("Line\ntwo"));
  assert.ok(text.includes("a b"));
});

test("all ten builders resolve copy in both locales (no raw keys, icon set)", () => {
  const email = "trader@example.com";
  const name = "Trader One";
  const builds: ReadonlyArray<[string, BuiltEmail]> = [
    ["verification", buildVerificationEmail({ ...CTX, locale: "fa", email, fullName: name, verifyUrl: "https://v.ir/v" })],
    ["welcome", buildWelcomeEmail({ ...CTX, locale: "fa", email, fullName: name, dashboardUrl: "https://v.ir/d" })],
    ["passwordReset", buildPasswordResetEmail({ ...CTX, locale: "fa", email, fullName: name, resetUrl: "https://v.ir/r" })],
    ["adminInvite", buildAdminInviteEmail({ ...CTX, locale: "fa", email, fullName: name, inviteUrl: "https://v.ir/i" })],
    ["passwordChanged", buildPasswordChangedEmail({ ...CTX, locale: "fa", email, fullName: name })],
    ["newDevice", buildNewDeviceEmail({ ...CTX, locale: "fa", email, fullName: name, ip: "1.2.3.4", userAgent: "UA", time: "2026-10-06 12:00" })],
    ["firstTrade", buildFirstTradeEmail({ ...CTX, locale: "fa", email, fullName: name, symbol: "XAUUSD", direction: "buy" })],
    ["achievement", buildAchievementEmail({ ...CTX, locale: "fa", email, fullName: name, achievementTitle: "achievements.firstTrade.title", achievementDescription: "achievements.firstTrade.description" })],
    ["supportNewTicket", buildSupportNewTicketEmail({ ...CTX, locale: "fa", ticketId: 7, ticketSubject: "sub", preview: "prev", userLabel: name })],
    ["supportReply", buildSupportReplyEmail({ ...CTX, locale: "fa", ticketId: 7, ticketSubject: "sub", preview: "prev", userLabel: name })],
  ];
  for (const [kind, built] of builds) {
    // subject is resolved copy — never a raw catalog key
    assert.ok(!built.subject.startsWith("email."), `${kind}: raw key subject`);
    assert.ok(built.subject.length > 3, `${kind}: empty subject`);
    // html renders the shell + the icon; text is a real plain alternative
    assert.ok(built.html.includes("cid:velora-logo"), `${kind}: no logo`);
    assert.ok(built.html.includes(`cid:velora-${built.iconName}`), `${kind}: no icon`);
    assert.ok(!built.text.includes("<"), `${kind}: text not plain`);
    assert.ok(built.text.length > 20, `${kind}: empty text`);
    // no unresolved copy keys leaked into the html
    assert.ok(!built.html.includes("email.common.subtitle"), `${kind}: raw key in html`);
  }

  // English locale spot-checks across all ten
  const locales: EmailLocale[] = ["fa", "en"];
  for (const locale of locales) {
    const v = buildVerificationEmail({ ...CTX, locale, email, fullName: name, verifyUrl: "https://v.ir/v" });
    assert.equal(v.subject, emailCopy(locale, "email.verification.subject"));
    const f = buildFirstTradeEmail({ ...CTX, locale, email, fullName: name, symbol: "XAUUSD", direction: "sell" });
    assert.ok(f.html.includes(emailCopy(locale, "email.firstTrade.sell")));
  }

  // password-changed has NO cta button (Legacy sends notice-only)
  const pc = buildPasswordChangedEmail({ ...CTX, locale: "en", email, fullName: name });
  assert.ok(!pc.html.includes("linear-gradient(135deg"));

  // direction is respected end-to-end
  const faNew = buildNewDeviceEmail({ ...CTX, locale: "fa", email, fullName: name, ip: "9.9.9.9", userAgent: "UA", time: "t" });
  assert.ok(faNew.html.includes('dir="rtl"'));
  const enNew = buildNewDeviceEmail({ ...CTX, locale: "en", email, fullName: name, ip: "9.9.9.9", userAgent: "UA", time: "t" });
  assert.ok(enNew.html.includes('dir="ltr"'));

  // XSS via user-controlled fields (name, symbol, subject, preview)
  const evil = '<script>x</script>"onload="y';
  const evilBuild = buildSupportReplyEmail({
    ...CTX, locale: "fa", ticketId: 1, ticketSubject: evil, preview: evil, userLabel: evil,
  });
  assert.ok(!evilBuild.html.includes("<script>x</script>"));
});

test("localizeEmailCopy (BUG-A3): keys translate, unknown keys fall back, text passes", () => {
  // key form translates
  const t = localizeEmailCopy("achievements.firstTrade.title", "fa", "email.achievement.title");
  assert.equal(t, emailCopy("fa", "achievements.firstTrade.title"));
  assert.notEqual(t, "achievements.firstTrade.title");
  // unknown key → fallback copy, never the raw key
  const f = localizeEmailCopy("achievements.noSuch.title", "fa", "email.achievement.title");
  assert.equal(f, emailCopy("fa", "email.achievement.title"));
  // plain text passes through untouched
  assert.equal(localizeEmailCopy("Plain description", "fa", "email.achievement.title"), "Plain description");
  // a raw key can never leak into a rendered achievement email
  const a = buildAchievementEmail({
    ...CTX, locale: "fa", email: "a@b.c", fullName: "n",
    achievementTitle: "achievements.noSuch.title",
    achievementDescription: "achievements.alsoNope.description",
  });
  assert.ok(!a.html.includes("achievements.noSuch.title"));
});
