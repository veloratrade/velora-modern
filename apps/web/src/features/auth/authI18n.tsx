import { createTranslator, type Feature } from "../../i18n/catalog";
import type { Locale } from "../../contracts/locale";
import { htmlLang, localeMeta } from "../../i18n/registry";
import { headers } from "next/headers";

const AUTH_FEATURES: Feature[] = ["common", "errors", "auth"];

export async function authI18n(locale: Locale) {
  const t = createTranslator(locale, AUTH_FEATURES);
  const number = (v: unknown, o?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(htmlLang(locale), { ...o, numberingSystem: "latn" } as Intl.NumberFormatOptions).format(Number(v) || 0);
  const percent = (v: unknown, o?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(htmlLang(locale), { style: "percent", ...o, numberingSystem: "latn" } as Intl.NumberFormatOptions).format(Number(v) || 0);

  return { t, number, percent, locale, direction: localeMeta(locale).direction };
}

export async function resolveLocale(): Promise<Locale> {
  const h = await headers();
  const raw = h.get("x-velora-locale") ?? h.get("X-VELORA-Locale") ?? "fa";
  return raw === "en" ? "en" : "fa";
}
