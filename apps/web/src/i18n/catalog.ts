/*
 * Message catalogs — ONE i18n system (Stage 1 §G). Feature-scoped JSON files in
 * `apps/web/messages/{fa,en}/<feature>.json`:
 *   common, errors, landing   byte copies of Legacy public/locales/chunks @edede31
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
import faAuth from "../../messages/fa/auth.json";
import faLanding from "../../messages/fa/landing.json";
import faLandingInteractive from "../../messages/fa/landing-interactive.json";
import enCommon from "../../messages/en/common.json";
import enErrors from "../../messages/en/errors.json";
import enAuth from "../../messages/en/auth.json";
import enLanding from "../../messages/en/landing.json";
import enLandingInteractive from "../../messages/en/landing-interactive.json";

export type Feature = "common" | "errors" | "auth" | "landing" | "landing-interactive";
export type Messages = Readonly<Record<string, string>>;

interface ChunkFile {
  readonly locale: string;
  readonly version: string;
  readonly feature: string;
  readonly messages: Messages;
}

export const CATALOG_FILES: Readonly<Record<Locale, Readonly<Record<Feature, ChunkFile>>>> = {
  fa: { common: faCommon, errors: faErrors, auth: faAuth, landing: faLanding, "landing-interactive": faLandingInteractive },
  en: { common: enCommon, errors: enErrors, auth: enAuth, landing: enLanding, "landing-interactive": enLandingInteractive },
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
