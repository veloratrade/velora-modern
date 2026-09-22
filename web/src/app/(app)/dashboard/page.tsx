'use client';
import React, { useState } from 'react';
import './legacy.css';
import '@/components/accounts/connectModal.css';
import { useI18n } from '@/i18n/I18nProvider';
import { useDashboardData } from '@/lib/hooks/useDashboardData';
import { useTimedMessage } from '@/lib/hooks/useTimedFlag';
import { AppShell } from '@/components/shell/AppShell';
import { EquityChart } from '@/components/dashboard/EquityChart';
import { KpiStrip } from '@/components/dashboard/KpiStrip';
import { RecentTrades } from '@/components/dashboard/RecentTrades';
import { StrategyPerformance } from '@/components/dashboard/StrategyPerformance';
import { AiInsightsReadiness } from '@/components/dashboard/AiInsightsReadiness';
import { BrokerAccountsPanel } from '@/components/accounts/BrokerAccountsPanel';
import { ConnectMetaTraderModal } from '@/components/accounts/ConnectMetaTraderModal';

const RANGES = [['7', 'common.7.days.4b6569f5', '7 روز'], ['30', 'common.30.days.6ff5e162', '30 روز'], ['90', 'pages.dashboard.90.days.8814804c', '90 روز']] as const;

export default function DashboardPage() {
  const { t } = useI18n();
  const data = useDashboardData();
  const [tab, setTab] = useState<'overview' | 'ai-insights'>('overview');
  const [days, setDays] = useState('30');
  const [connectOpen, setConnectOpen] = useState(false);
  const toast = useTimedMessage<string>(3200);

  const hasInsightData = Number(data.summary?.tradeCount || data.trades?.length || 0) > 0 || (data.strategies || []).length > 0;

  const topActions = (
    <span className="top-actions" style={{ display: 'contents' }}>
      <a className="btn-gold" href="/trades/new/">
        <svg fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" viewBox="0 0 24 24" width="14"><path d="M12 5v14M5 12h14" /></svg>
        <span>{t('pages.dashboard.new.trade.52668492', null, 'ثبت معامله')}</span>
      </a>
      <button className="btn-ghost" onClick={() => void data.reload()}>
        <svg fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" viewBox="0 0 24 24" width="14"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
        <span>{t('pages.dashboard.refresh.d6bd8224', null, 'بروزرسانی')}</span>
      </button>
    </span>
  );

  return (
    <div className="pg-dashboard">
      <AppShell topRight={topActions}>
        <div className="dashboard-tabs" role="tablist" aria-label={t('dashboard.aiInsights.tabListAriaLabel', null, 'بخش‌های داشبورد')}>
          {(['overview', 'ai-insights'] as const).map((k) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} className={`dashboard-tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
              <span>{k === 'overview' ? t('common.dashboard.2aea7aaf', null, 'داشبورد') : t('dashboard.aiInsights.tabTitle', null, 'بینش‌های هوش مصنوعی')}</span>
            </button>
          ))}
        </div>

        <section role="tabpanel" hidden={tab !== 'overview'}>
          <KpiStrip summary={data.summary} />
          <div className="panel">
            <div className="panel-head">
              <div className="t"><svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 3v18h18" /><path d="M7 15l4-6 4 3 5-8" /></svg> <span>{t('common.equity.curve.cf3d44ce', null, 'منحنی سرمایه')}</span></div>
              <div className="range">
                {RANGES.map(([d, key, fb]) => <button key={d} className={days === d ? 'active' : undefined} onClick={() => { setDays(d); void data.loadEquity(d); }}>{t(key, null, fb)}</button>)}
              </div>
            </div>
            <EquityChart points={data.curve} />
            <span className="chart-caption">{t('dashboard.chart.stableTrend30Days', null, 'روند پایدار · 30 روز گذشته')}</span>
          </div>
          <div className="cols">
            <RecentTrades trades={data.trades} />
            <div>
              <StrategyPerformance strategies={data.strategies} />
              <BrokerAccountsPanel accounts={data.accounts} onChanged={data.loadAccounts} onConnect={() => setConnectOpen(true)} notify={toast.show} />
            </div>
          </div>
        </section>

        {tab === 'ai-insights' && <AiInsightsReadiness loading={data.loading} error={data.error} hasData={hasInsightData} />}
      </AppShell>

      <div aria-live="polite" className={`velora-toast${toast.visible ? ' show' : ''}`} role="status">{toast.value}</div>
      <ConnectMetaTraderModal open={connectOpen} onClose={() => setConnectOpen(false)} onConnected={() => void data.loadAccounts()} />
    </div>
  );
}
