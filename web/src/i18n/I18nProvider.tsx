'use client';
/*
 * Runtime localization — ported from legacy `velora-locale-bootstrap.js` +
 * `velora-localization.js`.
 *
 * Resolution order (legacy contract, minus the URL prefix which is deferred):
 *   1. cookie `velora_locale`  2. localStorage `velora.locale`
 *   3. primary browser language  4. registry default (fa)
 *
 * `html[lang|dir|data-locale|data-direction|data-numbering]` are kept in sync
 * exactly as legacy `updateDocument()` did. A pre-hydration inline script in
 * `app/layout.tsx` applies the same resolution before first paint so the
 * layout direction never flashes.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { LOCALE_REGISTRY, htmlLang, localeMeta, normalizeLocale, type Direction, type LocaleCode } from './registry';
import { hasFeatures, loadFeatures, lookup, type Feature } from './catalog';
import { interpolate } from './latinDigits';
import * as F from './format';

export interface I18n {
  locale: LocaleCode;
  direction: Direction;
  ready: boolean;
  t: (key: string, params?: Record<string, unknown> | null, fallback?: string) => string;
  /** Legacy `VeloraLocale.errorMessage(error, fallbackKey)` */
  errorMessage: (error: unknown, fallbackKey?: string) => string;
  /** Legacy `VeloraLocale.status(code)` → t('status.<code>', null, code) */
  status: (code: unknown) => string;
  setLocale: (locale: LocaleCode) => Promise<void>;
  /** Load extra message chunks for the current page (legacy `data-i18n-features`). */
  ensureFeatures: (features: Feature[]) => Promise<void>;
  number: (v: unknown, o?: Intl.NumberFormatOptions) => string;
  currency: (v: unknown, c?: string, o?: Intl.NumberFormatOptions) => string;
  percent: (v: unknown, o?: Intl.NumberFormatOptions) => string;
  date: (v: unknown, o?: Intl.DateTimeFormatOptions) => string;
  /** Legacy `VeloraLocale.dateWall` (naive wall-clock, no tz shift) */
  dateWall: (v: unknown, o?: Intl.DateTimeFormatOptions) => string;
  dateTime: (v: unknown, o?: Intl.DateTimeFormatOptions) => string;
  tradeDate: (utc: unknown, wall: unknown, o?: Intl.DateTimeFormatOptions) => string;
  relative: (v: unknown, base?: unknown) => string;
}

const Ctx = createContext<I18n | null>(null);

export function resolveInitialLocale(): LocaleCode {
  if (typeof document === 'undefined') return LOCALE_REGISTRY.defaultLocale;
  const declared = normalizeLocale(document.documentElement.getAttribute('data-locale'));
  if (declared) return declared;
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_REGISTRY.cookieKey}=([^;]*)`));
  const fromCookie = m ? normalizeLocale(decodeURIComponent(m[1])) : null;
  if (fromCookie) return fromCookie;
  try {
    const stored = normalizeLocale(window.localStorage.getItem(LOCALE_REGISTRY.storageKey));
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  const langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
  const browser = normalizeLocale(langs[0]);
  if (browser) return browser;
  return LOCALE_REGISTRY.defaultLocale;
}

function updateDocument(locale: LocaleCode): void {
  const meta = localeMeta(locale);
  const root = document.documentElement;
  root.lang = htmlLang(locale);
  root.dir = meta.direction;
  root.setAttribute('data-locale', locale);
  root.setAttribute('data-direction', meta.direction);
  root.setAttribute('data-numbering', 'latn');
  if (document.body) document.body.dir = meta.direction;
}

function persist(locale: LocaleCode): void {
  try {
    window.localStorage.setItem(LOCALE_REGISTRY.storageKey, locale);
    document.cookie = `${LOCALE_REGISTRY.cookieKey}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}

/** Optional hook so the auth layer can PATCH the saved preference (legacy R3). */
let persistRemote: ((locale: LocaleCode) => Promise<unknown>) | null = null;
export function registerRemoteLocalePersist(fn: ((locale: LocaleCode) => Promise<unknown>) | null): void {
  persistRemote = fn;
}

export function I18nProvider({
  features,
  children,
}: {
  features: Feature[];
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<LocaleCode>(LOCALE_REGISTRY.defaultLocale);
  const [ready, setReady] = useState(false);
  const [, bump] = useState(0);
  const [extra, setExtra] = useState<Feature[]>([]);
  const featureKey = features.join(',');
  const featuresRef = useRef(features);
  featuresRef.current = features;

  const extraRef = useRef(extra);
  extraRef.current = extra;
  const load = useCallback(async (next: LocaleCode) => {
    const wanted = Array.from(new Set<Feature>(['common', 'errors', ...featuresRef.current, ...extraRef.current]));
    await loadFeatures(next, wanted);
    if (next !== LOCALE_REGISTRY.fallbackLocale) await loadFeatures(LOCALE_REGISTRY.fallbackLocale, wanted);
  }, []);

  // Boot: adopt the pre-paint resolution and load catalogs.
  useEffect(() => {
    let cancelled = false;
    const initial = resolveInitialLocale();
    updateDocument(initial);
    setLocaleState(initial);
    load(initial).then(() => {
      if (cancelled) return;
      setReady(true);
      document.documentElement.setAttribute('data-velora-prelocalized', initial);
      document.documentElement.classList.remove('velora-locale-booting');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureKey]);

  // Legacy R2: adopt the signed-in user's saved locale when the session emits it.
  useEffect(() => {
    const onUserLocale = (e: Event) => {
      const wanted = normalizeLocale((e as CustomEvent<{ locale?: string }>).detail?.locale);
      if (wanted && wanted !== locale) void setLocale(wanted, { persist: false });
    };
    window.addEventListener('velora:user-locale', onUserLocale);
    return () => window.removeEventListener('velora:user-locale', onUserLocale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  const setLocale = useCallback(
    async (next: LocaleCode, opts: { persist?: boolean } = {}) => {
      updateDocument(next);
      if (opts.persist !== false) {
        persist(next);
        if (persistRemote) void persistRemote(next).catch(() => undefined);
      }
      await load(next);
      setLocaleState(next);
      bump((n) => n + 1);
      document.dispatchEvent(
        new CustomEvent('velora:locale-change', { detail: { locale: next, direction: localeMeta(next).direction } }),
      );
    },
    [load],
  );

  const ensure = useCallback(async (more: Feature[]) => {
    const missing = more.filter((f) => !hasFeatures(locale, [f]) || !hasFeatures(LOCALE_REGISTRY.fallbackLocale, [f]));
    setExtra((prev) => (more.every((f) => prev.includes(f)) ? prev : Array.from(new Set([...prev, ...more]))));
    if (!missing.length) return;
    await loadFeatures(locale, missing);
    if (locale !== LOCALE_REGISTRY.fallbackLocale) await loadFeatures(LOCALE_REGISTRY.fallbackLocale, missing);
    bump((n) => n + 1);
  }, [locale]);

  const value = useMemo<I18n>(() => {
    const t: I18n['t'] = (key, params, fallback) => {
      let msg = lookup(locale, key);
      if (msg === undefined) msg = lookup(LOCALE_REGISTRY.fallbackLocale, key);
      if (msg === undefined) msg = fallback === undefined ? key : fallback;
      return interpolate(msg, params);
    };
    const errorMessage: I18n['errorMessage'] = (payload, fallbackKey) => {
      const p = payload as { error?: Record<string, unknown> } & Record<string, unknown>;
      const error = (p && p.error ? p.error : p) as { messageKey?: string; params?: Record<string, unknown> } | null;
      const key = error && error.messageKey ? error.messageKey : fallbackKey || 'errors.unknown';
      const params = error && error.params ? error.params : null;
      const translated = t(key, params, '');
      if (translated) return translated;
      return t('errors.unknown', null, 'Something went wrong.');
    };
    return {
      locale,
      direction: localeMeta(locale).direction,
      errorMessage,
      status: (code) => t('status.' + String(code || 'unknown').toLowerCase(), null, String(code || '—')),
      ready: ready && hasFeatures(locale, ['common', 'errors']),
      t,
      setLocale: (l) => setLocale(l),
      ensureFeatures: ensure,
      number: (v, o) => F.fmtNumber(locale, v, o),
      currency: (v, c, o) => F.fmtCurrency(locale, v, c, o),
      percent: (v, o) => F.fmtPercent(locale, v, o),
      date: (v, o) => F.fmtDate(locale, v, o),
      dateWall: (v, o) => F.dateWall(locale, v, o),
      dateTime: (v, o) => F.fmtDateTime(locale, v, o),
      tradeDate: (u, w, o) => F.fmtTradeDate(locale, u, w, o),
      relative: (v, b) => F.fmtRelative(locale, v, b),
    };
  }, [locale, ready, setLocale, ensure]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/**
 * Inline pre-hydration script (string) — mirrors legacy bootstrap so `dir`
 * is right before first paint. Kept dependency-free on purpose.
 */
export const PRE_PAINT_LOCALE_SCRIPT = `(function(){try{var S=${JSON.stringify(
  LOCALE_REGISTRY.storageKey,
)},C=${JSON.stringify(LOCALE_REGISTRY.cookieKey)},L={fa:['fa-IR-u-nu-latn','rtl'],en:['en-GB','ltr']};
function n(v){v=String(v||'').trim().replace('_','-').toLowerCase();if(!v)return null;if(L[v])return v;var b=v.split('-')[0];return L[b]?b:null}
var m=document.cookie.match(new RegExp('(?:^|;\\\\s*)'+C+'=([^;]*)'));var r=null;
if(m){try{r=n(decodeURIComponent(m[1]))}catch(e){r=n(m[1])}}
if(!r){try{r=n(localStorage.getItem(S))}catch(e){}}
if(!r){var ls=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||''];r=n(ls[0])}
if(!r)r='fa';var d=document.documentElement;d.lang=L[r][0];d.dir=L[r][1];d.setAttribute('data-locale',r);d.setAttribute('data-direction',L[r][1]);d.setAttribute('data-numbering','latn');d.classList.add('velora-locale-booting');
setTimeout(function(){d.classList.remove('velora-locale-booting')},4000);}catch(e){}})();`;

/** Per-page chunk loading — mirrors legacy `<html data-i18n-features="...">`. */
export function useLocaleFeatures(features: Feature[]): void {
  const { ensureFeatures, locale } = useI18n();
  const key = features.join(',');
  useEffect(() => {
    void ensureFeatures(key.split(',').filter(Boolean) as Feature[]);
  }, [ensureFeatures, key, locale]);
}
