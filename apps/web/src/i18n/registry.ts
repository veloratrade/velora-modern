/*
 * Locale registry — the ONE owner of per-locale presentation metadata (Stage 1 §G).
 * Values are identical to Legacy `public/assets/velora-locale-registry.js`
 * (manifest version 2026.08.30.2). The locale *set* itself is owned by
 * @velora/contracts (`Locale`); this module only adds presentation facts.
 */
import type { Locale } from "../contracts";

export type Direction = "rtl" | "ltr";

export interface LocaleMeta {
  readonly intlLocale: string;
  readonly nativeName: string;
  readonly direction: Direction;
  /** Product rule: digits are always Latin 0-9 in every locale. */
  readonly numberingSystem: "latn";
}

export const LOCALE_REGISTRY = {
  version: "2026.08.30.2",
  defaultLocale: "fa" as Locale,
  fallbackLocale: "en" as Locale,
  storageKey: "velora.locale",
  cookieKey: "velora_locale",
  locales: {
    fa: { intlLocale: "fa-IR", nativeName: "فارسی", direction: "rtl", numberingSystem: "latn" },
    en: { intlLocale: "en-GB", nativeName: "English", direction: "ltr", numberingSystem: "latn" },
  } satisfies Record<Locale, LocaleMeta>,
} as const;

export const SUPPORTED_LOCALES: readonly Locale[] = ["fa", "en"];

export function normalizeLocale(candidate: unknown): Locale | null {
  const value = String(candidate ?? "").trim().replace("_", "-").toLowerCase();
  if (!value) return null;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(value)) return value as Locale;
  const base = value.split("-")[0] ?? "";
  return (SUPPORTED_LOCALES as readonly string[]).includes(base) ? (base as Locale) : null;
}

export function localeMeta(locale: Locale): LocaleMeta {
  return LOCALE_REGISTRY.locales[locale];
}

/**
 * Final `<html lang>` exactly as the Legacy runtime left it after
 * velora-localization.js + velora-latin-digits.js (`lockDocumentLocale`):
 * fa → "fa-IR-u-nu-latn", everything else → "en".
 */
export function htmlLang(locale: Locale): string {
  return locale === "fa" ? "fa-IR-u-nu-latn" : "en";
}

/** Home URL per ADR-009 URL contract ("/" = fa, "/en/" = en). */
export function homePath(locale: Locale): string {
  return locale === "fa" ? "/" : "/en/";
}
