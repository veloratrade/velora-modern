'use client';
import { useCallback } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
/** Money/number formatting rules shared by dashboard widgets (2-decimal signed PnL). */
export function usePnlFormat() {
  const { number, currency } = useI18n();
  const fmt = useCallback((n: unknown, d?: number) => number(n, { minimumFractionDigits: d || 0, maximumFractionDigits: d === 0 ? 0 : (d || 2) }), [number]);
  const fmtPnl = useCallback((n: unknown, cur?: string | null) => {
    const v = Number(n || 0);
    return { text: currency(v, cur || 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'always' }), pos: v >= 0 };
  }, [currency]);
  return { fmt, fmtPnl };
}
