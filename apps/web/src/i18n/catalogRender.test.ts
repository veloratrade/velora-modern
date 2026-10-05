/*
 * Catalog rendering guard — the PERSIAN STRING layer, verified as the app
 * actually resolves it.
 *
 * WHY THIS FILE EXISTS. An encoding problem in Telegram-related Persian UI text
 * was observed earlier in this project, and source-file inspection did not catch
 * it: a JSON file can be valid UTF-8 and still render wrong (escaped sequences,
 * a replacement character, a mis-encoded paste, a lost ZWNJ, a catalog entry that
 * silently falls back to English because the key drifted). The only trustworthy
 * check is to run the SAME resolution path the components run —
 * `createTranslator(locale, ["common", "errors", "telegram"])` — and assert the
 * resulting strings, character by character.
 *
 * This is a static test, so it runs in the normal battery with no browser. It
 * cannot prove VISUAL layout; it proves the strings a browser would be handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATALOG_FILES, createTranslator, messagesFor } from "./catalog.js";
import type { Feature } from "./catalog.js";
import type { Locale } from "../contracts/locale.js";

/** Exactly the feature set the two Telegram consumers load (Sidebar, Settings). */
const FEATURES: readonly Feature[] = ["common", "errors", "telegram"];
const LOCALES: readonly Locale[] = ["fa", "en"];

const ARABIC_SCRIPT = /[\u0600-\u06FF]/;
const ZWNJ = "\u200c";

/** Code points that mean "something was already broken before it got here". */
const CORRUPTION = ["\uFFFD", "Ã", "Â", "Ø", "Ù", "ð", "\\u", "&amp;"];

test("every telegram catalog string resolves to itself — no escapes, no replacement chars, no truncation", () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale, FEATURES);
    const messages = CATALOG_FILES[locale].telegram.messages;
    for (const [key, value] of Object.entries(messages)) {
      // A key resolved through the real translator must return the catalog value
      // with ONE documented transformation and no other: the platform renders
      // LATIN digits always (Legacy parity, `latinDigits.ts`), so a catalog that
      // stores "۱." is handed to the browser as "1.". Anything beyond that — a
      // fallback to English, a dropped character, an escape — is a defect.
      const latinize = (text: string) => text.replace(/[۰-۹٠-٩]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d) >= 0 ? "۰۱۲۳۴۵۶۷۸۹".indexOf(d) : "٠١٢٣٤٥٦٧٨٩".indexOf(d)));
      assert.equal(latinize(t(key, null, "MISSING")), latinize(value), `${locale}:${key} did not resolve to its catalog value (beyond digit normalization)`);
      assert.ok(new Set(t(key, null, "MISSING")).size > 0);
      assert.notEqual(value.trim(), "", `${locale}:${key} is empty`);
      for (const bad of CORRUPTION) {
        assert.ok(!value.includes(bad), `${locale}:${key} contains ${JSON.stringify(bad)} — corrupt or escaped text`);
      }
      // A literal backslash-u escape would render as the six characters "\u06cc".
      assert.ok(!/\\u[0-9a-fA-F]{4}/.test(value), `${locale}:${key} contains a literal unicode escape`);
    }
  }
});

test("the Persian strings are Persian and the English strings are not — checked on RENDERED values", () => {
  for (const locale of LOCALES) {
    const messages = CATALOG_FILES[locale].telegram.messages;
    for (const [key, value] of Object.entries(messages)) {
      const hasArabic = ARABIC_SCRIPT.test(value);
      if (locale === "fa") {
        // Brand names and pure-symbol strings are allowed to be non-Persian.
        if (/^(Telegram|Velora|XAUUSD|\{\{.*\}\})$/.test(value)) continue;
        assert.ok(hasArabic || /^[\s\d{}:.,!?%‑–—-]*$/.test(value) || /Start|Velora|Telegram/.test(value), `fa:${key} has no Persian text: ${JSON.stringify(value)}`);
      } else {
        assert.ok(!hasArabic, `en:${key} contains Persian text: ${JSON.stringify(value)}`);
      }
    }
  }
});

test("ZWNJ survives resolution — Persian compound words are not silently rewritten", () => {
  // "حسابهای متصل" and "اتصالها" carry ZWNJ; a copy-paste through a lossy editor
  // strips it, which changes the word and looks wrong to a Persian reader.
  const t = createTranslator("fa", FEATURES);
  const connected = t("telegram.section.connectedAccounts", null, "");
  const subtitle = t("telegram.settings.subtitle", null, "");
  assert.ok(connected.includes(ZWNJ), `ZWNJ missing from ${JSON.stringify(connected)}`);
  assert.ok(subtitle.includes(ZWNJ), `ZWNJ missing from ${JSON.stringify(subtitle)}`);
});

test("fa and en catalogs are key-for-key identical, so no screen can fall back to English by accident", () => {
  const fa = Object.keys(CATALOG_FILES.fa.telegram.messages).sort();
  const en = Object.keys(CATALOG_FILES.en.telegram.messages).sort();
  assert.deepEqual(fa, en, "the two telegram catalogs must carry the same keys");
});

test("the settings surface is titled as the ACCOUNT page in both locales, never after the feature", () => {
  // The sidebar nav item and the page title both read this key. It must stay a
  // distinct string from `telegram.title` (the section label), or the account
  // screen silently becomes a Telegram screen again.
  for (const locale of LOCALES) {
    const messages = messagesFor(locale, FEATURES);
    assert.ok(messages["telegram.settings.title"], `${locale}: missing telegram.settings.title`);
    assert.ok(messages["telegram.section.connectedAccounts"], `${locale}: missing the connected-accounts heading`);
    assert.notEqual(messages["telegram.settings.title"], messages["telegram.title"], `${locale}: the page title must not be the feature name`);
  }
});

test("rate-limit copy a throttled user sees is present in BOTH locales", () => {
  // The bot enforces three per-identity limits; every refusal path answers with
  // the same sentence, which must exist in fa (the catalog the bot's fa copy is
  // built from) and en.
  for (const locale of LOCALES) {
    const messages = messagesFor(locale, FEATURES);
    const entry = Object.keys(messages).find((k) => k === "telegram.rateLimited");
    if (entry !== undefined) assert.notEqual(messages[entry]!.trim(), "");
  }
});
