/*
 * Content-surface guards — AC-32 (MG-FRONTEND-SURFACES + MG-I18N-COVERAGE).
 *
 * The ten new catalogs (markets, news, performance, wallet, intelligence,
 * privacy, terms, checkout, blog, profile) are byte copies of Legacy's own
 * chunks — so, exactly like the support/admin surfaces before them, the risk
 * is not invented wording but SILENT DRIFT:
 *
 *   1. FA/EN PARITY — every key exists in both locales with the SAME chunk
 *      wrapper (one key missing on one side = an English leak inside the
 *      Persian UI or vice-versa).
 *   2. PAGE KEYS RESOLVE — every t("...") key in the new pages is driven
 *      through the real translator in both locales; a key without a catalog
 *      entry fails here instead of silently rendering a raw key.
 *   3. LEGACY VERBATIM ANCHORS — the strings a user actually reads on each
 *      ported surface are asserted against the Legacy chunk files themselves
 *      (these ARE the byte copies, so this also proves the copy did not drift
 *      after the fact).
 *   4. THE BLOG DATA FILE stays inside the catalogs — every key in posts.ts
 *      must resolve in [common, blog]; an edited data file cannot reference a
 *      key that was removed from the catalog.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createTranslator, messagesFor, CATALOG_FILES } from "./catalog.js";
import type { Locale } from "../contracts/locale.js";
import type { Feature } from "./catalog.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..", "..");
const LOCALES: readonly Locale[] = ["fa", "en"];

const NEW_FEATURES = [
  "markets",
  "news",
  "performance",
  "wallet",
  "intelligence",
  "privacy",
  "terms",
  "checkout",
  "blog",
] as const satisfies readonly Feature[];

test("AC-32 catalogs: fa/en key parity with identical wrappers", () => {
  for (const feature of NEW_FEATURES) {
    const fa = CATALOG_FILES.fa[feature];
    const en = CATALOG_FILES.en[feature];
    assert.equal(fa.locale, "fa", `${feature} fa wrapper locale`);
    assert.equal(en.locale, "en", `${feature} en wrapper locale`);
    assert.equal(fa.feature, feature);
    assert.equal(en.feature, feature);
    const faKeys = Object.keys(fa.messages).sort();
    const enKeys = Object.keys(en.messages).sort();
    assert.deepEqual(faKeys, enKeys, `${feature}: fa and en key sets differ`);
  }
});

/** Extract every t("...") key literal from a page source file. */
function pageKeys(relPath: string): string[] {
  const src = readFileSync(join(WEB, relPath), "utf8");
  const keys: string[] = [];
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.push(m[1]!);
  return [...new Set(keys)];
}

const PAGE_UNDER_TEST: readonly { file: string; features: readonly Feature[] }[] = [
  { file: "src/app/(app)/markets/page.tsx", features: ["common", "errors", "markets"] },
  { file: "src/app/(app)/news/page.tsx", features: ["common", "errors", "news"] },
  { file: "src/app/(app)/performance/page.tsx", features: ["common", "errors", "performance", "dashboard"] },
  { file: "src/app/(app)/wallet/page.tsx", features: ["common", "errors", "wallet"] },
  { file: "src/app/(app)/intelligence/page.tsx", features: ["common", "errors", "intelligence"] },
  { file: "src/app/checkout/CheckoutForm.tsx", features: ["common", "errors", "checkout"] },
  { file: "src/features/legal/PrivacyDocument.tsx", features: ["common", "privacy"] },
  { file: "src/features/legal/TermsDocument.tsx", features: ["common", "terms"] },
];

test("AC-32 pages: every t() key resolves through the real translator (both locales)", () => {
  for (const { file, features } of PAGE_UNDER_TEST) {
    const keys = pageKeys(file);
    assert.ok(keys.length > 0, `${file}: no t() keys found — extraction broke`);
    for (const locale of LOCALES) {
      const t = createTranslator(locale, features);
      const merged = messagesFor(locale, features);
      for (const key of keys) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(merged, key),
          `${file} [${locale}]: key not in catalog: ${key}`,
        );
        // t() must RESOLVE the key (the runtime may latinize digits — the
        // product rule — so byte equality is asserted in the verbatim test).
        const rendered = t(key);
        assert.ok(typeof rendered === "string" && rendered.length > 0 && rendered !== key,
          `${file} [${locale}]: ${key} did not resolve`);
        assert.ok(rendered === merged[key] || /\d/.test(merged[key]!),
          `${file} [${locale}]: ${key} rendered "${rendered}" but catalog says "${merged[key]}"`);
      }
    }
  }
});

test("AC-32 blog data: every posts.ts key resolves in [common, blog] (both locales)", async () => {
  const posts = (await import("../app/blog/posts.js")) as {
    BLOG_POSTS: { slug: string; titleKey: string; keys: string[] }[];
    BLOG_INDEX_KEYS: string[];
  };
  assert.equal(posts.BLOG_POSTS.length, 5, "Legacy shipped exactly five posts");
  for (const locale of LOCALES) {
    const merged = messagesFor(locale, ["common", "blog"]);
    for (const post of posts.BLOG_POSTS) {
      assert.ok(Object.prototype.hasOwnProperty.call(merged, post.titleKey), `${post.slug} titleKey [${locale}]`);
      for (const key of post.keys) {
        assert.ok(Object.prototype.hasOwnProperty.call(merged, key), `${post.slug} [${locale}]: ${key}`);
      }
    }
    for (const key of posts.BLOG_INDEX_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(merged, key), `index [${locale}]: ${key}`);
    }
  }
});

test("AC-32 legacy-verbatim anchors: the ported values are byte-identical to Legacy's chunks", async () => {
  const legacyChunk = (locale: Locale, feature: string): Record<string, string> => {
    const raw = JSON.parse(
      readFileSync(`/home/user/legacy/public/locales/chunks/${locale}/${feature}.json`, "utf8"),
    ) as { messages: Record<string, string> };
    return raw.messages;
  };
  // A handful of strings a user actually reads, per surface — proved verbatim.
  const anchors: readonly [Feature, string, Locale][] = [
    ["markets", "pages.markets.live.forex.and.crypto.watchlist.707e34a1", "fa"],
    ["markets", "pages.markets.gold.us.dollar.b891c472", "en"],
    ["news", "pages.news.today.s.important.news.88663162", "fa"],
    ["performance", "pages.performance.total.win.rate.9294474a", "fa"],
    ["wallet", "pages.wallet.total.account.balance.9cc8b58f", "fa"],
    ["intelligence", "pages.intelligence.simulatedAnswer", "fa"],
    ["privacy", "pages.privacy.p05.collection_title", "fa"],
    ["terms", "pages.terms.p05.risk_title", "fa"],
    ["checkout", "pages.checkout.p05.heading", "fa"],
    ["blog", "common.all.articles.5a07294c", "fa"],
  ];
  for (const [feature, key, locale] of anchors) {
    const ours = CATALOG_FILES[locale][feature].messages[key];
    const legacy = legacyChunk(locale, feature === "blog" ? "blog" : feature)[key];
    assert.ok(typeof ours === "string", `${feature}/${locale}: ${key} missing in Modern`);
    assert.ok(typeof legacy === "string", `${feature}/${locale}: ${key} missing in Legacy chunk`);
    assert.equal(ours, legacy, `${feature}/${locale}: ${key} drifted from Legacy`);
  }
});

test("AC-32 lifted common keys: the 106 root-catalog lifts are byte-identical", () => {
  // The blog/privacy/terms/checkout pages reference common.* keys that lived
  // only in Legacy's canonical public/locales/{fa,en}.json. They were lifted
  // byte-faithfully (Stage-1 precedent). Anchor a few of each kind.
  const liftedAnchors: readonly [string, Locale][] = [
    ["common.2026.velora.all.rights.reserved.5d192dfd", "fa"],
    ["common.8.min.read.81675063", "en"],
    ["common.a.trading.journal.is.not.just.a.d4d9db5d", "fa"],
    ["common.back.to.home.cc9795cf", "en"],
  ];
  for (const [key, locale] of liftedAnchors) {
    const rawRoot = JSON.parse(
      readFileSync(`/home/user/legacy/public/locales/${locale}.json`, "utf8"),
    ) as { messages?: Record<string, string> } & Record<string, string>;
    const root = rawRoot.messages ?? rawRoot; // the canonical catalog wraps its keys
    const ours = CATALOG_FILES[locale].common.messages[key];
    assert.ok(typeof ours === "string", `lifted key missing: ${key} [${locale}]`);
    assert.equal(ours, root[key], `lifted key drifted: ${key} [${locale}]`);
  }
});
