'use client';
/* Connect a MetaTrader account (login + server + investor password) with a server-finder helper,
 * a staged progress bar, and the list of existing connections. Account operations live in useAccountActions. */
import React, { useEffect, useRef, useState } from 'react';
import './legacy.css';
import { normalizeAccount, type Account } from '@/lib/api/normalize';
import { useAccountActions } from '@/lib/hooks/useAccountActions';
import { useApiResource } from '@/lib/hooks/useApiResource';
import { useI18n } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';

const PROVIDER = 'MT4'; // legacy: `.popt` provider selector no longer exists in markup; default kept

export default function ConnectAccountPage() {
  const { t, currency, number, dateTime, status: statusLabel, errorMessage } = useI18n();
  const [login, setLogin] = useState('');
  const [server, setServer] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState('—');
  const [status, setStatus] = useState<{ type: string; msg: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [progress, setProgress] = useState<{ show: boolean; width: string }>({ show: false, width: '0%' });
  const act = useAccountActions();
  const res = useApiResource<{ accounts?: unknown[] }, Account[]>('/api/v1/accounts', (r) => (r.accounts || []).map(normalizeAccount));
  const accounts = res.data; const accountsError = res.error ? errorMessage(res.error, 'accounts.loadFailed') : null;
  const loadAccounts = res.reload;
  const loginRef = useRef<HTMLInputElement>(null);

  const show = (type: string, msg: string) => setStatus({ type, msg });


  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFinderOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* legacy paste handler: "login:password@server" */
  function onLoginPaste() {
    setTimeout(() => {
      const v = loginRef.current?.value || '';
      const match = v.match(/^(\d+)(?::([^@]+))?@(.+)$/);
      if (!match) return;
      setLogin(match[1]);
      if (match[2]) setPassword(match[2]);
      setServer(match[3]);
      setChosen(match[3]);
      setSuggested((s) => s || []);
    }, 50);
  }

  function pickServer(s: string) {
    setServer(s);
    setChosen(s);
    setTimeout(() => setFinderOpen(false), 180);
  }

  async function detect() {
    if (!login.trim()) { show('err', t('accounts.loginRequired')); return; }
    if (!password) { show('err', t('accounts.investorPasswordRequired')); return; }
    setDetecting(true);
    try {
      const data = await act.detectServer(login.trim());
      const servers = data.suggestedServers || [];
      setSuggested(servers);
      if (servers[0]) pickServer(servers[0]);
      show('info', t('accounts.suggestionsReady'));
    } catch (error) {
      show('err', errorMessage(error));
    } finally {
      setDetecting(false);
    }
  }

  async function checkSync(id: number) {
    try {
      await act.sync(id);
      const data = await act.syncStatus(id);
      alert(t('accounts.syncSubmitted', { status: statusLabel(data.syncStatus), date: dateTime(data.lastSyncedAt), jobs: number((data.recentJobs || []).length) }));
      void loadAccounts();
    } catch (error) { alert(errorMessage(error)); }
  }

  async function connect() {
    const srv = server.trim();
    if (!srv) { show('err', t('pages.accounts.connect.p05.server_required')); return; }
    const lg = login.trim();
    if (!srv || !lg || !password) { show('err', t('accounts.requiredFields')); return; }
    setConnecting(true);
    setProgress({ show: true, width: '18%' });
    show('info', t('accounts.encrypting'));
    setTimeout(() => setProgress((p) => ({ ...p, width: '45%' })), 400);
    try {
      const data = await act.connect({ login: lg, investorPassword: password, server: srv, provider: PROVIDER, label: t('common.account', { number: lg }), broker: srv.split('-')[0] });
      const newId = data.account?.id;
      setProgress((p) => ({ ...p, width: '78%' }));
      show('ok', t('accounts.created', { id: newId }));
      setTimeout(() => { setProgress((p) => ({ ...p, width: '100%' })); void loadAccounts(); }, 600);
      if (newId) setTimeout(() => { act.sync(newId).catch(() => {}); }, 1200);
    } catch (error) {
      setProgress((p) => ({ ...p, width: '0%' }));
      show('err', errorMessage(error));
    } finally {
      setConnecting(false);
      setTimeout(() => setProgress({ show: false, width: '0%' }), 2200);
    }
  }


  return (
    <div className="pg-accounts-connect">
      <AppShell topRight={<NewTradeLink />}>
        <div className="panel">
          <div className="connect-intro">
            <div className="connect-icon"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.07-7.07L11.7 5.1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.07 7.07l1.7-1.7" /></svg></div>
            <div><b><span>{t('pages.accounts.connect.p05.secure_title', null, 'اتصال امن حساب معاملاتی')}</span></b><span><span>{t('pages.accounts.connect.p05.secure_intro', null, 'سه اطلاعات ضروری را وارد کنید؛ فقط داده‌ها خوانده و همگام‌سازی می‌شوند.')}</span></span></div>
          </div>
          <div className="single-flow-label"><span><span>{t('pages.accounts.connect.p05.connect_account', null, 'اتصال حساب')}</span></span><i><span>{t('pages.accounts.connect.p05.three_details', null, '3 اطلاعات ضروری')}</span></i></div>
          <div id="quickBox">
            <div className="field-grid">
              <div className="field" style={{ marginTop: 0 }}>
                <label><span>{t('pages.accounts.connect.p05.metatrader_login', null, 'شماره حساب متاتریدر')}</span></label>
                <input ref={loginRef} className="input" id="quick_login" inputMode="numeric" autoComplete="off" placeholder={t('pages.accounts.connect.p05.login_placeholder', null, 'مثال: 12345678')} style={{ fontSize: 15, letterSpacing: 1, fontWeight: 800 }} value={login} onChange={(e) => setLogin(e.target.value)} onPaste={onLoginPaste} />
              </div>
              <div className="field" style={{ marginTop: 0 }}>
                <label><span>{t('pages.accounts.connect.p05.broker_server', null, 'آدرس سرور بروکر')}</span></label>
                <input className="input" id="quick_server" dir="ltr" autoComplete="off" placeholder={t('pages.accounts.connect.p05.server_placeholder', null, 'مثال: ICMarkets-Demo')} value={server} onChange={(e) => { setServer(e.target.value); if (e.target.value.trim()) setChosen(e.target.value.trim()); }} />
                <button className="server-help-link" type="button" id="openServerFinder" onClick={() => setFinderOpen(true)}><span>{t('pages.accounts.connect.p05.server_unknown', null, 'آدرس سرور را نمی‌دانید؟')}</span></button>
              </div>
            </div>
            <div className="field">
              <label><span>{t('pages.accounts.connect.p05.investor_password', null, 'رمز سرمایه‌گذار')}</span> <span style={{ color: 'var(--green)', fontSize: 10 }}><span>{t('pages.accounts.connect.p05.read_only', null, 'فقط خواندنی')}</span></span></label>
              <div className="password-control">
                <input className="input" id="quick_password" dir="ltr" autoComplete="off" placeholder="Investor Password" type={showPass ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button className="password-toggle" type="button" aria-label={showPass ? t('pages.accounts.connect.p05.hide_password') : t('pages.accounts.connect.p05.show_password')} onClick={() => setShowPass((v) => !v)}>
                  <svg viewBox="0 0 24 24"><path d="M2.5 12s3.3-6 9.5-6 9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>
                </button>
              </div>
              <div className="hint"><span>{t('pages.accounts.connect.p05.password_security', null, 'رمز شما برای اتصال امن رمزنگاری می‌شود و دسترسی آن فقط خواندنی است.')}</span></div>
            </div>
            <div className="security-strip">
              <svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.6 3 8.8 7 10 4-1.2 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
              <span><b><span>{t('pages.accounts.connect.p05.read_only_access', null, 'دسترسی فقط خواندنی')}</span></b> <span>{t('pages.accounts.connect.p05.no_trade_withdrawal', null, '— VELORA هیچ‌گاه اجازه معامله یا برداشت از حساب شما را ندارد.')}</span></span>
            </div>
          </div>

          <div className="server-finder-backdrop" id="serverFinder" hidden={!finderOpen} onClick={(e) => { if (e.target === e.currentTarget) setFinderOpen(false); }}>
            <section className="server-finder" role="dialog" aria-modal="true" aria-labelledby="serverFinderTitle">
              <button className="finder-close" id="closeServerFinder" type="button" aria-label={t('pages.accounts.connect.p05.close', null, 'بستن')} onClick={() => setFinderOpen(false)}>×</button>
              <div className="finder-icon"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4M8.5 11h5M11 8.5v5" /></svg></div>
              <h2 id="serverFinderTitle"><span>{t('pages.accounts.connect.p05.server_finder_title', null, 'پیدا کردن سرور بروکر')}</span></h2>
              <p><span>{t('pages.accounts.connect.p05.server_finder_body', null, 'اگر نام سرور را نمی‌دانید، با شماره حساب و رمز سرمایه‌گذار پیشنهادهای سازگار را دریافت کنید.')}</span></p>
              <button className="btn btn-detect" id="detectBtn" type="button" disabled={detecting} onClick={() => void detect()}>
                {detecting ? t('accounts.detecting') : <span>{t('pages.accounts.connect.p05.suggest_servers', null, 'پیشنهاد سرورهای احتمالی')}</span>}
              </button>
              <div id="detectResult" style={{ display: suggested ? 'block' : 'none', marginTop: 14, padding: 13, background: 'rgba(255,255,255,.035)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 9 }}><span>{t('pages.accounts.connect.p05.choose_server', null, 'سرور پیشنهادی را انتخاب کنید:')}</span></div>
                <div id="detectChips" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {(suggested || []).map((s) => {
                    const active = s === chosen;
                    return <button type="button" key={s} onClick={() => pickServer(s)} style={{ padding: '8px 12px', background: active ? 'linear-gradient(135deg,#fce38a,#d4af37)' : 'rgba(212,175,55,.12)', border: '1px solid rgba(212,175,55,.3)', color: active ? '#0b121e' : 'var(--gold-l)', borderRadius: 8, fontSize: 12, cursor: 'pointer' }}>{s}</button>;
                  })}
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--muted)' }}><span>{t('pages.accounts.connect.p05.selected_server', null, 'انتخاب شد:')}</span> <b id="chosenServer" style={{ color: 'var(--gold-l)' }}>{chosen}</b></div>
              </div>
            </section>
          </div>

          <div className={`progress${progress.show ? ' show' : ''}`} id="progress"><div className="bar" id="bar" style={{ width: progress.width }} /></div>
          <div className={status ? `status show ${status.type}` : 'status'} id="status">{status?.msg}</div>
          <button className="btn connect-submit" id="connectBtn" disabled={connecting} onClick={() => void connect()}>
            {connecting ? t('accounts.connecting') : (<><svg fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="16"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg> <span>{t('pages.accounts.connect.connect.start.sync.efbf2c41', null, 'اتصال و شروع همگام‌سازی')}</span></>)}
          </button>
          <button className="btn-ghost" onClick={() => { location.href = '/dashboard/'; }}>{t('pages.accounts.connect.back.to.dashboard.de36527f', null, '← بازگشت به داشبورد')}</button>
        </div>

        <div className="panel" style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>{t('pages.accounts.connect.current.connection.status.b144eb76', null, 'وضعیت اتصال‌های فعلی')}</div>
          <div id="accountsList" style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
            {accountsError ? accountsError
              : accounts === null ? t('pages.accounts.connect.loading.ee40ce65', null, 'در حال بارگذاری...')
              : accounts.length === 0 ? t('accounts.empty')
              : accounts.map((account) => {
                const label = account.label || account.server || account.login || t('common.account', { number: account.id || '' });
                return (
                  <div key={account.id ?? label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, border: '1px solid var(--border)', borderRadius: 12, marginBottom: 10, background: 'rgba(255,255,255,.02)' }}>
                    <div>
                      <b style={{ color: '#fce38a', fontSize: 14 }}>{label}</b>{' '}
                      <small style={{ color: 'var(--muted)', marginInlineStart: 8 }}>{account.platform || ''} — {account.server || ''} — {account.login || ''}</small>
                      <div style={{ marginTop: 6, fontSize: 13, display: 'flex', gap: 14, color: '#EAF0FA' }}>
                        <span>{t('accounts.balance')}: <b data-value-type="currency" style={{ color: '#4CD39A' }}>{currency(account.balance, account.currency, { minimumFractionDigits: 2 })}</b></span>
                        <span>{t('accounts.equity')}: <b data-value-type="currency" style={{ color: '#3B82F6' }}>{currency(account.equity, account.currency, { minimumFractionDigits: 2 })}</b></span>
                        {account.leverage ? <span>{t('accounts.leverage')}: <b data-value-type="number" style={{ color: '#fce38a' }}>1:{number(account.leverage)}</b></span> : null}
                        <span>{t('accounts.currency')}: <b data-value-type="symbol">{account.currency}</b></span>
                      </div>
                      <div style={{ marginTop: 4 }}><small>● {statusLabel(account.syncStatus)}{account.lastSyncedAt ? ' — ' + t('accounts.lastSync', { date: dateTime(account.lastSyncedAt) }) : ''}</small></div>
                    </div>
                    <button type="button" onClick={() => void checkSync(Number(account.id))} style={{ background: 'rgba(212,175,55,.15)', border: '1px solid rgba(212,175,55,.4)', color: 'var(--gold-l)', padding: '8px 14px', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: 700 }}>{t('accounts.syncAgain')}</button>
                  </div>
                );
              })}
          </div>
        </div>
      </AppShell>
    </div>
  );
}
