'use client';
/* Ported from legacy trades/index.html (markup + inline script). API: GET /api/v1/trades?limit=30 */
import React, { useState } from 'react';
import './legacy.css';
import { normalizeTrade, type Trade } from '@/lib/api/normalize';
import { useI18n } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { useApiResource } from '@/lib/hooks/useApiResource';

export default function TradesPage() {
  const { t, number, currency: fmtCurrency, percent, status, tradeDate, errorMessage } = useI18n();
  const { data: items, error: loadError } = useApiResource<{ items?: unknown[] }, Trade[]>('/api/v1/trades?limit=30', (r) => (r.items || []).map(normalizeTrade));
  const [picked, setPicked] = useState<Trade | null>(null);
  const selected = picked || (items && items[0]) || null; // first trade is reviewed by default

  const currency = (value: unknown, code?: string | null, sign?: boolean) =>
    fmtCurrency(value, code || 'USD', { maximumFractionDigits: 2, signDisplay: sign ? 'always' : 'auto' });

  /* KPI derivations (legacy init) */
  const list = items || [];
  const total = list.reduce((sum, tr) => sum + Number(tr.profitLoss || 0), 0);
  const wins = list.filter((tr) => Number(tr.profitLoss) > 0).length;
  const symbols: Record<string, number> = {};
  list.forEach((tr) => { symbols[tr.symbol] = (symbols[tr.symbol] || 0) + Number(tr.profitLoss || 0); });
  const best = Object.keys(symbols).sort((a, b) => symbols[b] - symbols[a])[0] || '—';
  const tagged = list.find((tr) => tr.strategyTag);
  const loaded = items !== null && !loadError;

  const selPnl = Number(selected?.profitLoss || 0);


  return (
    <div className="pg-trades">
      <AppShell topRight={<NewTradeLink />}>
        <section className="cols">
          <div className="glass panel">
            <div className="pt">
              <b>{t('pages.trades.last.trade.execution.cycle.305c3082', null, 'چرخه اجرای آخرین معامله')}</b>
              <span className={selected ? (selPnl >= 0 ? 'green' : 'red') : 'green'} id="result">{selected ? currency(selPnl, selected.currency, true) : '—'}</span>
            </div>
            <div className="steps">
              <div className="step">
                <b>{t('pages.trades.1.setup.context.d9ad9f8c', null, '1. ستاپ و کانتکست')}</b><br />
                <span className="mut" id="setup">{selected ? (selected.strategyTag || t('trades.setupMissing')) + ' · ' + (selected.symbol || '—') : t('pages.trades.loading.trade.info.27f5ac4e', null, 'در حال دریافت اطلاعات معامله…')}</span>
              </div>
              <div className="step">
                <b>{t('pages.trades.2.entry.risk.management.7c4409b4', null, '2. ورود و مدیریت ریسک')}</b><br />
                <span className="mut" id="entry">{selected ? t('trades.entrySummary', {
                  direction: status(selected.direction),
                  price: number(selected.entryPrice, { maximumFractionDigits: 8 }),
                  volume: number(selected.volume, { maximumFractionDigits: 4 }),
                }) : '—'}</span>
              </div>
              <div className="step">
                <b>{t('pages.trades.3.position.management.04a9ce4f', null, '3. مدیریت پوزیشن')}</b><br />
                <span className="mut">{t('pages.trades.in.the.current.version.trade.management.and.57618d10', null, 'در نسخه فعلی، مدیریت معامله و حد ضرر در ژورنال ثبت می‌شود.')}</span>
              </div>
              <div className="step">
                <b>{t('pages.trades.4.result.learning.5a7f1e6a', null, '4. نتیجه و یادگیری')}</b><br />
                <span className="mut" id="outcome">{selected ? t(selPnl >= 0 ? 'trades.positiveOutcome' : 'trades.negativeOutcome', { notes: selected.notes || t('trades.noExitNotes') }) : '—'}</span>
              </div>
            </div>
          </div>
          <aside className="glass panel">
            <div className="pt"><b>{t('pages.trades.personal.insights.25d1be83', null, 'بینش‌های شخصی')}</b><span className="tag">{t('common.aiInsight', null, 'AI INSIGHT')}</span></div>
            <div className="insight">{t('pages.trades.your.best.strategy.and.symbol.are.calculated.48f21baf', null, '✦ بهترین استراتژی و نماد شما با استفاده از معاملات ثبت‌شده محاسبه می‌شود.')}</div>
            <div className="insight">{t('pages.trades.for.more.accurate.analysis.complete.the.entry.474ead4d', null, '✦ برای تحلیل دقیق‌تر، هنگام ثبت معامله دلیل ورود و یادداشت خروج را تکمیل کنید.')}</div>
            <div className="insight">{t('pages.trades.suggested.target.no.more.than.two.trades.bccf70d1', null, '✦ هدف پیشنهادی: حداکثر دو معامله در هر سشن و ریسک ثابت.')}</div>
          </aside>
        </section>

        <section className="kpis" id="kpis">
          <div className="glass kpi"><small>{t('pages.trades.best.symbol.b7749a1a', null, 'بهترین نماد')}</small><b id="bestSymbol">{loaded ? best : '—'}</b></div>
          <div className="glass kpi"><small>{t('pages.trades.total.trades.b3aaafd2', null, 'کل معاملات')}</small><b id="count">{loaded ? number(list.length, { maximumFractionDigits: 0 }) : '—'}</b></div>
          <div className="glass kpi"><small>{t('common.win.rate.f57b9504', null, 'نرخ برد')}</small><b id="win">{loaded && list.length ? percent(wins / list.length, { maximumFractionDigits: 0 }) : '—'}</b></div>
          <div className="glass kpi"><small>{t('common.net.p.l.21997b05', null, 'سود خالص')}</small><b id="pnl" className={loaded ? (total >= 0 ? 'green' : 'red') : undefined}>{loaded ? currency(total, list[0] ? list[0].currency : 'USD', true) : '—'}</b></div>
          <div className="glass kpi"><small>{t('pages.trades.best.strategy.87602ad2', null, 'بهترین استراتژی')}</small><b id="bestStrategy">{loaded && tagged ? tagged.strategyTag : '—'}</b></div>
          <div className="glass kpi"><small>{t('pages.trades.notes.7267b19d', null, 'یادداشت‌ها')}</small><b id="notes">{loaded ? number(list.filter((tr) => tr.notes).length, { maximumFractionDigits: 0 }) + ' / ' + number(list.length, { maximumFractionDigits: 0 }) : '—'}</b></div>
        </section>

        <section className="glass table">
          <div className="pt"><b>{t('pages.trades.trades.for.review.eddc7fa1', null, 'معاملات برای مرور')}</b><span className="mut">{t('pages.trades.click.a.trade.row.for.details.75cbc037', null, 'برای انتخاب جزئیات، روی ردیف معامله کلیک کنید')}</span></div>
          <div className="tr head"><span>{t('common.symbol.159cbe33', null, 'نماد')}</span><span>{t('common.direction.24ff67a2', null, 'جهت')}</span><span>{t('common.p.l.56fefd2f', null, 'سود/زیان')}</span><span>R</span><span>{t('common.strategy.1b590fba', null, 'استراتژی')}</span><span>{t('common.date.cf250c56', null, 'تاریخ')}</span></div>
          <div id="rows">
            {loadError ? <div className="empty">{errorMessage(loadError, 'trades.loadFailed')}</div>
              : items && items.length === 0 ? <div className="empty">{t('trades.empty')}</div>
              : list.map((tr, index) => {
                const pnl = Number(tr.profitLoss || 0);
                return (
                  <div className="tr" style={{ cursor: 'pointer' }} key={tr.id ?? index} onClick={() => setPicked(tr)}>
                    <b data-value-type="symbol">{tr.symbol || '—'}</b>
                    <span className={tr.direction === 'buy' ? 'green' : 'red'}>{status(tr.direction)}</span>
                    <b data-value-type="currency" className={pnl >= 0 ? 'green' : 'red'}>{currency(pnl, tr.currency, true)}</b>
                    <span data-value-type="number">{tr.rMultiple == null ? '—' : number(tr.rMultiple, { maximumFractionDigits: 2 })}</span>
                    <span className="tag">{tr.strategyTag || '—'}</span>
                    <span data-value-type="date">{tradeDate(tr.occurredCloseAtUtc, tr.closeTime)}</span>
                  </div>
                );
              })}
          </div>
        </section>
      </AppShell>
    </div>
  );
}
