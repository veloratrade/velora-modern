'use client';
import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import type { Summary } from '@/lib/hooks/useDashboardData';
import { usePnlFormat } from '@/lib/hooks/usePnlFormat';

const icons = {
  trades: <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect height="9" rx="1.5" width="7" x="3" y="3" /><rect height="5" rx="1.5" width="7" x="14" y="3" /></svg>,
  win: <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>,
  pnl: <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>,
  pf: <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>,
};

function Kpi({ icon, label, value, style }: { icon: React.ReactNode; label: string; value: string; style?: React.CSSProperties }) {
  return <div className="kpi"><div className="lbl">{icon} <span>{label}</span></div><div className="val" style={style}>{value}</div></div>;
}

export function KpiStrip({ summary }: { summary: Summary | null }) {
  const { t, percent } = useI18n();
  const { fmt, fmtPnl } = usePnlFormat();
  const s = summary || {};
  const pnl = fmtPnl(s.totalPnl || 0);
  const has = !!summary;
  return (
    <div className="kpi-grid">
      <Kpi icon={icons.trades} label={t('common.trades.5aa84041', null, 'معاملات')} value={has ? fmt(s.tradeCount || 0, 0) : '—'} />
      <Kpi icon={icons.win} label={t('common.win.rate.f57b9504', null, 'نرخ برد')} value={has ? percent(Number(s.winRate || 0), { maximumFractionDigits: 1 }) : '—'} />
      <Kpi icon={icons.pnl} label={t('common.net.p.l.21997b05', null, 'سود خالص')} value={has ? pnl.text : '—'} style={has ? { color: pnl.pos ? 'var(--green)' : 'var(--red)' } : undefined} />
      <Kpi icon={icons.pf} label={t('common.profit.factor.4f05d40f', null, 'فاکتور سود')} value={has ? ((s.profitFactor === null || s.profitFactor === '') ? '∞' : fmt(s.profitFactor || 0, 2)) : '—'} />
    </div>
  );
}
