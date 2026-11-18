'use client';
/* Performance metrics + monthly returns. Values are illustrative until wired to dashboard analytics (gap G5). */
import React from 'react';
import './legacy.css';
import { useI18n } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { StatCards } from '@/components/showcase/StatCards';

export default function PerformancePage() {
  const { t, percent, number } = useI18n();
  const months: [string, string, number][] = [
    ['pages.performance.farvardin.261921fc', 'فروردین', 0.054], ['pages.performance.ordibehesht.6633b4f0', 'اردیبهشت', 0.082], ['pages.performance.khordad.0e9bfab7', 'خرداد', 0.031],
    ['common.apr.3ef35c2f', 'تیر', 0.115], ['pages.performance.mordad.current.6ab685f6', 'مرداد (جاری)', 0.068],
  ];
  return (
    <div className="pg-performance">
      <AppShell topRight={<NewTradeLink />}>
        <StatCards cards={[
          { label: t('common.profit.factor.4f05d40f', null, 'Profit Factor'), value: number(2.14, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), color: '#fce38a' },
          { label: t('pages.performance.max.drawdown.b1dee77a', null, 'بیشترین Drawdown'), value: percent(0.042, { maximumFractionDigits: 1 }), color: '#3B82F6' },
          { label: t('pages.performance.total.win.rate.9294474a', null, 'نرخ برد کل (Win Rate)'), value: percent(0.667, { maximumFractionDigits: 1 }), color: '#4CD39A' },
        ]} />
        <section className="card panel" style={{ marginTop: 16 }}>
          <b style={{ fontSize: 16, color: '#fce38a' }}>{t('pages.performance.monthly.returns.and.risk.to.reward.metrics.e640980b', null, 'بازدهی ماهانه و معیارهای ریسک به ریوارد')}</b>
          <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
            {months.map(([k, fb, v]) => (
              <div className="sc-month" key={k}><small>{t(k, null, fb)}</small><br /><b>{percent(v, { signDisplay: 'always', maximumFractionDigits: 1 })}</b></div>
            ))}
          </div>
        </section>
      </AppShell>
    </div>
  );
}
