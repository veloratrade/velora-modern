/*
 * Message catalogs — ONE i18n system (Stage 1 §G). Feature-scoped JSON files in
 * `apps/web/messages/{fa,en}/<feature>.json`:
 *   common, errors, landing   byte copies of Legacy public/locales/chunks @edede31
 *                             PLUS four keys lifted byte-faithfully from Legacy's
 *                             canonical public/locales/{fa,en}.json, which live in
 *                             NO Legacy chunk and had no Modern home: nav.accounts,
 *                             nav.logout, common.login.to.account.8181f948 and
 *                             pages.dashboard.are.you.sure.you.want.to.logout.16e6ca9b.
 *                             The shell (sidebar/top bar) needs them because it is
 *                             ONE component where Legacy had per-page chunks, and
 *                             `nav.accounts` was silently falling back to a
 *                             hard-coded Persian label inside the ENGLISH shell.
 *   landing-interactive       copy that Legacy hard-coded in velora-how-modals.js /
 *                             velora-product-gallery.js, moved into catalogs (provenance
 *                             recorded per file) so no translation is dropped.
 * Catalogs are imported statically and resolved on the server; only the strings a
 * client island needs are serialized to it.
 */
import type { Locale } from "../contracts";
import { LOCALE_REGISTRY } from "./registry";
import { interpolate } from "./latinDigits";
import faCommon from "../../messages/fa/common.json";
import faErrors from "../../messages/fa/errors.json";
import faTelegram from "../../messages/fa/telegram.json";
import faAuth from "../../messages/fa/auth.json";
import faLanding from "../../messages/fa/landing.json";
import faLandingInteractive from "../../messages/fa/landing-interactive.json";
import faSettings from "../../messages/fa/settings.json";
import faTrades from "../../messages/fa/trades.json";
import faDashboard from "../../messages/fa/dashboard.json";
import faSupport from "../../messages/fa/support.json";
import faAdmin from "../../messages/fa/admin.json";
import enCommon from "../../messages/en/common.json";
import enErrors from "../../messages/en/errors.json";
import enTelegram from "../../messages/en/telegram.json";
import enAuth from "../../messages/en/auth.json";
import enLanding from "../../messages/en/landing.json";
import enLandingInteractive from "../../messages/en/landing-interactive.json";
import enSettings from "../../messages/en/settings.json";
import enTrades from "../../messages/en/trades.json";
import enDashboard from "../../messages/en/dashboard.json";
import enSupport from "../../messages/en/support.json";
import enAdmin from "../../messages/en/admin.json";

// `settings` is the account surface's catalog (Phase 1 — profile + settings).
// PROVENANCE: 23 of its keys are byte copies of Legacy `public/locales/{fa,en}.json`
// @edede31 (auth.emailPreferences*, pages.profile.*, profile.aiConsent.*,
// profile.changePassword/changingPassword/passwordChanged/passwordFieldsRequired/
// saved/role.*). ONE value is a documented adaptation: `profile.passwordTooShort`
// keeps Legacy's sentence with the real Modern number (10), because the Modern
// password policy (passwordSchema min 10) is stricter than Legacy's 8 and the UI
// must not state a rule the server does not enforce. The remaining keys are
// authored (letter-prefixed `settings.*`) because Legacy PERSISTED the email
// preference API but shipped no interface copy for it.
// `support` is the Phase 5 ticket center. PROVENANCE: 34 of its 38 keys are byte
// copies of Legacy `public/locales/{fa,en}.json` @edede31 — Legacy shipped the
// v1.8 support UI's own words (`pages.support.*`: labels, placeholders, the four
// status names, the whose-turn badges, the empty/error strings and the four
// toasts), so the Modern screen reuses them instead of inventing copy. The
// remaining four keys are authored and letter-prefixed (`support.pageSub`,
// `support.replyRequired`, `support.subjectRequired`, `support.notAvailable`)
// because Legacy had no words for them. Server-side validation copy is NOT
// duplicated here: the page maps the API's error CODES onto the existing
// `errors.support.*` keys in the `errors` chunk.
// `admin` is the Phase 6 operator console. PROVENANCE: 119 of its 148 keys per
// locale are byte copies of Legacy `public/locales/{fa,en}.json` +
// `chunks/{fa,en}/admin.json` @edede31 — the console reuses Legacy's OWN admin
// vocabulary (`admin.user360.*`, `admin.analytics.*`, `admin.system.*`,
// `admin.security.*`, `admin.logs.*`) rather than paraphrasing it, so an operator
// coming from the Legacy panel reads the same labels, and a label can never drift
// from the capability it names. The other 29 are authored and letter-prefixed
// (`adminConsole.*`, plus `admin.status.active`, a status Legacy used but never
// labelled): the tab strip, the capability-absent wording, the two subsystems
// Legacy had no panel for (`component.migrations`, `component.rate_limiter`), and
// the values Legacy only had in an unnamespaced place (`accounts.balance`).
//
// The page ALSO reads keys from three sibling chunks through the same translator
// (`common.admin.41ae8044`, `errors.rateLimited`/`errors.unauthorized`, and the
// ticket words in `pages.support.*`). Those are deliberately NOT duplicated here:
// one string, one home. `apps/web/src/i18n/adminSurface.test.ts` proves that every
// key the page can render resolves in one of the four chunks it loads.
export type Feature = "common" | "errors" | "auth" | "landing" | "landing-interactive" | "telegram" | "settings" | "trades" | "dashboard" | "support" | "admin";
export type Messages = Readonly<Record<string, string>>;

interface ChunkFile {
  readonly locale: string;
  readonly version: string;
  readonly feature: string;
  readonly messages: Messages;
}

export const CATALOG_FILES: Readonly<Record<Locale, Readonly<Record<Feature, ChunkFile>>>> = {
  fa: { common: faCommon, errors: faErrors, auth: faAuth, landing: faLanding, "landing-interactive": faLandingInteractive, telegram: faTelegram, settings: faSettings, trades: faTrades, dashboard: faDashboard, support: faSupport, admin: faAdmin },
  en: { common: enCommon, errors: enErrors, auth: enAuth, landing: enLanding, "landing-interactive": enLandingInteractive, telegram: enTelegram, settings: enSettings, trades: enTrades, dashboard: enDashboard, support: enSupport, admin: enAdmin },
};

const merged = new Map<string, Messages>();

export function messagesFor(locale: Locale, features: readonly Feature[]): Messages {
  const k = `${locale}|${features.join(",")}`;
  let m = merged.get(k);
  if (!m) {
    const acc: Record<string, string> = {};
    for (const f of features) Object.assign(acc, CATALOG_FILES[locale][f].messages);
    m = Object.freeze(acc);
    merged.set(k, m);
  }
  return m;
}

export type Translate = (key: string, params?: Readonly<Record<string, unknown>> | null, fallback?: string) => string;

/** Legacy `t()` semantics: current locale → fallback locale (en) → key/fallback; Latin digits always. */
export function createTranslator(locale: Locale, features: readonly Feature[]): Translate {
  const primary = messagesFor(locale, features);
  const fallback = messagesFor(LOCALE_REGISTRY.fallbackLocale, features);
  return (key, params, fb) => {
    const msg = Object.prototype.hasOwnProperty.call(primary, key)
      ? primary[key]
      : Object.prototype.hasOwnProperty.call(fallback, key)
        ? fallback[key]
        : undefined;
    return interpolate(msg ?? fb ?? key, params ?? null);
  };
}
