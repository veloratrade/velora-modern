'use client';
/* Port of legacy verify-email/index.html — auto-submits the capability token from the fragment. */
import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import './legacy.css';
import { useI18n } from '@/i18n/I18nProvider';
import { ApiError, request } from '@/lib/api/client';
import { LocaleSwitcher } from '@/components/i18n/LocaleSwitcher';
import { AuthBrand } from '@/components/brand/AuthBrand';

type State = { type: 'loading' | 'ok' | 'err'; title: string; body: string; login: boolean; resend: boolean };

export default function VerifyEmailPage() {
  const { t, locale, errorMessage, ready } = useI18n();
  const started = useRef(false);
  const [state, setState] = useState<State>({
    type: 'loading',
    title: 'در حال تأیید ایمیل…',
    body: 'لطفاً چند لحظه صبر کنید.',
    login: false,
    resend: false,
  });

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    const queryParams = new URLSearchParams(location.search);
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = hashParams.get('token') || queryParams.get('token') || '';
    if (!token) {
      setState({ type: 'err', title: t('auth.verifyLinkInvalidTitle'), body: t('auth.verifyTokenMissing'), login: false, resend: true });
      return;
    }
    queryParams.delete('token');
    const cleanUrl = location.pathname + (queryParams.toString() ? `?${queryParams.toString()}` : '');
    history.replaceState(null, document.title, cleanUrl);
    setState((s) => ({ ...s, title: t('pages.verify_email.verifying.email.2a98010f', null, s.title), body: t('pages.verify_email.please.wait.a.moment.a2879e3f', null, s.body) }));
    request('/api/v1/auth/verify-email', { method: 'POST', token: '', cache: 'no-store', body: { token, notificationLocale: locale } })
      .then(() => setState({ type: 'ok', title: t('auth.emailVerifiedTitle'), body: t('auth.emailVerified'), login: true, resend: false }))
      .catch((error: unknown) => {
        const status = error instanceof ApiError ? error.status : 0;
        setState({
          type: 'err',
          title: status ? t('auth.verificationFailedTitle') : t('auth.serverErrorTitle'),
          body: status ? errorMessage(error, 'auth.verificationLinkExpired') : t('auth.tryAgainOrResend'),
          login: false,
          resend: true,
        });
      });
  }, [ready, t, locale, errorMessage]);

  const glyph = state.type === 'ok' ? '✓' : state.type === 'err' ? '×' : '…';
  return (
    <div className="pg-verify-email">
      <div className="shell">
        <main className="card">
          <AuthBrand />
          <div className={`icon ${state.type}`} id="icon">
            {glyph}
          </div>
          <h1 id="title">{state.title}</h1>
          <p id="message">{state.body}</p>
          <Link className="btn" href="/login/" id="loginBtn" style={{ display: state.login ? 'inline-flex' : 'none' }}>
            {t('common.login.to.account.8181f948', null, 'ورود به حساب')}
          </Link>
          <Link className="secondary" href="/register/" id="resendBtn" style={{ display: state.resend ? 'inline-flex' : 'none' }}>
            {t('pages.verify_email.request.new.link.c50673c6', null, 'درخواست لینک جدید')}
          </Link>
        </main>
      </div>
      <LocaleSwitcher placement="dock" />
    </div>
  );
}
