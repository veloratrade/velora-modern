'use client';
/* Port of legacy forgot-password/index.html (markup, ids, i18n keys and flow preserved). */
import React, { useState } from 'react';
import Link from 'next/link';
import './legacy.css';
import { useI18n } from '@/i18n/I18nProvider';
import { request } from '@/lib/api/client';
import { LocaleSwitcher } from '@/components/i18n/LocaleSwitcher';
import { AuthBrand } from '@/components/brand/AuthBrand';

export default function ForgotPasswordPage() {
  const { t, locale, errorMessage } = useI18n();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err' | ''; text: string }>({ type: '', text: '' });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      setMsg({ type: 'err', text: t('auth.emailInvalid') });
      return;
    }
    setBusy(true);
    try {
      await request('/api/v1/auth/forgot-password', { method: 'POST', token: '', body: { email: value, notificationLocale: locale } });
      setMsg({ type: 'ok', text: t('auth.resetSent') });
    } catch (error) {
      setMsg({ type: 'err', text: errorMessage(error, 'auth.recoveryFailed') });
    }
    setBusy(false);
  };

  return (
    <div className="pg-forgot-password">
      <div className="shell">
        <main className="card">
          <AuthBrand />
          <h1>{t('pages.forgot_password.recover.password.c795cbe8', null, 'بازیابی رمز عبور')}</h1>
          <p>
            {t(
              'pages.forgot_password.enter.your.account.email.if.an.account.f58bd55b',
              null,
              'ایمیل حساب خود را وارد کنید. اگر حسابی با این ایمیل وجود داشته باشد، لینک بازیابی برایتان ارسال می‌شود.',
            )}
          </p>
          <form id="form" noValidate onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="email">{t('common.email.0cc870ea', null, 'ایمیل')}</label>
              <input
                autoComplete="email"
                id="email"
                placeholder="you@example.com"
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button id="btn" type="submit" disabled={busy}>
              {busy ? t('auth.sendingReset') : t('pages.forgot_password.send.recovery.link.d88ddcda', null, 'ارسال لینک بازیابی')}
            </button>
            <div className={`msg ${msg.type}`} id="msg">
              {msg.text}
            </div>
          </form>
          <div className="switch">
            <span>{t('pages.forgot_password.remember.your.password.6969160e', null, 'رمز را به خاطر آوردید؟')}</span>{' '}
            <Link href="/login/">{t('common.login.to.account.8181f948', null, 'ورود به حساب')}</Link>
          </div>
        </main>
      </div>
      <LocaleSwitcher placement="dock" />
    </div>
  );
}
