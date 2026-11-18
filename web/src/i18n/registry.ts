/*
 * Locale registry — ported from legacy `public/assets/velora-locale-registry.js`
 * and `public/locales/manifest.json`. Values are identical; only the module
 * format changed.
 */
export type LocaleCode = 'fa' | 'en';
export type Direction = 'rtl' | 'ltr';

export interface LocaleMeta {
  intlLocale: string;
  name: string;
  nativeName: string;
  direction: Direction;
  enabled: boolean;
  numberingSystem: 'latn';
  script: string;
}

export const LOCALE_REGISTRY = Object.freeze({
  version: '2026.08.30.2',
  defaultLocale: 'fa' as LocaleCode,
  fallbackLocale: 'en' as LocaleCode,
  storageKey: 'velora.locale',
  cookieKey: 'velora_locale',
  locales: {
    fa: {
      intlLocale: 'fa-IR',
      name: 'Persian',
      nativeName: 'فارسی',
      direction: 'rtl',
      enabled: true,
      numberingSystem: 'latn',
      script: 'Arab',
    },
    en: {
      intlLocale: 'en-GB',
      name: 'English',
      nativeName: 'English',
      direction: 'ltr',
      enabled: true,
      numberingSystem: 'latn',
      script: 'Latn',
    },
  } as Record<LocaleCode, LocaleMeta>,
});

export const SUPPORTED_LOCALES: LocaleCode[] = ['fa', 'en'];

export function normalizeLocale(candidate: unknown): LocaleCode | null {
  const value = String(candidate ?? '')
    .trim()
    .replace('_', '-')
    .toLowerCase();
  if (!value) return null;
  if ((SUPPORTED_LOCALES as string[]).includes(value)) return value as LocaleCode;
  const base = value.split('-')[0];
  return (SUPPORTED_LOCALES as string[]).includes(base) ? (base as LocaleCode) : null;
}

export function localeMeta(code: LocaleCode): LocaleMeta {
  return LOCALE_REGISTRY.locales[code] ?? LOCALE_REGISTRY.locales[LOCALE_REGISTRY.fallbackLocale];
}

/** `lang` attribute exactly as legacy `updateDocument()` emits it. */
export function htmlLang(code: LocaleCode): string {
  const lang = localeMeta(code).intlLocale;
  return /^fa/i.test(lang) ? 'fa-IR-u-nu-latn' : lang;
}
