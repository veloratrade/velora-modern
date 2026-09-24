/*
 * Presentation formatters — semantics of Legacy `velora-localization.js`
 * (number/currency/percent/time/unit): Intl with numberingSystem "latn",
 * a Latin-digit pass, and "—" for non-finite input. Isomorphic.
 */
import type { Locale } from "../contracts";
import { toLatin } from "./latinDigits";
import { localeMeta } from "./registry";

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function cacheKey(kind: string, locale: string, options: object): string {
  const ordered = Object.keys(options)
    .sort()
    .map((k) => `${k}:${String((options as Record<string, unknown>)[k])}`)
    .join("|");
  return `${kind}|${locale}|${ordered}`;
}

function numberFormatter(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const intl = localeMeta(locale).intlLocale;
  const opts: Intl.NumberFormatOptions = { ...options, numberingSystem: "latn" };
  const k = cacheKey("n", intl, opts);
  let f = cache.get(k) as Intl.NumberFormat | undefined;
  if (!f) {
    f = new Intl.NumberFormat(intl, opts);
    cache.set(k, f);
  }
  return f;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtNumber(locale: Locale, value: unknown, options: Intl.NumberFormatOptions = {}): string {
  const n = finite(value);
  return n === null ? "—" : toLatin(numberFormatter(locale, options).format(n));
}

export function fmtCurrency(locale: Locale, value: unknown, currency = "USD", options: Intl.NumberFormatOptions = {}): string {
  const n = finite(value);
  if (n === null) return "—";
  return toLatin(
    numberFormatter(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
      ...options,
    }).format(n),
  );
}

export function fmtPercent(locale: Locale, value: unknown, options: Intl.NumberFormatOptions = {}): string {
  const n = finite(value);
  return n === null ? "—" : toLatin(numberFormatter(locale, { style: "percent", maximumFractionDigits: 1, ...options }).format(n));
}

/** Wall-clock "HH:mm" (no timezone semantics — Legacy `time()` with UTC fields). */
export function fmtTime(locale: Locale, value: string, options: Intl.DateTimeFormatOptions = {}): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return "—";
  const d = new Date(Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2])));
  const intl = localeMeta(locale).intlLocale;
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone: "UTC", ...options, numberingSystem: "latn" };
  const k = cacheKey("t", intl, opts);
  let f = cache.get(k) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f = new Intl.DateTimeFormat(intl, opts);
    cache.set(k, f);
  }
  return toLatin(f.format(d));
}

export type FormatKind = "number" | "currency" | "percent" | "time";

/** Declarative formatting used by markup that Legacy tagged with data-format. */
export function formatValue(
  locale: Locale,
  kind: FormatKind,
  value: string,
  options: Intl.NumberFormatOptions = {},
  currency = "USD",
): string {
  switch (kind) {
    case "number":
      return fmtNumber(locale, value, options);
    case "currency":
      return fmtCurrency(locale, value, currency, options);
    case "percent":
      return fmtPercent(locale, value, options);
    case "time":
      return fmtTime(locale, value);
  }
}
