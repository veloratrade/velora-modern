'use client';
/*
 * Port of legacy public/assets/symbol-icons.js (VeloraSymbols).
 * Registry: /assets/symbols/symbols.json (copied verbatim). Icon paths in the
 * registry are `assets/symbols/...`, served from web/public/assets/symbols.
 */
import React, { useEffect, useState } from 'react';

interface RegistryEntry { name?: string; icon?: string; type?: string }
type Registry = Record<string, RegistryEntry>;

let registry: Registry | null = null;
let registryPromise: Promise<Registry> | null = null;
const listeners = new Set<() => void>();

const COLORS: Record<string, string> = {
  BTC: '#F7931A', ETH: '#627EEA', USDT: '#26A17B', BNB: '#F3BA2F', SOL: '#9945FF',
  XRP: '#23292F', ADA: '#0033AD', DOGE: '#C2A633', TRX: '#EF0027', AVAX: '#E84142',
  DOT: '#E6007A', MATIC: '#8247E5', LINK: '#2A5ADA', LTC: '#345D9D', BCH: '#8DC351',
  ATOM: '#2E3148', XLM: '#7D6FEA', UNI: '#FF007A', AAVE: '#B6509E', NEAR: '#00EC97',
  ICP: '#29ABE2', XAU: '#D4AF37', XAG: '#C0C0C0', XPT: '#E5E4E2', XPD: '#A9B4C2', OIL: '#2C3E50', COPPER: '#B87333',
  NAS100: '#0E5CAD', SPX500: '#7C3AED', US30: '#DC2626', GER40: '#DC2626',
  EURUSD: '#005BBB', GBPUSD: '#005BBB', USDJPY: '#E60012',
};
const CCY_FLAG: Record<string, string> = {
  EUR: 'eu', USD: 'us', GBP: 'gb', JPY: 'jp', CHF: 'ch', AUD: 'au', CAD: 'ca', NZD: 'nz',
  CNH: 'cn', CNY: 'cn', HKD: 'hk', SGD: 'sg', TRY: 'tr', ZAR: 'za', MXN: 'mx',
  NOK: 'no', SEK: 'se', PLN: 'pl', HUF: 'hu', CZK: 'cz', ILS: 'il',
};
const CCY_COUNTRY_FA: Record<string, string> = {
  EUR: 'اروپا', USD: 'آمریکا', GBP: 'بریتانیا', JPY: 'ژاپن', CHF: 'سوئیس',
  AUD: 'استرالیا', CAD: 'کانادا', NZD: 'نیوزیلند', CNH: 'چین', CNY: 'چین',
  HKD: 'هنگ‌کنگ', SGD: 'سنگاپور', TRY: 'ترکیه', ZAR: 'آفریقای جنوبی',
  MXN: 'مکزیک', NOK: 'نروژ', SEK: 'سوئد', PLN: 'لهستان', HUF: 'مجارستان',
  CZK: 'چک', ILS: 'اسرائیل',
};
const CCY_COUNTRY_EN: Record<string, string> = {
  EUR: 'Eurozone', USD: 'United States', GBP: 'United Kingdom', JPY: 'Japan', CHF: 'Switzerland',
  AUD: 'Australia', CAD: 'Canada', NZD: 'New Zealand', CNH: 'China', CNY: 'China',
  HKD: 'Hong Kong', SGD: 'Singapore', TRY: 'Turkey', ZAR: 'South Africa',
  MXN: 'Mexico', NOK: 'Norway', SEK: 'Sweden', PLN: 'Poland', HUF: 'Hungary',
  CZK: 'Czechia', ILS: 'Israel',
};
const METAL_ICON: Record<string, string> = {
  XAU: '/assets/symbols/metal/XAU.png', XAG: '/assets/symbols/metal/XAG.png',
  XPT: '/assets/symbols/metal/XPT.png', XPD: '/assets/symbols/metal/XPD.png',
};
const METAL_NAME_FA: Record<string, string> = {
  XAU: 'طلا', XAG: 'نقره', XPT: 'پلاتین', XPD: 'پالادیوم',
  XAUUSD: 'طلا / آمریکا', XAGUSD: 'نقره / آمریکا', XPTUSD: 'پلاتین / آمریکا', XPDUSD: 'پالادیوم / آمریکا',
};
const METAL_NAME_EN: Record<string, string> = {
  XAU: 'Gold', XAG: 'Silver', XPT: 'Platinum', XPD: 'Palladium',
  XAUUSD: 'Gold / United States', XAGUSD: 'Silver / United States',
  XPTUSD: 'Platinum / United States', XPDUSD: 'Palladium / United States',
};

export function loadSymbolRegistry(): Promise<Registry> {
  if (registry) return Promise.resolve(registry);
  if (registryPromise) return registryPromise;
  registryPromise = fetch('/assets/symbols/symbols.json', { cache: 'no-store' })
    .then((r) => r.json())
    .then((data: Registry) => { registry = data || {}; return registry; })
    .catch(() => { registry = {}; return registry; })
    .then((r) => { listeners.forEach((fn) => fn()); return r; });
  return registryPromise;
}
/** Re-render hook: resolves once the registry has loaded. */
export function useSymbolRegistry(): boolean {
  const [loaded, setLoaded] = useState(!!registry);
  useEffect(() => {
    const fn = () => setLoaded(true);
    listeners.add(fn);
    void loadSymbolRegistry();
    return () => { listeners.delete(fn); };
  }, []);
  return loaded;
}

export function base(symbol: unknown): string { return String(symbol || '').split('/')[0].trim().toUpperCase(); }
export function full(symbol: unknown): string { return String(symbol || '').replace(/\//g, '').trim().toUpperCase(); }
function pairParts(symbol: unknown): [string, string] | null {
  const raw = full(symbol);
  return raw.length >= 6 ? [raw.slice(0, 3), raw.slice(3, 6)] : null;
}
function metalKey(symbol: unknown): string {
  const b = base(symbol), f = full(symbol);
  if (METAL_ICON[b]) return b;
  const parts = pairParts(symbol);
  if (parts && METAL_ICON[parts[0]]) return parts[0];
  if (METAL_ICON[f]) return f;
  return '';
}
export function displayCode(symbol: unknown): string {
  const mk = metalKey(symbol);
  const parts = pairParts(symbol);
  if (mk && parts && parts[1]) return mk + parts[1];
  if (mk) return mk;
  if (parts && CCY_FLAG[parts[0]] && CCY_FLAG[parts[1]]) return parts[0] + parts[1];
  const f = full(symbol);
  return f || base(symbol);
}
function countryNameOf(symbol: unknown, fa: boolean): string {
  const parts = pairParts(symbol);
  const map = fa ? CCY_COUNTRY_FA : CCY_COUNTRY_EN;
  if (parts && map[parts[0]] && map[parts[1]]) return map[parts[0]] + ' / ' + map[parts[1]];
  return '';
}
export function nameOf(symbol: unknown, locale: string): string {
  const fa = locale.toLowerCase().indexOf('fa') === 0;
  const names = fa ? METAL_NAME_FA : METAL_NAME_EN;
  const mk = metalKey(symbol);
  const f = full(symbol);
  if (names[f]) return names[f];
  if (mk && names[mk]) return names[mk];
  const countries = countryNameOf(symbol, fa);
  if (countries) return countries;
  const b = base(symbol);
  if (registry && registry[b]) return registry[b].name || '';
  if (registry && registry[f]) return registry[f].name || '';
  return '';
}

function clampSize(size?: number) { return Number.isFinite(Number(size)) ? Math.max(8, Math.min(256, Number(size))) : 36; }

function Fallback({ symbol, size, color }: { symbol: string; size?: number; color?: string }) {
  const s = clampSize(size);
  const c = /^#[0-9A-Fa-f]{6}$/.test(String(color || '')) ? String(color) : (COLORS[symbol] || '#D4AF37');
  return (
    <span className="velora-sym" style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: s, height: s, borderRadius: '50%', flexShrink: 0,
      background: `linear-gradient(145deg,${c}26,${c}12)`, border: `1.5px solid ${c}55`, color: c, fontWeight: 800,
      fontSize: Math.round(s * 0.34), fontFamily: 'Arial,sans-serif',
    }}>{String(symbol).slice(0, 2)}</span>
  );
}

function hideOnError(e: React.SyntheticEvent<HTMLImageElement>) { (e.currentTarget as HTMLImageElement).style.display = 'none'; }

/** Port of `VeloraSymbols.icon(symbol, size)` */
export function SymbolIcon({ symbol, size }: { symbol: string; size?: number }) {
  const s = clampSize(size);
  const b = base(symbol), f = full(symbol);
  const c = COLORS[b] || COLORS[f] || '#D4AF37';
  const mk = metalKey(symbol);
  const metalSrc = mk ? METAL_ICON[mk] : '';
  const entry = registry ? (registry[f] || registry[b]) : null;
  const baseStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: s, height: s, borderRadius: '50%', flexShrink: 0, overflow: 'hidden' };
  const img: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: '50%' };

  if (metalSrc) {
    return (
      <span className="velora-sym" data-symbol={mk || b} style={{ ...baseStyle, background: '#070b14', boxShadow: '0 2px 8px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.08)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={metalSrc} alt={mk || b} style={img} onError={hideOnError} />
      </span>
    );
  }
  if (entry && entry.icon) {
    const iconPath = String(entry.icon).replace(/^assets\//, 'assets/');
    if (/^assets\/[A-Za-z0-9._/-]+$/.test(iconPath)) {
      return (
        <span className="velora-sym" data-symbol={b} style={{ ...baseStyle, background: 'linear-gradient(145deg,#141E33,#0C1424)', boxShadow: '0 2px 8px rgba(0,0,0,.35), inset 0 0 0 1px rgba(255,255,255,.07)' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={'/' + iconPath} alt={b} loading="lazy" style={img} onError={hideOnError} />
        </span>
      );
    }
    return <Fallback symbol={b} size={s} color={c} />;
  }
  const parts = pairParts(symbol);
  if (parts && CCY_FLAG[parts[0]] && CCY_FLAG[parts[1]]) {
    return (
      <span className="velora-sym velora-pair" data-symbol={f} style={{ ...baseStyle, position: 'relative', background: '#0b1220', boxShadow: '0 2px 8px rgba(0,0,0,.35), inset 0 0 0 1px rgba(252,227,138,.22)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" src={'/assets/symbols/forex/' + encodeURIComponent(f) + '.png'} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={hideOnError} />
      </span>
    );
  }
  return <Fallback symbol={b} size={s} color={c} />;
}
