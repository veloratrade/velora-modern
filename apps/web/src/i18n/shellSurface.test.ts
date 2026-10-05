/*
 * Shell rendering guard — the sidebar, the top bar and the account card.
 *
 * WHY THIS FILE EXISTS. The Phase 1 visual QA pass caught the shell rendering a
 * PERSIAN label inside the ENGLISH app: `/accounts` was the one nav item whose
 * key (`common.accounts`) existed in no catalog, so the sidebar silently fell
 * back to its hard-coded Persian default. Persian text in an LTR shell is not a
 * cosmetic detail — it is the exact failure mode the localization rules forbid
 * ("a feature is not complete if only English works").
 *
 * The test therefore does not keep a hand-written list of keys. It READS the
 * shell sources, extracts every key they pass to `t()` — including the `key:`
 * fields of the NAV table, which are never written as `t("...")` in the source —
 * and resolves each one through the REAL translator with the SAME catalog set the
 * component loads. Two rules follow from that:
 *
 *   1. a key that falls back to the source's baked-in string fails (the catalog
 *      must own the string);
 *   2. an English resolution that contains Persian/Arabic letters fails (a
 *      translated string that only exists in fa is a missing translation).
 *
 * It also pins the four shell strings this pass lifted from Legacy's canonical
 * catalog (`public/locales/{fa,en}.json` @edede31) — byte for byte, ZWNJ
 * included — because three of them live in NO Legacy chunk and therefore had no
 * Modern home until the sidebar/top bar started using them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTranslator, messagesFor } from "./catalog.js";
import type { Feature } from "./catalog.js";
import type { Locale } from "../contracts/locale.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const LOCALES: readonly Locale[] = ["fa", "en"];

/** The shell components, with the catalog set each one passes to createTranslator. */
const SOURCES = [
  { file: "components/layout/Sidebar.tsx", features: ["common", "errors", "telegram"] },
  { file: "components/layout/TopBar.tsx", features: ["common"] },
  { file: "components/layout/AppShell.tsx", features: ["common"] },
] as const satisfies readonly { file: string; features: readonly Feature[] }[];

function source(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/** Every literal key the component passes to `t(...)`. */
function literalKeys(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) out.add(m[1]!);
  return [...out];
}

/** The NAV table's `key:` fields — the labels the sidebar renders through `t(item.key, …)`. */
function navKeys(src: string): { key: string; fallback: string }[] {
  return [...src.matchAll(/key:\s*"([^"]+)",\s*fallback:\s*"([^"]+)"/g)].map((m) => ({ key: m[1]!, fallback: m[2]! }));
}

const HAS_ARABIC_SCRIPT = /[\u0600-\u06FF]/;

test("shell: every key the sidebar/top bar renders resolves from the catalog", () => {
  for (const s of SOURCES) {
    const src = source(s.file);
    const keys = [...new Set([...literalKeys(src), ...navKeys(src).map((n) => n.key)])];
    const minimum = s.file.endsWith("Sidebar.tsx") ? 10 : 1;
    assert.ok(keys.length >= minimum, `${s.file}: expected at least ${minimum} shell keys, found ${keys.length}`);
    for (const locale of LOCALES) {
      const t = createTranslator(locale, s.features);
      for (const key of keys) {
        // A sentinel fallback: if the key is absent the translator echoes the
        // sentinel back, which is how we detect a silent fallback.
        const SENTINEL = `\u0000${key}\u0000`;
        const value = t(key, null, SENTINEL);
        assert.notEqual(value, SENTINEL, `${s.file} [${locale}]: key "${key}" is not in the catalogs it loads (it would fall back to a hard-coded string)`);
        assert.notEqual(value.trim(), "", `${s.file} [${locale}]: key "${key}" resolves to an empty string`);
      }
    }
  }
});

test("shell: the NAV table's baked-in fallbacks are never what the user sees", () => {
  const src = source("components/layout/Sidebar.tsx");
  const nav = navKeys(src);
  assert.ok(nav.length >= 10, `Sidebar NAV should have at least 10 items, found ${nav.length}`);
  for (const { key, fallback } of nav) {
    for (const locale of LOCALES) {
      const value = createTranslator(locale, ["common", "errors", "telegram"])(key, null, fallback);
      assert.equal(value, createTranslator(locale, ["common", "errors", "telegram"])(key, null, "\u0000"), `#${key} [${locale}] fell back to the hard-coded string "${fallback}"`);
    }
  }
});

test("shell: no Persian leaks into the English shell", () => {
  for (const s of SOURCES) {
    const src = source(s.file);
    const keys = [...new Set([...literalKeys(src), ...navKeys(src).map((n) => n.key)])];
    const fa = createTranslator("fa", s.features);
    const en = createTranslator("en", s.features);
    for (const key of keys) {
      const faValue = fa(key, null, "");
      const enValue = en(key, null, "");
      // Strings that are identical in both locales (brand names, "VELORA") are
      // allowed to contain anything; a *translated* pair must not put Persian
      // script in front of an English reader.
      if (faValue === enValue) continue;
      assert.ok(!HAS_ARABIC_SCRIPT.test(enValue), `${s.file}: "${key}" resolves to Persian text in the English shell → "${enValue}"`);
    }
  }
});

test("shell: the four Legacy catalog strings used by the shell are byte-faithful", () => {
  // public/locales/{fa,en}.json @edede31. `nav.accounts`, `nav.logout` and the
  // logout confirmation exist in NO Legacy chunk; `common.login.to.account.*`
  // is only in Legacy's canonical catalog. They were copied verbatim (the fa
  // values keep Legacy's ZWNJ) rather than re-translated.
  const EXPECTED: Record<string, { fa: string; en: string }> = {
    "nav.accounts": { fa: "حساب\u200cها", en: "Accounts" },
    "nav.logout": { fa: "خروج", en: "Log out" },
    "common.login.to.account.8181f948": { fa: "ورود به حساب", en: "Login to Account" },
    "pages.dashboard.are.you.sure.you.want.to.logout.16e6ca9b": {
      fa: "مطمئن هستید که می\u200cخواهید از حساب VELORA خارج شوید؟",
      en: "Are you sure you want to logout from VELORA?",
    },
  };
  for (const locale of LOCALES) {
    const messages = messagesFor(locale, ["common"]);
    for (const [key, pair] of Object.entries(EXPECTED)) {
      assert.equal(messages[key], pair[locale], `${locale}: ${key} is not the Legacy string`);
    }
  }
});

test("shell: no hard-coded user-facing text left in the sidebar chrome", () => {
  // The sidebar used to render `locale === "fa" ? "خروج" : "Sign out"` and a
  // hard-coded logout confirmation. Keys are cheap; drift is not. This asserts
  // the specific shapes that were removed cannot come back.
  const src = source("components/layout/Sidebar.tsx");
  assert.ok(!/window\.confirm\(\s*"/.test(src), "logout confirmation must come from the catalog, not a literal");
  assert.ok(!/locale === "fa" \? "[^"]*[\u0600-\u06FF]/.test(src), "a fa/en literal pair reappeared in the sidebar — use a catalog key");
  const top = source("components/layout/TopBar.tsx");
  assert.ok(!/window\.location\.pathname/.test(top), "TopBar must use usePathname() so SSR and hydration agree");
});
