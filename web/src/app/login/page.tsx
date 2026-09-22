'use client';
/* Ported from legacy login/index.html (markup + inline script, 1:1 behaviour). */
import React, { useEffect, useRef, useState } from 'react';
import './legacy.css';
import * as api from '@/lib/api/client';
import { useI18n } from '@/i18n/I18nProvider';
import { AuthPageFrame } from '@/components/auth/AuthPageFrame';
import { AuthBrandPanel } from '@/components/auth/AuthBrandPanel';
import { BrandLogo } from '@/components/brand/LogoMark';
import { useTimedMessage } from '@/lib/hooks/useTimedFlag';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { MailIcon, LockIcon, EyeOpen, EyeShut, FootLockIcon } from '@/components/auth/authIcons';

/* Legacy navigates to `/${locale}/dashboard/` (URL locale prefix). The modern app
   has no locale-prefixed routes yet (migration map, deferred item), so the
   unprefixed path is used; locale is still resolved via cookie/localStorage. */
const DASHBOARD_URL = '/dashboard/';

export default function LoginPage() {
  const { t, locale } = useI18n();
  const [showPass, setShowPass] = useState(false);
  const error = useTimedMessage<string>(700);
  const [btnState, setBtnState] = useState<'idle' | 'busy' | 'done'>('idle');
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.ready().then((user) => {
      if (user && api.getAccessToken()) window.location.replace(DASHBOARD_URL);
    }).catch(() => {});
  }, []);

  const showError = error.show;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const email = (emailRef.current?.value || '').trim();
    const password = passRef.current?.value || '';
    if (!email || !password) { showError(t('auth.credentialsRequired')); return; }
    setBtnState('busy');
    error.hide();
    try {
      const payload = await api.request<{ tokens?: api.TokenPayload }>('/api/v1/auth/login', {
        method: 'POST', token: '', body: { email, password, notificationLocale: locale },
      });
      api.setSession(payload && payload.tokens);
      setBtnState('done');
      window.location.replace(DASHBOARD_URL);
    } catch (err) {
      const e = err as api.ApiError;
      showError(t(e.code === 'EMAIL_NOT_VERIFIED' ? 'auth.verifyEmail' : (e.messageKey || 'errors.api')));
      setBtnState('idle');
    }
  }

  return (
    <AuthPageFrame page="login">
      <AuthBrandPanel variant="login" />
      <div className="card-outer">
        <div className="card-inner">
          <BrandLogo />
          <h1 className="auth-title"><span>{t('pages.login.welcome.back.2437078d', null, 'خوش برگشتید')}</span></h1>
          <p className="auth-sub">{t('pages.login.login.to.access.your.trading.dashboard.32a261f6', null, 'برای دسترسی به داشبورد معاملاتی خود وارد شوید')}</p>
          <form id="loginForm" noValidate onSubmit={onSubmit}>
            <InlineNotice visible={error.visible}>{error.value}</InlineNotice>
            <div className="field">
              <label htmlFor="email">{t('common.email.0cc870ea', null, 'ایمیل')}</label>
              <div className="input-wrap">
                <span className="icon" aria-hidden="true"><MailIcon /></span>
                <input ref={emailRef} autoComplete="email" id="email" name="email" placeholder="you@example.com" required type="email" />
              </div>
            </div>
            <div className="field">
              <div className="row-between">
                <label htmlFor="password">{t('common.password.656eabeb', null, 'رمز عبور')}</label>
                <a className="forgot" href="/forgot-password">{t('pages.login.forgot.password.60e66930', null, 'فراموشی رمز؟')}</a>
              </div>
              <div className="input-wrap">
                <span className="icon" aria-hidden="true"><LockIcon /></span>
                <input ref={passRef} autoComplete="current-password" id="password" name="password" placeholder="••••••••" required type={showPass ? 'text' : 'password'} />
                <button aria-label={t('common.show.password.9daec630', null, 'نمایش رمز')} className="toggle" id="togglePass" type="button" onClick={() => setShowPass((v) => !v)}>
                  <EyeOpen />
                  <span style={{ display: 'none' }}><EyeShut /></span>
                </button>
              </div>
            </div>
            <button className="btn-gold" id="submitBtn" type="submit" disabled={btnState === 'busy'}>
              {btnState === 'busy' ? (<><span className="btn-spinner" /> {t('auth.signingIn')}</>)
                : btnState === 'done' ? t('auth.loginSuccess')
                : t('common.login.to.account.8181f948', null, 'ورود به حساب')}
            </button>
          </form>
          <div className="divider">{t('pages.login.login.with.velora.account.ef95b9e8', null, 'ورود با حساب VELORA')}</div>
          <div className="auth-switch">
            <span>{t('pages.login.don.bab36e7c', null, 'حساب ندارید؟')}</span> <a href="/register">{t('common.create.account.b71cd668', null, 'ساخت حساب')}</a>
          </div>
          <div className="foot-note">
            <FootLockIcon />
            <span>{t('pages.login.your.info.is.protected.with.advanced.encryption.3b0af8d8', null, 'اطلاعات شما با رمزنگاری پیشرفته محافظت می‌شود')}</span>
          </div>
        </div>
      </div>
    </AuthPageFrame>
  );
}
