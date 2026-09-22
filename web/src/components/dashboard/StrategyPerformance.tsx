'use client';
import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import type { Strategy } from '@/lib/hooks/useDashboardData';
import { usePnlFormat } from '@/lib/hooks/usePnlFormat';

export function StrategyPerformance({ strategies }: { strategies: Strategy[] | null }) {
  const { t, percent } = useI18n();
  const { fmt, fmtPnl } = usePnlFormat();
  const list = strategies || [];
  const maxPnl = Math.max(0, ...list.map((x) => Math.abs(Number(x.pnl) || 0)));
  return (
    <div className="panel" style={{ marginBottom: 22 }}>
      <div className="panel-head"><div className="t"><svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 2l3 6 7 .5-5.5 5 1.5 7-6-3.5-6 3.5 1.5-7L2 8.5 9 8z" /></svg> <span>{t('pages.dashboard.strategy.performance.0633088a', null, 'عملکرد استراتژی‌ها')}</span></div></div>
      <div>
        {strategies && list.length === 0 && <div className="empty">{t('dashboard.empty')}</div>}
        {list.map((st, i) => {
          const pct = maxPnl > 0 ? Math.max(8, Math.abs(Number(st.pnl) || 0) / maxPnl * 100) : 8; // bar relative to best strategy, min 8%
          return (
            <div className="strat-item" key={i}>
              <div className="strat-top"><b>{st.strategy || t('dashboard.noStrategy')}</b><span data-value-type="currency">{fmtPnl(st.pnl).text}</span></div>
              <div className="strat-bar"><div className="strat-fill" style={{ width: pct + '%' }} /></div>
              <div className="strat-meta"><span>{t('dashboard.tradeCount', { count: fmt(st.tradeCount || 0, 0) })}</span><span>{t('dashboard.winRate', { rate: percent(Number(st.winRate || 0), { maximumFractionDigits: 0 }) })}</span></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
