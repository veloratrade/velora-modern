/*
 * Trades-surface guards — TRD-02 (manual entry) + TRD-04 (list) + TRD-07 (KPIs).
 *
 * WHY THIS FILE EXISTS. Two classes of defect were found on the trading pages
 * while migrating them:
 *
 *   1. KEYS THAT SILENTLY FALL BACK. The trades page used to hold hand-written
 *      fa/en pairs, so nothing could catch a label that existed in one language
 *      only. This test reads the page's SOURCE, extracts every key it passes to
 *      `t(...)`, and drives the REAL translator the page uses
 *      (`createTranslator(locale, ["common","errors","trades"])`) in both
 *      locales — a key added to the UI without a catalog entry fails here.
 *
 *   2. CAPABILITY THAT QUIETLY DISAPPEARS FROM THE FORM. The fields that decide
 *      the money math — contract size, commission, swap — and the live preview
 *      are asserted directly against the source. If someone deletes the
 *      commission input, the page still renders; only this test notices that the
 *      recorded P&L is no longer the P&L the trader meant.
 *
 * It also pins the preview's fidelity rule: the number shown while typing comes
 * from the domain engine in the SAME mode the API uses for a new trade
 * ("half-even"), never from a second, private formula.
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
const TRADES_PAGE = join(WEB, "src", "app", "(app)", "trades", "page.tsx");
const PREVIEW = join(WEB, "src", "features", "trades", "pnlPreview.ts");

const FEATURES = ["common", "errors", "trades"] as const;
const LOCALES: readonly Locale[] = ["fa", "en"];

const CORRUPTION = ["\uFFFD", "Ã", "Â", "Ø", "Ù", "ð", "\\u", "&amp;"];
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

/**
 * Every catalog key the page references, whether it goes straight into `t(...)`
 * or is handed to the small form-field helper (`input(key, value, …)`), which is
 * how several labels are rendered. The loose pass matches the SHAPE of a catalog
 * key (dotted, letters-first, no spaces — so "1.10000", "POST /api/v1/trades",
 * "v-latn-num" and "./catalog.js" cannot match), and the union with the strict
 * `t("…")` pass means neither style can hide a key from this guard.
 */
function literalKeys(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) out.add(m[1]!);
  for (const m of src.matchAll(/"([a-z][A-Za-z0-9]*\.[A-Za-z0-9._#-]+)"/g)) out.add(m[1]!);
  return [...out];
}

const t = (locale: Locale) => createTranslator(locale, [...FEATURES]);

test("the trades page renders a real key set (guard against an empty scan)", () => {
  const keys = literalKeys(readFileSync(TRADES_PAGE, "utf8"));
  assert.ok(keys.length >= 30, `expected the trades page to use a real key set, found ${keys.length}`);
  for (const must of [
    "pages.trades.new.contract.size.fbd9b24e",
    "pages.trades.new.commission.075f0257",
    "pages.trades.new.swap.10e4a1fd",
    "pages.trades.new.estimated.p.l.d17fba70",
    "trades.save",
    "trades.deleteConfirm",
  ]) {
    assert.ok(keys.includes(must), `${must} is no longer rendered by the trades page`);
  }
});

test("every key the trades page renders resolves to its own string in BOTH locales", () => {
  const keys = literalKeys(readFileSync(TRADES_PAGE, "utf8"));
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

test("the migrated labels are Persian in fa and English in en — checked on RENDERED values", () => {
  const catalogFa = messagesFor("fa", [...FEATURES]);
  const catalogEn = messagesFor("en", [...FEATURES]);
  const sample = [
    "pages.trades.new.contract.size.fbd9b24e",
    "pages.trades.new.commission.075f0257",
    "pages.trades.new.swap.10e4a1fd",
    "pages.trades.new.emotional.score.3adcd56b",
    "trades.save",
    "trades.deleteConfirm",
  ];
  for (const key of sample) {
    assert.ok(ARABIC_SCRIPT.test(catalogFa[key]!), `fa:${key} is not Persian: ${catalogFa[key]}`);
    assert.ok(!ARABIC_SCRIPT.test(catalogEn[key]!), `en:${key} is not English: ${catalogEn[key]}`);
  }
  // Legacy's canonical wording, verbatim (the migration copies meaning AND words).
  assert.equal(catalogFa["pages.trades.new.commission.075f0257"], "کمیسیون");
  assert.equal(catalogEn["pages.trades.new.commission.075f0257"], "Commission");
  assert.equal(catalogFa["pages.trades.new.contract.size.fbd9b24e"], "اندازه قرارداد");
  assert.equal(catalogEn["pages.trades.new.contract.size.fbd9b24e"], "Contract Size");
});

test("the cost/contract fields and the live preview are present in the form source", () => {
  // Comments are stripped so an explanation of a removed field cannot satisfy
  // (or trip) these scans — only real code counts.
  const src = readFileSync(TRADES_PAGE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/.*$/gm, "");
  const payload = src.slice(src.indexOf("const payload"), src.indexOf("await createTrade"));
  assert.ok(payload.length > 0, "the create payload could not be located in the page source");
  for (const field of ["contractSize", "commission", "swap"]) {
    assert.ok(src.includes(`${field}:`), `the form no longer carries ${field} — net P&L would be wrong`);
    assert.ok(payload.includes(`${field}:`), `${field} is no longer sent to POST /api/v1/trades`);
  }
  assert.ok(src.includes("previewPnl("), "the live P&L preview was removed");
  assert.ok(src.includes("summary.totalPnl") && src.includes("summary.winRate"), "the KPI row stopped reading the API's real fields");
  assert.ok(!src.includes("totalTrades"), "the page reads `totalTrades`, which /analytics/summary never returns");
});

test("the preview uses the domain engine in the API's mode, not a private formula", () => {
  const src = readFileSync(PREVIEW, "utf8");
  assert.ok(src.includes('from "@velora/domain"'), "the preview must reuse the domain package");
  assert.ok(src.includes("computePnl("), "the preview must call the domain's computePnl");
  assert.ok(src.includes('"half-even"'), "the preview must use the same rounding mode the API uses for a new trade");
  assert.ok(src.includes("rescale(fromString(value), 8") || src.includes("scale(entry, 8)"), "prices/volume/contract must be scaled like the API does");
});
