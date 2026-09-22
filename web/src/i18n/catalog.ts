/*
 * Feature-scoped message catalogs — same chunk files as legacy
 * `public/locales/chunks/{fa,en}/<feature>.json` (copied verbatim into
 * `web/messages`). Loaded lazily per feature to mirror `data-i18n-features`.
 */
import type { LocaleCode } from './registry';

export type Feature =
  | 'common'
  | 'errors'
  | 'auth'
  | 'dashboard'
  | 'trades'
  | 'profile'
  | 'markets'
  | 'news'
  | 'performance'
  | 'wallet'
  | 'intelligence';

export type Messages = Record<string, string>;

interface ChunkFile {
  locale: string;
  version: string;
  feature: string;
  messages: Messages;
}

const loaders: Record<LocaleCode, Record<Feature, () => Promise<{ default: ChunkFile }>>> = {
  fa: {
    common: () => import('../../messages/fa/common.json'),
    errors: () => import('../../messages/fa/errors.json'),
    auth: () => import('../../messages/fa/auth.json'),
    dashboard: () => import('../../messages/fa/dashboard.json'),
    trades: () => import('../../messages/fa/trades.json'),
    profile: () => import('../../messages/fa/profile.json'),
    markets: () => import('../../messages/fa/markets.json'),
    news: () => import('../../messages/fa/news.json'),
    performance: () => import('../../messages/fa/performance.json'),
    wallet: () => import('../../messages/fa/wallet.json'),
    intelligence: () => import('../../messages/fa/intelligence.json'),
  },
  en: {
    common: () => import('../../messages/en/common.json'),
    errors: () => import('../../messages/en/errors.json'),
    auth: () => import('../../messages/en/auth.json'),
    dashboard: () => import('../../messages/en/dashboard.json'),
    trades: () => import('../../messages/en/trades.json'),
    profile: () => import('../../messages/en/profile.json'),
    markets: () => import('../../messages/en/markets.json'),
    news: () => import('../../messages/en/news.json'),
    performance: () => import('../../messages/en/performance.json'),
    wallet: () => import('../../messages/en/wallet.json'),
    intelligence: () => import('../../messages/en/intelligence.json'),
  },
};

const loaded: Record<LocaleCode, Set<Feature>> = { fa: new Set(), en: new Set() };
const catalogs: Record<LocaleCode, Messages> = { fa: {}, en: {} };

export async function loadFeatures(locale: LocaleCode, features: Feature[]): Promise<Messages> {
  await Promise.all(
    features.map(async (feature) => {
      if (loaded[locale].has(feature)) return;
      const mod = await loaders[locale][feature]();
      Object.assign(catalogs[locale], mod.default.messages);
      loaded[locale].add(feature);
    }),
  );
  return catalogs[locale];
}

export function lookup(locale: LocaleCode, key: string): string | undefined {
  const c = catalogs[locale];
  return Object.prototype.hasOwnProperty.call(c, key) ? c[key] : undefined;
}

export function hasFeatures(locale: LocaleCode, features: Feature[]): boolean {
  return features.every((f) => loaded[locale].has(f));
}
