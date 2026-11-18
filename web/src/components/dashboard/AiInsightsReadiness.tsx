'use client';
import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';

type Readiness = 'loading' | 'error' | 'empty' | 'ready';
/** Journal readiness for AI insights: derived from load state + whether any trades/strategies exist. */
export function AiInsightsReadiness({ loading, error, hasData }: { loading: boolean; error: unknown; hasData: boolean }) {
  const { t, errorMessage } = useI18n();
  const state: Readiness = loading ? 'loading' : error ? 'error' : hasData ? 'ready' : 'empty';
  const action = (key: string) => <a className="ai-insights-action" href="/intelligence/">{t(key)}</a>;
  const cls = { loading: ' is-loading', error: ' is-error', empty: '', ready: ' is-ready' }[state];
  return (
    <section className="dashboard-ai-section" role="tabpanel">
      <div className="panel ai-insights-panel">
        <div className="panel-head">
          <div className="t"><svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /></svg> <span>{t('dashboard.aiInsights.sectionTitle', null, 'بینش‌های معاملاتی هوش مصنوعی')}</span></div>
          <span className="ai-insights-badge">{t('common.aiInsights', null, 'AI INSIGHTS')}</span>
        </div>
        <p className="ai-insights-intro">{t('dashboard.aiInsights.sectionDescription')}</p>
        <div className={`ai-insights-state${cls}`}>
          <div className="ai-insights-ico" aria-hidden="true">{state === 'error' ? '!' : '✦'}</div>
          {state === 'loading' && <div className="ai-insights-title">{t('dashboard.aiInsights.loading')}</div>}
          {state === 'error' && <><div className="ai-insights-title">{t('dashboard.aiInsights.error')}</div><div className="ai-insights-copy">{errorMessage(error, 'errors.api')}</div>{action('dashboard.aiInsights.actionView')}</>}
          {state === 'empty' && <><div className="ai-insights-title">{t('dashboard.aiInsights.emptyTitle')}</div><div className="ai-insights-copy">{t('dashboard.aiInsights.emptyDescription')}</div>{action('dashboard.aiInsights.actionGenerate')}</>}
          {state === 'ready' && <><div className="ai-insights-title">{t('dashboard.aiInsights.readyTitle')}</div><div className="ai-insights-copy">{t('dashboard.aiInsights.readyDescription')}</div>{action('dashboard.aiInsights.actionView')}</>}
        </div>
      </div>
    </section>
  );
}
