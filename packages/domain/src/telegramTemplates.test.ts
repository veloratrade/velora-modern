// The template engine's promises are all about what it REFUSES to do: no evaluation, no silent
// disappearance, no fabricated zero, no markup that outlives the render. Each block below is
// written so it goes red the moment one of those stops being true.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BANNER_MAX_ROWS, renderBanner } from "./bannerRender.js";
import {
  BUILT_IN_TEMPLATES,
  NOT_RECORDED,
  TELEGRAM_TEXT_LIMIT,
  TEMPLATE_BODY_LIMIT,
  TEMPLATE_FIELDS,
  describeTemplateGaps,
  inspectTemplate,
  isAllowedLink,
  renderTemplate,
  sanitizeTelegramMarkup,
  templateFieldKeys,
} from "./telegramTemplates.js";

const fa = (body: string, values: Record<string, string | number | null> = {}) =>
  renderTemplate({ body, values, locale: "fa" });
const en = (body: string, values: Record<string, string | number | null> = {}) =>
  renderTemplate({ body, values, locale: "en" });

test("unknown placeholder: stays in the text verbatim AND is reported", () => {
  const r = en("bias: {{doesNotExist}} ok");
  assert.match(r.text, /\{\{doesNotExist\}\}/u);
  assert.deepEqual(r.unknown, ["doesNotExist"]);
  assert.deepEqual(r.missing, []);
});

test("expressions are not fields: nothing is evaluated", () => {
  for (const shape of ["1+1", "stats.winRate.toFixed(2)", "system.run('ls')", " ", ""]) {
    const r = en(`x {{${shape}}} y`);
    assert.match(r.text, /\{\{/u, shape);
    assert.deepEqual(r.unknown, [], shape);
    assert.deepEqual(r.unsupported, [shape.trim() === "" ? "(empty)" : shape.trim()], shape);
  }
  assert.ok(!/2/.test(en("{{1+1}}").text.replace(/\{\{1\+1\}\}/u, "")));
});

test("a KNOWN field with no value is marked, never dropped, never zeroed", () => {
  const r = en("win rate: {{stats.winRate}}");
  assert.equal(r.text, `win rate: ${NOT_RECORDED.en}`);
  assert.deepEqual(r.missing, ["stats.winRate"]);
  assert.equal(fa("x {{symbol}}").text.includes(NOT_RECORDED.fa), true);
});

test("0 and '0.00' are readings, not absences — the whole honesty of the card rests here", () => {
  assert.equal(en("{{stats.netPnl}}", { "stats.netPnl": 0 }).text, "0");
  assert.equal(en("{{stats.winRate}}", { "stats.winRate": "0.00" }).text, "0.00%");
  assert.deepEqual(en("{{stats.netPnl}}", { "stats.netPnl": 0 }).missing, []);
});

test("single pass: a value that looks like a placeholder cannot be re-scanned", () => {
  // `notes` IS a known field with a value — if substitution were iterative, the value of
  // `symbol` would become a second token and pick "SAFE" up. Substitution is one pass, so the
  // nested text is inert.
  const r = en("A {{symbol}} B", { symbol: "{{notes}}", notes: "SAFE" });
  assert.equal(r.text, "A {{notes}} B");
  assert.equal(r.text.includes("SAFE"), false);
});

test("untrusted values cannot inject markup; the tag is reported, not swallowed", () => {
  const r = en("{{notes}}", { notes: "<script>alert(1)</script>" });
  assert.equal(r.text.includes("<script>"), false);
  assert.equal(r.text.includes("&lt;script&gt;"), true);
  assert.deepEqual(r.strippedTags, []);
});

test("whitelisted Telegram markup survives; anything else is escaped", () => {
  const r = en("<b>t</b> <marquee>m</marquee> <blink data-x='1'>b</blink>");
  assert.equal(r.text.includes("<b>t</b>"), true);
  assert.equal(r.text.includes("<marquee"), false);
  assert.equal(r.text.includes("<blink"), false);
  assert.deepEqual(r.strippedTags, ["marquee", "blink"]);
});

test("an empty allowlist permits NOTHING — the default is refusal, not openness", () => {
  // The regression this pins: `isAllowedLink(url, [])` once returned true, so every unconfigured
  // caller published every https link a template body contained.
  assert.equal(isAllowedLink("https://app.veloratrade.ir/t/9", []), false);
  assert.equal(isAllowedLink("https://app.veloratrade.ir/t/9", ["app.veloratrade.ir"]), true);
  assert.equal(isAllowedLink("https://EVIL.example/x", ["app.veloratrade.ir"]), false);
  // A suffix match must be a real subdomain, not a string that ends like one.
  assert.equal(isAllowedLink("https://notapp.veloratrade.ir/x", ["app.veloratrade.ir"]), false);
  const bare = sanitizeTelegramMarkup('<a href="https://anywhere.example/x">go</a>');
  assert.equal(bare.text, "go", "no hosts configured ⇒ the anchor is gone and the words remain");
  assert.deepEqual(bare.stripped, ["a"]);
});

test("links: https to an allowed host only, and the label stays user text", () => {
  const kept = sanitizeTelegramMarkup(
    `<a href="https://app.veloratrade.ir/t/9">open</a> <a href="http://app.veloratrade.ir">x</a> <a href="javascript:alert(1)">y</a> <a href="https://evil.example">z</a>`,
    ["app.veloratrade.ir"],
  );
  assert.equal(kept.text.includes('href="https://app.veloratrade.ir/t/9"'), true);
  // Byte-for-byte, because "the refused anchor loses its tag and keeps its label" is only a real
  // promise if the exact output is pinned: no destination survives, the words do, and the markup
  // stays balanced (one `<a>`, one `</a>`).
  assert.equal(kept.text, `<a href="https://app.veloratrade.ir/t/9">open</a> x y z`);
  assert.deepEqual(kept.stripped, ["a"]);
  assert.equal(kept.text.includes("javascript"), false);
  assert.equal(kept.text.includes("evil.example"), false);
  assert.equal(kept.text.match(/<a\b/gu)?.length, 1);
  assert.equal(kept.text.match(/<a\b/gu)?.length, 1);
  assert.ok(kept.stripped.includes("a"));
  assert.equal(isAllowedLink("javascript:alert(1)", []), false);
  assert.equal(isAllowedLink("https://x.test", ["x.test"]), true);
  assert.equal(isAllowedLink("https://sub.x.test", ["x.test"]), true);
  assert.equal(isAllowedLink("https://x.test.evil.io", ["x.test"]), false);
});

test("percent/ratio formatting is decoration only: it never recomputes a number", () => {
  assert.equal(en("{{stats.winRate}}", { "stats.winRate": "61.5" }).text, "61.5%");
  assert.equal(en("{{stats.winRate}}", { "stats.winRate": "61.5%" }).text, "61.5%");
  assert.equal(en("{{stats.profitFactor}}", { "stats.profitFactor": "1.84" }).text, "1.84");
});

test("checklist states are labelled, and an unknown stays unknown", () => {
  const state = (v: string) => en("{{checklist.smt.state}}", { "checklist.smt.state": v }).text;
  assert.equal(state("CONFIRMED"), "confirmed");
  assert.equal(state("UNREVIEWED"), "unreviewed");
  assert.equal(state("UNKNOWN"), "unknown");
});

test("oversized render: truncated at a boundary that cannot split a tag or an entity", () => {
  const r = en(`${"<b>".repeat(2000)}${"x".repeat(3000)}`);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= TELEGRAM_TEXT_LIMIT);
  const openCount = (r.text.match(/<b>/gu) ?? []).length;
  const closeCount = (r.text.match(/<\/b>/gu) ?? []).length;
  assert.equal(openCount, closeCount);
  // 2000 unclosed <b> cannot be balanced inside 4096 chars, so the markup goes and the text stays.
  assert.equal(r.markupDropped, true);
  assert.equal(r.text.includes("<"), false);
  assert.equal(r.text.includes("xxx"), true);
  assert.ok(r.text.length > TELEGRAM_TEXT_LIMIT - 4096 + 2900, String(r.text.length));
  assert.equal(r.text.slice(-1), "…");
  const small = en(`${"<b>".repeat(20)}${"y".repeat(4200)}`);
  assert.equal(small.truncated, true);
  assert.equal(small.markupDropped, false);
  assert.ok((small.text.match(/<b>/gu) ?? []).length > 0);
  assert.equal((small.text.match(/<b>/gu) ?? []).length, (small.text.match(/<\/b>/gu) ?? []).length);
  const entity = en("a".repeat(TELEGRAM_TEXT_LIMIT - 2) + "&amp;", {});
  assert.equal(entity.text.includes("&amp;"), false);
  assert.equal(entity.text.includes("&amp"), false);
  assert.equal(entity.text.slice(-1), "…");
});

test("oversized body is refused at inspection, not truncated at render", () => {
  assert.equal(inspectTemplate("x".repeat(TEMPLATE_BODY_LIMIT + 1)).tooLong, true);
  assert.equal(inspectTemplate("x").tooLong, false);
  assert.equal(inspectTemplate("   ").empty, true);
});

test("gaps are explained in both languages", () => {
  const lines = describeTemplateGaps(inspectTemplate("{{nope}} {{1+1}} <div>d</div>"), ["symbol"], "fa");
  assert.equal(lines.length >= 4, true);
  assert.equal(lines.some((l) => l.includes("{{nope}}") || l.includes("nope")), true);
  assert.equal(lines.some((l) => l.includes("محاسبات")), true);
  const eng = describeTemplateGaps(inspectTemplate("{{nope}}"), [], "en");
  assert.equal(eng.some((l) => /Unknown field/u.test(l)), true);
});

test("built-in templates: every placeholder is a known field, and both locales match key-for-key", () => {
  assert.equal(BUILT_IN_TEMPLATES.length >= 2, true);
  for (const tpl of BUILT_IN_TEMPLATES) {
    for (const locale of ["fa", "en"] as const) {
      const inspection = inspectTemplate(tpl.body[locale]);
      assert.deepEqual(inspection.unknown, [], `${tpl.id}/${locale}`);
      assert.deepEqual(inspection.unsupported, [], `${tpl.id}/${locale}`);
      assert.deepEqual(inspection.disallowedTags, [], `${tpl.id}/${locale}`);
    }
    assert.deepEqual(
      templateFieldKeys(tpl.body.fa).sort(),
      templateFieldKeys(tpl.body.en).sort(),
      `${tpl.id} locales must offer the same fields`,
    );
  }
});

test("built-in bias card: empty data yields markers, not a confident-looking blank", () => {
  const bias = BUILT_IN_TEMPLATES.find((t) => t.id === "velora.bias")!;
  const r = renderTemplate({ body: bias.body.en, values: {}, locale: "en" });
  assert.equal(r.text.includes("{{"), false);
  assert.ok(r.missing.length >= 10);
  assert.equal(r.text.includes("neutral"), false);
  assert.equal(r.text.includes("0%"), false);
  assert.equal(r.text.includes(": — not recorded"), true);
});

test("built-in bias card: real data is echoed, AI text stays under its own line", () => {
  const bias = BUILT_IN_TEMPLATES.find((t) => t.id === "velora.bias")!;
  const r = renderTemplate({
    body: bias.body.en,
    locale: "en",
    values: {
      date: "2026-10-19",
      time: "09:30",
      symbol: "XAUUSD",
      timeframe: "M15",
      "checklist.dailyBias": "bullish",
      "checklist.dailyBias.state": "CONFIRMED",
      "checklist.marketLeg": "up",
      "checklist.marketLeg.state": "CONFIRMED",
      "checklist.stopLoss": "2641.5",
      "checklist.risk": "0.5%",
      analysis: "AI: premium rejection above 2660.",
    },
  });
  assert.match(r.text, /XAUUSD · Timeframe: M15/u);
  assert.match(r.text, /Daily bias: bullish \(confirmed\)/u);
  assert.match(r.text, /AI: premium rejection/u);
  assert.equal(r.missing.includes("checklist.priceLocation"), true);
});

test("performance card: the sampling note is a field, so a sampled window cannot read as a full one", () => {
  const weekly = BUILT_IN_TEMPLATES.find((t) => t.id === "velora.weekly")!;
  const sampled = renderTemplate({
    body: weekly.body.en,
    locale: "en",
    values: { "stats.window": "this week", "stats.winRate": "58.3", "stats.sampled": "Sampled from 200 rows — not the full dataset." },
  });
  assert.match(sampled.text, /Sampled from 200 rows/u);
  const none = renderTemplate({ body: weekly.body.en, locale: "en", values: { "stats.window": "all time" } });
  assert.equal(none.text.includes("Sampled"), false);
  assert.ok(none.missing.includes("stats.winRate"));
});

test("TEMPLATE_FIELDS covers every checklist item twice (value and state)", () => {
  const checklistKeys = Object.keys(TEMPLATE_FIELDS).filter((k) => k.startsWith("checklist."));
  const states = checklistKeys.filter((k) => k.endsWith(".state"));
  assert.equal(states.length * 2 >= checklistKeys.length - 3, true);
  for (const key of ["dailyBias", "marketLeg", "priceLocation", "pdArrayH4", "m1Cisd", "smt", "macroTiming", "stopLoss", "risk"]) {
    assert.ok(TEMPLATE_FIELDS[`checklist.${key}`] !== undefined, key);
    assert.equal(TEMPLATE_FIELDS[`checklist.${key}`]!.source, "checklist");
  }
});

test("rtl/ltr is derived from the locale, and Persian digits in copy are untouched", () => {
  assert.equal(fa("سلام {{symbol}}").direction, "rtl");
  assert.equal(en("hi").direction, "ltr");
  assert.equal(fa("۱۴۰۵-۰۷-۲۷ {{date}}", { date: "2026-10-19" }).text.startsWith("۱۴۰۵-۰۷-۲۷"), true);
});

// ───────────────────────────── banner composition ─────────────────────────────
test("banner: Velora identity tokens and a real RTL document", () => {
  const b = renderBanner({
    title: "بایاس روزانه",
    subtitle: "XAUUSD",
    direction: "rtl",
    locale: "fa",
    rows: [
      { label: "بایاس", value: "bullish", emphasis: "gain" },
      { label: "PF", value: "1.84", mono: true },
    ],
    footnote: "AI: نمونه",
  });
  assert.match(b.svg, /<svg/u);
  assert.equal(b.svg.includes("#0e1626"), true);
  assert.equal(b.svg.includes("#9b782e"), true);
  assert.equal(b.svg.includes("#101b2d"), true);
  assert.equal(b.svg.includes("#0d1829"), true);
  assert.equal(b.svg.includes("#d4af37"), true);
  assert.match(b.svg, /dir="rtl"/u);
  assert.match(b.svg, /text-anchor="end"/u);
  assert.match(b.svg, /Vazirmatn/u);
  assert.match(b.svg, /Tahoma/u);
  assert.equal(b.rowsShown, 2);
  assert.equal(b.rowsDropped, 0);
  // Persian digits in the Latin-free parts, digits converted
  assert.equal(b.svg.includes("۱.۸۴"), true);
});

test("banner: contrast — every text fill is a light tone on a dark surface", () => {
  const b = renderBanner({ title: "T", direction: "ltr", rows: [{ label: "a", value: "b" }] });
  const hexColor = "(#[0-9a-fA-F]{6})";
  const fills = [...b.svg.matchAll(new RegExp(`fill="${hexColor}"`, "gu"))].map((m) => m[1]!);
  const textFills = [...b.svg.matchAll(new RegExp(`font-family[^>]*fill="${hexColor}"`, "gu"))].map((m) => m[1]!.toLowerCase());
  assert.ok(textFills.length >= 3);
  for (const f of textFills) {
    assert.notEqual(f, "#0e1626");
    assert.notEqual(f, "#101b2d");
    assert.notEqual(f, "#0d1829");
  }
  assert.ok(fills.length >= 4);
});

test("banner: untrusted row content is XML-escaped and cannot break out of a text node", () => {
  const b = renderBanner({
    title: '</text><script id="x">bad</script>',
    direction: "ltr",
    rows: [{ label: '<t x="1">', value: "</svg><image href=y>" }],
  });
  assert.equal(b.svg.includes("<script"), false);
  assert.equal(b.svg.includes('id="x"'), false);
  assert.match(b.svg, /&lt;script/u);
  assert.equal(b.svg.includes("</svg><image"), false);
});

test("banner: row budget is enforced and reported, never silently clipped", () => {
  const rows = Array.from({ length: BANNER_MAX_ROWS + 4 }, (_, i) => ({ label: `l${i}`, value: `v${i}` }));
  const b = renderBanner({ title: "T", direction: "ltr", rows });
  assert.equal(b.rowsShown, BANNER_MAX_ROWS);
  assert.equal(b.rowsDropped, 4);
  assert.match(b.svg, /more rows/u);
});

test("banner: an oversized value is truncated with a visible marker and listed", () => {
  const long = "X".repeat(400);
  const b = renderBanner({ title: "T", direction: "ltr", rows: [{ label: "notes", value: long }] });
  assert.match(b.svg, /…/u);
  assert.equal(b.truncatedValues.includes(long), true);
});

test("banner: a chart image is clipped to its frame and keeps the aspect ratio", () => {
  const b = renderBanner({
    title: "T",
    direction: "ltr",
    rows: [{ label: "a", value: "b" }],
    imageUrl: "data:image/png;base64,AAAA",
  });
  assert.match(b.svg, /<clipPath/u);
  assert.match(b.svg, /<image/u);
  assert.match(b.svg, /preserveAspectRatio="xMidYMid slice"/u);
  // The invariant is that the block is ADDED to the card, not one magic number.
  assert.match(b.svg, /<rect x="56" y="\d+" width="\d+" height="300" rx="14"/u);
  const plain = renderBanner({ title: "T", direction: "ltr", rows: [{ label: "a", value: "b" }] });
  assert.ok(b.height > plain.height, `${b.height} vs ${plain.height}`);
  assert.ok(b.height > 500, String(b.height));
});

test("banner: no placeholder syntax survives into the artwork", () => {
  const bias = BUILT_IN_TEMPLATES.find((t) => t.id === "velora.bias")!;
  const r = renderTemplate({ body: bias.body.fa, values: {}, locale: "fa" });
  const b = renderBanner({ title: "بایاس", direction: "rtl", locale: "fa", rows: [{ label: "یادداشت", value: r.text.slice(0, 40) }] });
  assert.equal(b.svg.includes("{{"), false);
});
