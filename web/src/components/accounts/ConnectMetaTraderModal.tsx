'use client';
/* Quick-connect dialog (login + investor password, optional server/platform). Styling = legacy dashboard modal. */
import React, { useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { useAccountActions } from '@/lib/hooks/useAccountActions';

export function ConnectMetaTraderModal({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: () => void }) {
  const { t, errorMessage } = useI18n();
  const { connect } = useAccountActions();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState('');
  const [provider, setProvider] = useState('MT4');
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => { setPassword(''); onClose(); };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await connect({ login: login.trim(), investorPassword: password, server: server.trim(), provider, label: t('common.account', { number: login.trim() }) });
      close();
      alert(t('accounts.connectionSuccess'));
      onConnected();
    } catch (err) { alert(errorMessage(err, 'accounts.connectFailed')); }
    finally { setPassword(''); setBusy(false); }
  }
  const bolt = <svg className="velora-inline-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 10-13h-7V2Z" /></svg>;

  return (
    <div className="mt-modal" style={{ display: open ? 'flex' : 'none' }}>
      <div className="mt-modal-card">
        <div className="mt-modal-head">
          <h3>{bolt}<span>{t('pages.dashboard.connect.metatrader.v0.2.cloud.bridge.fcf0f00c', null, 'اتصال حساب متاتریدر (نسخه 0.2 — پل ابری)')}</span></h3>
          <button className="mt-modal-x" onClick={close} type="button">×</button>
        </div>
        <p className="mt-modal-intro">{bolt} <b>{t('pages.dashboard.quick.connect.4fe19b5c', null, 'اتصال فوری:')}</b> <span>{t('pages.dashboard.enter.only.the.account.number.and.investor.b9ccafb0')}</span></p>
        <form onSubmit={submit}>
          <div className="mt-field">
            <label>{t('pages.dashboard.metatrader.account.mt.login.827bccc1', null, 'شماره حساب متاتریدر (MT Login)')}</label>
            <input className="mt-input mt-input-login" placeholder={t('common.for.example.5043891.or.12345678.53ed1e1f', null, 'مثلاً 5043891 یا 12345678')} required type="text" value={login} onChange={(e) => setLogin(e.target.value)} />
          </div>
          <div className="mt-field">
            <label>{t('pages.dashboard.investor.password.59e495e5', null, 'رمز اینوستور (Investor Password)')}</label>
            <input className="mt-input mt-input-pass" autoComplete="off" placeholder={t('pages.dashboard.read.only.secure.0439bc5c', null, '•••••••• (فقط خواندنی - امن)')} required spellCheck={false} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="mt-note"><svg fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="16"><rect height="10" rx="3" width="18" x="3" y="11" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg> <span>{t('pages.dashboard.no.server.name.needed.aes.256.gcm.c8ec2b61', null, 'بدون نیاز به نام سرور یا پلتفرم — با رمزنگاری AES-256-GCM')}</span></div>
          </div>
          <div className="mt-field">
            <button className="mt-adv-link" onClick={() => setAdv((v) => !v)} type="button">{t('pages.dashboard.advanced.broker.server.settings.optional.c6171b93', null, '⚙️ تنظیمات پیشرفته بروکر / سرور (اختیاری)')}</button>
            <div className="mt-adv" style={{ display: adv ? 'block' : 'none' }}>
              <div style={{ marginBottom: 10 }}>
                <label>{t('pages.dashboard.broker.server.leave.empty.for.auto.detect.073c93fd', null, 'نام سرور بروکر (خالی بگذارید تا خودکار شناسایی شود)')}</label>
                <input className="mt-input-sm" placeholder={t('pages.dashboard.for.example.icmarkets.demo.or.alpari.live.94e0162e', null, 'مثلاً ICMarkets-Demo یا Alpari-Live')} type="text" value={server} onChange={(e) => setServer(e.target.value)} />
              </div>
              <div>
                <label>{t('common.platform.f08c21ce', null, 'پلتفرم')}</label>
                <select className="mt-input-sm" value={provider} onChange={(e) => setProvider(e.target.value)}>
                  <option value="MT4">{t('accounts.platform.mt4', null, 'MetaTrader 4 (MT4)')}</option>
                  <option value="MT5">{t('accounts.platform.mt5', null, 'MetaTrader 5 (MT5)')}</option>
                </select>
              </div>
            </div>
          </div>
          <div className="mt-actions">
            <button className="mt-cancel" onClick={close} type="button">{t('common.cancel.9955c4b6', null, 'انصراف')}</button>
            <button className="mt-submit" disabled={busy} type="submit">
              {busy ? t('accounts.detectAndExtract') : <><svg fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="16"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></svg> <span>{t('pages.dashboard.connect.get.account.info.e5c94952', null, 'اتصال و دریافت مشخصات حساب')}</span></>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
