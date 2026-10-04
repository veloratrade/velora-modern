/*
 * Dashboard-surface guard — TRD-07.
 *
 * Two failure modes are pinned here, both of which really happened on this page:
 *
 *   * LABELS DRIFTING BETWEEN LOCALES. The page held hand-written fa/en pairs.
 *     This test extracts every key it passes to `t(...)` and drives the real
 *     translator (`createTranslator(locale, ["common","errors","trades","dashboard"])`)
 *     in both locales.
 *
 *   * READING FIELDS THE API DOES NOT SEND. The KPI row read `totalTrades` /
 *     `totalPnL` (the API sends `tradeCount` / `totalPnl`) and the chart read
 *     `point.equity` (the API sends `cumulativePnl`). Each mismatch rendered a
 *     believable zero instead of an error. The assertions below fail if the page
 *     goes back to any of those names.
 *
 * Also pinned: Legacy's curve default. Legacy's equity curve is a 30-DAY window
 * (clamped 7…365) with a 7/30/90 selector; the Modern page must open on 30d.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTranslator, messagesFor } from "./catalog.js";
import type { Locale } from "../contracts/locale.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "app", "(app)", "dashboard", "page.tsx");
const FEATURES = ["common", "errors", "trades", "dashboard"] as const;
const LOCALES: readonly Locale[] = ["fa", "en"];
const CORRUPTION = ["\uFFFD", "Ã", "Â", "Ø", "Ù", "ð", "\\u"];

/**
 * The page's CODE, without its comments. The docblock deliberately names the
 * wrong field names it replaced (`totalTrades`, `s.totalPnL`, `point.equity`) —
 * a naive `includes()` scan would flag the explanation of the fix as the bug.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
}

function keys(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) out.add(m[1]!);
  for (const m of src.matchAll(/"([a-z][A-Za-z0-9]*\.[A-Za-z0-9._#-]+)"/g)) out.add(m[1]!);
  return [...out];
}

test("every key the dashboard renders resolves to its own string in BOTH locales", () => {
  const src = readFileSync(PAGE, "utf8");
  const list = keys(src);
  assert.ok(list.length >= 12, `expected a real key set on the dashboard, found ${list.length}`);
  for (const locale of LOCALES) {
    const t = createTranslator(locale, [...FEATURES]);
    const catalog = messagesFor(locale, [...FEATURES]);
    for (const key of list) {
      const value = t(key, null, "\u0000MISSING\u0000");
      assert.ok(!value.includes("MISSING"), `${locale}: ${key} is missing from the catalog`);
      assert.notEqual(catalog[key]!.trim(), "", `${locale}: ${key} is empty`);
      for (const bad of CORRUPTION) assert.ok(!value.includes(bad), `${locale}: ${key} rendered ${JSON.stringify(bad)}`);
    }
  }
});

test("the KPI row reads the API's REAL field names, and the chart plots cumulativePnl", () => {
  const src = stripComments(readFileSync(PAGE, "utf8"));
  for (const field of ["tradeCount", "winRate", "totalPnl", "profitFactor", "averageR", "byStrategy"]) {
    assert.ok(src.includes(field), `the dashboard no longer reads ${field}`);
  }
  assert.ok(src.includes("cumulativePnl"), "the equity chart must plot cumulativePnl (the API's field)");
  for (const invented of ["totalTrades", "totalPnL", "winningTrades", "point.equity", "pt.equity"]) {
    assert.ok(!src.includes(invented), `the dashboard reads ${invented}, which /analytics/* never sends`);
  }
});

test("Legacy's curve default is 30 days with a 7/30/90 selector", () => {
  const src = stripComments(readFileSync(PAGE, "utf8"));
  assert.match(src, /useState<string>\("30d"\)/, "the curve must open on Legacy's 30-day window");
  for (const period of ['"7d"', '"30d"', '"90d"']) {
    assert.ok(src.includes(period), `the period selector no longer offers ${period}`);
  }
  assert.ok(src.includes("getEquityCurve({ period: window })"), "the selector must be passed to the API's period parameter");
});

test("a deployment without analytics says so instead of showing zeroes", () => {
  const src = readFileSync(PAGE, "utf8");
  assert.ok(src.includes("SERVICE_UNAVAILABLE"), "the 503 capability-absent state must be handled explicitly");
  assert.ok(src.includes("capAbsent"), "the capability-absent branch was removed");
});
