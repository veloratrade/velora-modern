/*
 * Account-surface rendering guard — Phase 1 (`/profile` + `/settings`).
 *
 * WHY THIS FILE EXISTS. The two new account sections are pure UI over endpoints
 * that already existed, so the failure mode that matters is not the API: it is a
 * key that silently falls back, a Persian string that arrives corrupted, or a
 * locale that renders only in English. This test therefore does NOT keep a
 * hand-written list of keys — it READS the two components' source, extracts every
 * translation key they actually call `t()` with (plus the email-category map, whose
 * keys are looked up indirectly), and drives the REAL translator the components use
 * (`createTranslator(locale, ["common","errors","settings"])`) for each of them.
 * A key that is added to the UI without being added to both catalogs fails here.
 *
 * It also pins three things the migration deliberately decided:
 *   * the password-policy sentence states the REAL Modern number (10), not Legacy's 8;
 *   * the connected-accounts (Telegram) surface is still referenced by the settings
 *     page — the Phase 1 change was additive, and this asserts nothing was removed;
 *   * `fmtDateLong` renders Jalali for fa with Latin digits, and "—" for rubbish.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CATALOG_FILES, createTranslator, messagesFor } from "./catalog.js";
import { fmtDateLong } from "./format.js";
import type { Feature } from "./catalog.js";
import type { Locale } from "../contracts/locale.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "app", "(app)");

const LOCALES: readonly Locale[] = ["fa", "en"];

/**
 * The catalogs each component loads — the SAME sets their `createTranslator`
 * calls pass, so the test cannot "fix" a missing key by loading a catalog the
 * component never asks for. `/settings` is the Telegram surface
 * (common+errors+telegram); the Phase 1 sections and `/profile` use the new
 * settings catalog.
 */
const SOURCES = [
  { file: "profile/page.tsx", features: ["common", "errors", "settings"] },
  { file: "settings/AccountSettingsSections.tsx", features: ["common", "errors", "settings"] },
  { file: "settings/page.tsx", features: ["common", "errors", "telegram", "settings"] },
] as const satisfies readonly { file: string; features: readonly Feature[] }[];

function source(rel: string): string {
  return readFileSync(join(APP, rel), "utf8");
}

/** Every literal key the component passes to `t(...)`. */
function literalKeys(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) out.add(m[1]!);
  return [...out];
}

/** Keys referenced indirectly (the email-category label map). */
function mappedKeys(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/"(settings\.email\.[A-Za-z]+)"/g)) out.add(m[1]!);
  return [...out];
}

/** Per source: the keys IT renders, and the catalogs IT loads. */
const SOURCE_KEYS = SOURCES.map((s) => ({
  file: s.file,
  features: s.features,
  keys: [...new Set([...literalKeys(source(s.file)), ...mappedKeys(source(s.file))])],
}));
const KEYS: string[] = [...new Set(SOURCE_KEYS.flatMap((s) => s.keys))];

const ARABIC_SCRIPT = /[\u0600-\u06FF]/;
const ZWNJ = "\u200c";
const CORRUPTION = ["\uFFFD", "Ã", "Â", "Ø", "Ù", "ð", "\\u", "&amp;"];

test("the account components actually call t() with keys (guard against an empty scan)", () => {
  assert.ok(KEYS.length >= 25, `expected the account surface to use a real key set, found ${KEYS.length}`);
  for (const must of ["settings.section.security", "settings.section.preferences", "auth.emailPreferences", "profile.changePassword"]) {
    assert.ok(KEYS.includes(must), `${must} is no longer rendered by the account surface`);
  }
});

test("every key the account surface renders resolves to its own string in BOTH locales", () => {
  for (const source of SOURCE_KEYS) {
    assert.ok(source.keys.length > 0, `${source.file}: no translation keys found — the scan is broken`);
    for (const locale of LOCALES) {
      const t = createTranslator(locale, source.features);
      const catalog = messagesFor(locale, source.features);
      for (const key of source.keys) {
        // "MISSING" is the sentinel: if the key were absent from EVERY catalog this
        // component loads, the translator answers with the sentinel. A real value
        // therefore proves the key exists in the catalogs this screen actually uses.
        assert.notEqual(t(key, null, "MISSING"), "MISSING", `${locale}: ${key} (${source.file}) has no catalog entry`);
        assert.notEqual(t(key, null, "MISSING").trim(), "", `${locale}: ${key} (${source.file}) is empty`);
        if (typeof catalog[key] === "string") {
          for (const bad of CORRUPTION) {
            assert.ok(!catalog[key]!.includes(bad), `${locale}:${key} contains ${JSON.stringify(bad)} — corrupt or escaped text`);
          }
        }
      }
    }
  }
});

test("the settings catalogs are key-for-key identical and non-trivial", () => {
  const fa = Object.keys(CATALOG_FILES.fa.settings.messages).sort();
  const en = Object.keys(CATALOG_FILES.en.settings.messages).sort();
  assert.deepEqual(fa, en, "fa/en settings catalogs must carry the same keys");
  assert.ok(fa.length >= 45, `expected the settings catalog to stay complete, found ${fa.length}`);
});

test("Persian copy is Persian and English copy is not — checked on the RENDERED values", () => {
  const fa = CATALOG_FILES.fa.settings.messages;
  const en = CATALOG_FILES.en.settings.messages;
  for (const [key, value] of Object.entries(fa)) {
    if (/^(Velora|Telegram)$/.test(value)) continue;
    assert.ok(
      ARABIC_SCRIPT.test(value) || /^[\s\d{}:.,!?%‑–—-]*$/.test(value),
      `fa:${key} has no Persian text: ${JSON.stringify(value)}`,
    );
  }
  for (const [key, value] of Object.entries(en)) {
    assert.ok(!ARABIC_SCRIPT.test(value), `en:${key} contains Persian text: ${JSON.stringify(value)}`);
  }
});

test("ZWNJ survives resolution — and is not INVENTED where Legacy had none", () => {
  // These four carry ZWNJ in the source catalog @edede31 and must still carry it:
  // «غیرفعال‌سازی», «فعال‌سازی…», the AI-consent description's compounds, and
  // «نشست‌ها» in the password-changed sentence. A lossy paste strips ZWNJ and the
  // word reads wrong to a Persian reader, which source inspection alone misses.
  const mustKeepZwnj = ["profile.aiConsent.deactivate", "profile.aiConsent.activate", "profile.aiConsent.description", "profile.passwordChanged"];
  const t = createTranslator("fa", ["common", "errors", "settings"]);
  for (const key of mustKeepZwnj) {
    assert.ok(t(key, null, "").includes(ZWNJ), `${key} lost its ZWNJ: ${JSON.stringify(t(key, null, ""))}`);
  }
  // …and the state pills must NOT gain one: Legacy wrote 'غیرفعال' for pillOff, and
  // "fixing" the copy here would silently diverge from the source catalog.
  assert.equal(t("profile.aiConsent.pillOff", null, ""), "غیرفعال", "pillOff must stay the Legacy string");
  assert.equal(t("profile.aiConsent.pillOn", null, ""), "فعال", "pillOn must stay the Legacy string");
});

test("the password-policy sentence states the policy the SERVER enforces (10), not Legacy's 8", () => {
  // DELIBERATE, DOCUMENTED DIVERGENCE. Legacy's copy said 8 because Legacy's server
  // accepted 8; Modern's passwordSchema requires 10, so the UI must not promise a
  // rule the API would reject. If someone "restores Legacy wording" with the number
  // 8, this test fails and the reason is in the message.
  for (const locale of LOCALES) {
    const t = createTranslator(locale, ["common", "errors", "settings"]);
    const text = t("profile.passwordTooShort", null, "");
    assert.match(text, /10/, `${locale}: the policy sentence must state the real minimum (10)`);
    assert.ok(!/\b8\b/.test(text), `${locale}: the policy sentence must not claim Legacy's 8: ${JSON.stringify(text)}`);
  }
});

test("the settings page still hosts the connected-accounts (Telegram) surface — additive change", () => {
  const src = source("settings/page.tsx");
  for (const key of [
    "telegram.section.connectedAccounts",
    "telegram.settings.title",
    "telegram.connect",
    "telegram.unlink",
    "telegram.channel.title",
    "telegram.state.connected",
    "telegram.state.disconnected",
  ]) {
    assert.ok(src.includes(`"${key}"`), `settings/page.tsx no longer references ${key} — a capability was removed`);
  }
  assert.ok(src.includes("AccountSettingsSections"), "settings/page.tsx must render the new account sections");
});

test("profile is a read-only overview: it reads /auth/me and does not write", () => {
  const src = source("profile/page.tsx");
  assert.ok(src.includes("getMe"), "profile must read the identity from GET /api/v1/auth/me");
  for (const write of ["changePassword", "updatePreferences", "updateEmailPreferences", "method: \"POST\"", "method: \"PUT\"", "method: \"PATCH\""]) {
    assert.ok(!src.includes(write), `profile page must not ${write} — management belongs to /settings`);
  }
});

test("fmtDateLong: Jalali + Latin digits for fa, English month for en, em dash for rubbish", () => {
  const iso = "2026-01-15T10:00:00.000Z";
  const fa = fmtDateLong("fa", iso);
  const en = fmtDateLong("en", iso);
  assert.ok(!/[\u06F0-\u06F9]/.test(fa), `fa date must render Latin digits: ${JSON.stringify(fa)}`);
  assert.match(fa, /1404/, `fa date must be the Jalali year: ${JSON.stringify(fa)}`);
  assert.match(en, /2026/, `en date must carry the Gregorian year: ${JSON.stringify(en)}`);
  assert.ok(/January/.test(en), `en date must render an English month: ${JSON.stringify(en)}`);
  assert.equal(fmtDateLong("fa", "not-a-date"), "—");
  assert.equal(fmtDateLong("en", ""), "—");
});
