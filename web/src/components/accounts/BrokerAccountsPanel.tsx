'use client';
/* Dashboard widget: connected MetaTrader accounts with sync / details / disconnect. */
import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import type { Account } from '@/lib/api/normalize';
import { useAccountActions } from '@/lib/hooks/useAccountActions';
import { usePnlFormat } from '@/lib/hooks/usePnlFormat';
import { confirmDialog } from '@/components/ui/ConfirmDialog';

interface Props { accounts: Account[] | null; onChanged: () => Promise<void>; onConnect: () => void; notify: (msg: string) => void }

export function BrokerAccountsPanel({ accounts, onChanged, onConnect, notify }: Props) {
  const { t, currency, status, errorMessage } = useI18n();
  const { fmt } = usePnlFormat();
  const act = useAccountActions();

  async function sync(id: number) {
    try { await act.sync(id); await onChanged(); notify(t('accounts.syncSubmitted', { status: t('status.pending'), date: '—', jobs: '—' })); }
    catch (e) { notify(errorMessage(e, 'dashboard.syncFailed')); }
  }
  function details(a: Account) {
    notify(t('dashboard.accountDetails', { provider: a.platform || t('common.account', { number: '' }), number: a.login || '—', balance: currency(a.balance, a.currency), equity: currency(a.equity, a.currency) }));
  }
  async function disconnect(id: number) {
    if (!(await confirmDialog(t('accounts.disconnectConfirm'), { title: t('dashboard.disconnectAccount'), confirm: t('dashboard.disconnectAccount') }))) return;
    try { await act.remove(id); await onChanged(); } catch (e) { alert(errorMessage(e, 'accounts.deleteFailed')); }
  }
  const valid = (accounts || []).filter((a) => Number.isSafeInteger(Number(a.id)) && Number(a.id) > 0);

  return (
    <div className="panel">
      <div className="panel-head acct-head">
        <div className="t">
          <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><rect height="14" rx="3" width="20" x="2" y="5" /><path d="M2 10h20" /></svg>
          <span>{t('pages.dashboard.broker.accounts.d1c69b78', null, 'حساب‌های بروکر')}</span>
          <span className="acct-version">{t('dashboard.cloudBridgeVersion', null, 'v0.2 Cloud Bridge')}</span>
        </div>
        <button className="acct-connect-btn" onClick={onConnect} type="button">{t('pages.dashboard.connect.metatrader.mt4.mt5.34bb9d1d', null, '+ اتصال متاتریدر (MT4 / MT5)')}</button>
      </div>
      <div>
        {accounts && accounts.length === 0 && (
          <div className="empty acct-empty">
            <div className="acct-empty-title">{t('dashboard.noAccountsTitle')}</div>
            <p className="acct-empty-body">{t('dashboard.noAccountsBody')}</p>
            <button className="btn acct-empty-cta" onClick={onConnect}>{t('dashboard.connectMetaTrader')}</button>
          </div>
        )}
        {valid.map((a) => {
          const id = Number(a.id);
          return (
            <div className="acct-card" key={id} style={{ position: 'relative' }}>
              <button type="button" className="acct-remove" onClick={() => void disconnect(id)} title={t('dashboard.disconnectAccount')}>×</button>
              <div className="acct-top"><span className="prov">{a.platform} · {a.login || ''}</span><span className="st"><span className="dot" /> {status(a.status)}</span></div>
              <div className="acct-num">•••• {(a.login || '').slice(-4)}</div>
              <div className="acct-bal">
                <div><div className="lbl">{t('accounts.balance')}</div><div className="val" data-value-type="currency">{currency(a.balance, a.currency)}</div></div>
                <div className="eq" data-value-type="currency">EQ {currency(a.equity, a.currency)}</div>
              </div>
              <div className="acct-meta"><span>{t('accounts.leverage')}: <b data-value-type="number">{fmt(a.leverage)}</b></span><span>{t('accounts.currency')}: <b data-value-type="symbol">{a.currency}</b></span></div>
              <div className="acct-action-row">
                <button type="button" disabled={act.syncingId === id} onClick={() => void sync(id)}>{act.syncingId === id ? t('accounts.syncing') : t('accounts.sync')}</button>
                <button type="button" className="ghost" onClick={() => details(a)}>{t('dashboard.details')}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
