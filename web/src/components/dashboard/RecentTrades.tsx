'use client';
import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import type { Trade } from '@/lib/api/normalize';
import { usePnlFormat } from '@/lib/hooks/usePnlFormat';

export function RecentTrades({ trades }: { trades: Trade[] | null }) {
  const { t, status, tradeDate } = useI18n();
  const { fmt, fmtPnl } = usePnlFormat();
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="t"><svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg> <span>{t('pages.dashboard.recent.trades.5056aea9', null, 'معاملات اخیر')}</span></div>
        <a className="btn-ghost" href="/trades/" style={{ padding: '7px 14px', fontSize: 12 }}>{t('pages.dashboard.view.all.f9c2f106', null, 'مشاهده همه')}</a>
      </div>
      <div className="table-wrap">
        <table className="trades">
          <thead><tr><th>{t('common.symbol.159cbe33', null, 'نماد')}</th><th>{t('common.direction.24ff67a2', null, 'جهت')}</th><th>{t('common.p.l.56fefd2f', null, 'سود/زیان')}</th><th>R</th><th>{t('common.strategy.1b590fba', null, 'استراتژی')}</th><th>{t('common.date.cf250c56', null, 'تاریخ')}</th></tr></thead>
          <tbody>
            {trades && trades.length === 0 && (
              <tr><td colSpan={6}><div className="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M7 15l4-6 4 3 5-8" /><path d="M3 3v18h18" /></svg>{t('trades.empty')}<br />{t('dashboard.firstTrade')}</div></td></tr>
            )}
            {(trades || []).map((tr, i) => {
              const p = fmtPnl(tr.profitLoss);
              return (
                <tr key={tr.id ?? i}>
                  <td><span className="sym">{tr.symbol}</span></td>
                  <td><span className={`dir ${tr.direction}`}>{status(tr.direction)}</span></td>
                  <td><span data-value-type="currency" className={`pnl ${p.pos ? 'pos' : 'neg'}`}>{p.text}</span></td>
                  <td data-value-type="number">{tr.rMultiple == null ? '—' : fmt(Number(tr.rMultiple), 2)}</td>
                  <td>{tr.strategyTag ? <span className="tag">{tr.strategyTag}</span> : '—'}</td>
                  <td data-value-type="date">{tradeDate(tr.occurredCloseAtUtc, tr.closeTime)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
