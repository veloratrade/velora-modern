/*
 * Presentation formatters — ported from legacy `velora-localization.js`.
 * Semantics preserved:
 *  - digits always Latin (numberingSystem: 'latn' + latinDigits pass)
 *  - non-finite values render as '—'
 *  - naive "YYYY-MM-DD HH:mm" wall-clock strings are NEVER treated as UTC
 *    instants; they are formatted verbatim via dateWall()
 */
import { latinDigits } from './latinDigits';
import { localeMeta, type LocaleCode } from './registry';

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function key(kind: string, locale: string, options: object): string {
  const ordered = Object.keys(options)
    .sort()
    .map((k) => `${k}:${String((options as Record<string, unknown>)[k])}`)
    .join('|');
  return `${kind}|${locale}|${ordered}`;
}

function numberFormatter(locale: LocaleCode, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const intl = localeMeta(locale).intlLocale;
  const opts = { ...options, numberingSystem: 'latn' } as Intl.NumberFormatOptions;
  const k = key('n', intl, opts);
  let f = cache.get(k) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(intl, opts);
    cache.set(k, f);
  }
  return f;
}

function dateFormatter(locale: LocaleCode, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const intl = localeMeta(locale).intlLocale;
  const opts = { ...options, numberingSystem: 'latn' } as Intl.DateTimeFormatOptions;
  const k = key('d', intl, opts);
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(intl, opts);
    cache.set(k, f);
  }
  return f;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtNumber(locale: LocaleCode, value: unknown, options: Intl.NumberFormatOptions = {}): string {
  const n = finite(value);
  return n === null ? '—' : latinDigits(numberFormatter(locale, options).format(n));
}

export function fmtCurrency(
  locale: LocaleCode,
  value: unknown,
  currency = 'USD',
  options: Intl.NumberFormatOptions = {},
): string {
  const n = finite(value);
  if (n === null) return '—';
  return latinDigits(
    numberFormatter(locale, {
      style: 'currency',
      currency: String(currency || 'USD').toUpperCase(),
      currencyDisplay: 'narrowSymbol',
      ...options,
    }).format(n),
  );
}

export function fmtPercent(locale: LocaleCode, value: unknown, options: Intl.NumberFormatOptions = {}): string {
  const n = finite(value);
  return n === null
    ? '—'
    : latinDigits(numberFormatter(locale, { style: 'percent', maximumFractionDigits: 1, ...options }).format(n));
}

/** Canonical instants ONLY (explicit Z or offset). Naive SQL strings → null. */
export function dateValue(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (!value) return null;
  const input = String(value).trim();
  if (/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(input) && !/(Z$|[+-]\d{2}:?\d{2}$)/i.test(input)) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Legacy/naive wall-clock, displayed verbatim (UTC fields, no offset applied). */
export function dateWall(locale: LocaleCode, value: unknown, options: Intl.DateTimeFormatOptions = {}): string {
  if (value == null) return '—';
  const s = String(value).trim().replace('T', ' ');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return '—';
  const dateOnly = !m[4];
  const intl = locale === 'fa' ? 'fa-IR-u-nu-latn' : 'en-US-u-nu-latn';
  const opts: Intl.DateTimeFormatOptions = dateOnly
    ? { year: 'numeric', month: '2-digit', day: '2-digit' }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...options };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
  try {
    return latinDigits(new Intl.DateTimeFormat(intl, { timeZone: 'UTC', numberingSystem: 'latn', ...opts }).format(d));
  } catch {
    return s.slice(0, dateOnly ? 10 : 16);
  }
}

export function fmtDate(locale: LocaleCode, value: unknown, options?: Intl.DateTimeFormatOptions): string {
  const d = dateValue(value);
  return d ? latinDigits(dateFormatter(locale, options ?? { dateStyle: 'medium' }).format(d)) : '—';
}

export function fmtDateTime(locale: LocaleCode, value: unknown, options?: Intl.DateTimeFormatOptions): string {
  const d = dateValue(value);
  return d
    ? latinDigits(dateFormatter(locale, options ?? { dateStyle: 'medium', timeStyle: 'short' }).format(d))
    : '—';
}

/** Trade time: canonical UTC instant first, else legacy wall string. */
export function fmtTradeDate(
  locale: LocaleCode,
  canonicalUtc: unknown,
  legacyWall: unknown,
  options?: Intl.DateTimeFormatOptions,
): string {
  const d = dateValue(canonicalUtc);
  if (d) return latinDigits(dateFormatter(locale, options ?? { dateStyle: 'medium' }).format(d));
  return dateWall(locale, legacyWall, options);
}

export function fmtRelative(locale: LocaleCode, value: unknown, base?: unknown): string {
  const target = dateValue(value);
  const origin = dateValue(base) ?? new Date();
  if (!target) return '—';
  const seconds = Math.round((target.getTime() - origin.getTime()) / 1000);
  const abs = Math.abs(seconds);
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  let divisor = 1;
  if (abs >= 31536000) { unit = 'year'; divisor = 31536000; }
  else if (abs >= 2592000) { unit = 'month'; divisor = 2592000; }
  else if (abs >= 604800) { unit = 'week'; divisor = 604800; }
  else if (abs >= 86400) { unit = 'day'; divisor = 86400; }
  else if (abs >= 3600) { unit = 'hour'; divisor = 3600; }
  else if (abs >= 60) { unit = 'minute'; divisor = 60; }
  const intl = localeMeta(locale).intlLocale;
  const k = key('r', intl, { numeric: 'auto' });
  let f = cache.get(k) as Intl.RelativeTimeFormat | undefined;
  if (!f) {
    f = new Intl.RelativeTimeFormat(intl, { numeric: 'auto' });
    cache.set(k, f);
  }
  return latinDigits(f.format(Math.round(seconds / divisor), unit));
}
