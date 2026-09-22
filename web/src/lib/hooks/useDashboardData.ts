'use client';
import { useCallback, useEffect, useState } from 'react';
import { request } from '@/lib/api/client';
import { normalizeTrade, normalizeAccount, type Trade, type Account } from '@/lib/api/normalize';
import type { EquityPoint } from '@/components/dashboard/EquityChart';

export interface Summary { tradeCount?: number | string; winRate?: number | string; totalPnl?: number | string; profitFactor?: number | string | null; equityCurve?: EquityPoint[] }
export interface Strategy { strategy?: string | null; tradeCount?: number | string; winRate?: number | string; pnl?: number | string }

/** Everything the dashboard shows, loaded in parallel; `reload()` = the Refresh action. */
export function useDashboardData() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [curve, setCurve] = useState<EquityPoint[]>([]);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [strategies, setStrategies] = useState<Strategy[] | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const loadAccounts = useCallback(async () => {
    const d = await request<{ accounts?: unknown[] }>('/api/v1/accounts');
    setAccounts((d.accounts || []).map(normalizeAccount));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      await Promise.all([
        request<{ summary?: Summary }>('/api/v1/dashboard/summary').then((d) => { const s = d.summary || {}; setSummary(s); setCurve(s.equityCurve || []); }),
        request<{ items?: unknown[] }>('/api/v1/trades?limit=6').then((d) => setTrades((d.items || []).map(normalizeTrade))),
        request<{ strategies?: Strategy[] }>('/api/v1/dashboard/strategies').then((d) => setStrategies(d.strategies || [])),
        loadAccounts(),
      ]);
    } catch (e) { setError(e); console.error('dashboard-load-failed', e); }
    setLoading(false);
  }, [loadAccounts]);

  const loadEquity = useCallback(async (days: string) => {
    const r = await request<{ equityCurve?: EquityPoint[] }>('/api/v1/dashboard/equity-curve?days=' + days);
    setCurve(r.equityCurve || []);
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  return { summary, curve, trades, strategies, accounts, error, loading, reload, loadAccounts, loadEquity };
}
