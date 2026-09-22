'use client';
/* Port of legacy reset-password/index.html. Token is read from the URL fragment (or legacy query) and scrubbed from history. */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import './legacy.css';
import { useI18n } from '@/i18n/I18nProvider';
import { request } from '@/lib/api/client';
import { LocaleSwitcher } from '@/components/i18n/LocaleSwitcher';
import { AuthBrand } from '@/components/brand/AuthBrand';

export default function ResetPasswordPage() {
  const { t, locale, errorMessage } = useI18n();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err' | ''; text: string }>({ type: '', text: '' });

  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
    const tok = hashParams.get('token') || queryParams.get('token') || '';
    setToken(tok);
    queryParams.delete('token');
    const cleanUrl = location.pathname + (queryParams.toString() ? `?${queryParams.toString()}` : '');
    history.replaceState(null, document.title, cleanUrl);
  }, []);

  useEffect(() => {
    if (token === '') setMsg({ type: 'err', text: t('auth.resetTokenMissing') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, locale]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    const value = password;
    if (value.length < 8 || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
      setMsg({ type: 'err', text: t('auth.passwordInvalid') });
      return;
    }
    if (value !== confirm) {
      setMsg({ type: 'err', text: t('auth.passwordMismatch') });
      return;
    }
    setBusy(true);
    try {
      await request('/api/v1/auth/reset-password', {
        method: 'POST',
        token: '',
        body: { token, newPassword: value, notificationLocale: locale },
      });
      setMsg({ type: 'ok', text: t('auth.resetComplete') });
      setPassword('');
      setConfirm('');
    } catch (error) {
      setMsg({ type: 'err', text: errorMessage(error, 'auth.resetLinkInvalid') });
    }
    setBusy(false);
  };

  return (
    <div className="pg-reset-password">
      <div className="shell">
        <main className="card">
          <AuthBrand />
          <h1>{t('pages.reset_password.reset.password.eecd5ebe', null, 'بازنشانی رمز عبور')}</h1>
          <p>
            {t(
              'pages.reset_password.enter.your.new.password.it.must.contain.6e604b70',
              null,
              'رمز جدید خود را وارد کنید. رمز باید حداقل ۸ کاراکتر و شامل یک حرف انگلیسی و یک عدد باشد.',
            )}
          </p>
          <form id="form" noValidate onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="password">{t('common.new.password.f8211826', null, 'رمز جدید')}</label>
              <input
                autoComplete="new-password"
                id="password"
                placeholder={t('common.minimum.8.characters.0a76ac5c', null, 'حداقل ۸ کاراکتر')}
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="hint">{t('pages.reset_password.example.velora2026.f94f471c', null, 'مثال: VELORA2026')}</div>
            </div>
            <div className="field">
              <label htmlFor="confirm">{t('pages.reset_password.repeat.new.password.d313e98a', null, 'تکرار رمز جدید')}</label>
              <input
                autoComplete="new-password"
                id="confirm"
                placeholder={t('pages.reset_password.confirm.password.9071dd6d', null, 'تکرار رمز')}
                required
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <button id="btn" type="submit" disabled={busy || !token}>
              {busy ? t('auth.savingPassword') : t('pages.reset_password.set.new.password.ad123390', null, 'ثبت رمز جدید')}
            </button>
            <div className={`msg ${msg.type}`} id="msg">
              {msg.text}
            </div>
          </form>
          <div className="switch">
            <Link href="/forgot-password/">{t('pages.reset_password.resend.recovery.link.9e292a56', null, 'ارسال دوباره لینک بازیابی')}</Link> ·{' '}
            <Link href="/login/">{t('common.login.e09e596b', null, 'ورود')}</Link>
          </div>
        </main>
      </div>
      <LocaleSwitcher placement="dock" />
    </div>
  );
}
