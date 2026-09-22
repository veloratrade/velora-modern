'use client';
/* Ported from legacy register/index.html (markup + inline script, 1:1 behaviour). */
import React, { useRef, useState } from 'react';
import './legacy.css';
import * as api from '@/lib/api/client';
import { useI18n } from '@/i18n/I18nProvider';
import { AuthPageFrame } from '@/components/auth/AuthPageFrame';
import { BrandLogo } from '@/components/brand/LogoMark';
import { useCooldown, useTimedMessage } from '@/lib/hooks/useTimedFlag';
import { InlineNotice } from '@/components/ui/InlineNotice';
import {
  RegUserIcon, RegMailIcon, RegLockIcon, RegEyeIcon, FeatChartIcon, FeatShieldIcon, FeatCardIcon,
  SparkIcon, CopyIcon, StepMailIcon, StepLinkIcon, StepLoginIcon, HeroEnvelope,
} from '@/components/auth/authIcons';

const COOLDOWN_SECONDS = 60;

function pad(n: number) { return String(n).padStart(2, '0'); }

export default function RegisterPage() {
  const { t, locale, errorMessage, number } = useI18n();
  const [showPass, setShowPass] = useState(false);
  const [passValue, setPassValue] = useState('');
  const error = useTimedMessage<string>(900);
  const [busy, setBusy] = useState(false);
  const [sentEmail, setSentEmail] = useState<string | null>(null);
  const cooldown = useCooldown();
  const [resendBusy, setResendBusy] = useState(false);
  const [resendDone, setResendDone] = useState(false); // label "auth.accountVerified"
  const [status, setStatus] = useState<{ cls: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  /* ---- password meter (legacy `passEl input` handler) ---- */
  const validLength = passValue.length >= 8;
  const validMix = /[A-Za-z]/.test(passValue) && /[0-9]/.test(passValue);
  const score = Number(passValue.length >= 8) + Number(passValue.length >= 12) + Number(validMix) + Number(/[^A-Za-z0-9]/.test(passValue));
  const meterClass = passValue ? 'meter-fill ' + (score >= 4 ? 'strong' : score >= 2 ? 'med' : 'weak') : 'meter-fill';
  const hintClass = 'hint ' + ((validLength && validMix) ? 'ok' : (passValue ? 'bad' : ''));
  const [hintTouched, setHintTouched] = useState(false);
  // Legacy: static hint until first `input` event, then live validation text.
  const hintText = !hintTouched
    ? t('pages.register.at.least.8.characters.including.one.latin.66575ed4', null, 'حداقل 8 کاراکتر، شامل یک حرف انگلیسی و یک عدد')
    : validLength && validMix
      ? t('auth.passwordStrong')
      : t('auth.passwordIncomplete', { suffix: passValue ? t('auth.passwordIncompleteSuffix') : '' });

  const showError = error.show;
  const startCooldown = () => cooldown.start(COOLDOWN_SECONDS);

  function showSuccess(email: string) {
    setSentEmail(email);
    startCooldown();
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const email = (emailRef.current?.value || '').trim().toLowerCase();
    const password = passRef.current?.value || '';
    const fullName = (nameRef.current?.value || '').trim();
    if (!email) { showError(t('auth.emailRequired')); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showError(t('auth.emailInvalid')); return; }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) { showError(t('auth.passwordInvalid')); return; }
    setBusy(true);
    error.hide();
    try {
      const payload = await api.request<{ tokens?: { email?: string } }>('/api/v1/auth/register', {
        method: 'POST', token: '',
        body: { email, password, full_name: fullName, locale, notificationLocale: locale },
      });
      const tokens = payload && payload.tokens;
      showSuccess(tokens && tokens.email ? tokens.email : email);
    } catch (err) {
      showError(errorMessage(err, 'auth.registrationFailed'));
      setBusy(false);
    }
  }

  async function triggerResend() {
    if (!sentEmail) return;
    setResendBusy(true);
    try {
      const payload = await api.request<{ alreadyVerified?: boolean }>('/api/v1/auth/resend-verification', {
        method: 'POST', token: '', body: { email: sentEmail, notificationLocale: locale },
      });
      if (payload && payload.alreadyVerified) {
        setStatus({ cls: 'status-msg info', text: t('auth.alreadyVerified') });
        setResendDone(true);
      } else {
        setStatus({ cls: 'status-msg ok', text: t('auth.verificationSent') });
        startCooldown();
      }
    } catch (err) {
      const e = err as api.ApiError;
      setStatus({ cls: 'status-msg err', text: e.status === 429 ? t('auth.resendLimited') : errorMessage(err, 'auth.resendFailed') });
      startCooldown();
    } finally {
      setResendBusy(false);
    }
  }

  function copyEmail() {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    if (sentEmail && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(sentEmail).then(done).catch(done);
    else done();
  }

  const resendLabel = resendBusy
    ? (<><span className="btn-spinner" /> {t('auth.sending')}</>)
    : resendDone ? t('auth.accountVerified')
    : cooldown.active ? t('auth.resendCountdown', { time: `${pad(Math.floor(cooldown.remaining / 60))}:${pad(cooldown.remaining % 60)}` })
    : t('auth.resendVerification');
  const ringPct = cooldown.fraction;

  return (
    <AuthPageFrame page="register">
      <div className="brand-panel">
        <BrandLogo />
        <h2>
          <span>{t('pages.register.start.journey.1153dc1c', null, 'شروع مسیر')}</span><br />
          <span className="grad">{t('pages.register.professional.trading.5cfc39d9', null, 'معامله‌گری حرفه‌ای')}</span>
        </h2>
        <p className="sub">{t('pages.register.start.recording.analysing.and.improving.your.trades.1b6aad36', null, 'از همین امروز معاملات خود را ثبت، تحلیل و بهینه کنید — بدون محدودیت.')}</p>
        <div className="brand-feat">
          <div className="bf">
            <div className="ic"><FeatChartIcon /></div>
            <div><b>{t('pages.register.deep.performance.analysis.78e2ed0b', null, 'تحلیل عمیق عملکرد')}</b><span>{t('pages.register.win.rate.profit.factor.average.r.and.271981f1', null, 'نرخ برد، فاکتور سود، میانگین R و منحنی سرمایه')}</span></div>
          </div>
          <div className="bf">
            <div className="ic"><FeatShieldIcon /></div>
            <div><b>{t('pages.register.bank.level.security.70c4bc21', null, 'امنیت در سطح بانکی')}</b><span>{t('pages.register.token.encryption.two.factor.authentication.and.session.2720f3fd', null, 'رمزنگاری توکن‌ها، ورود دو مرحله‌ای و مدیریت نشست‌ها')}</span></div>
          </div>
          <div className="bf">
            <div className="ic"><FeatCardIcon /></div>
            <div><b>{t('pages.register.synced.with.mt4.mt5.e94069d4', null, 'همگام با MT4 / MT5')}</b><span>{t('pages.register.automatic.trade.logging.and.multi.broker.account.423e2a76', null, 'ثبت خودکار معاملات و مدیریت چند حساب بروکر')}</span></div>
          </div>
        </div>
      </div>

      <div className="card-outer">
        <div className="card-inner">
          <BrandLogo />

          {/* form view */}
          <div id="formView" style={sentEmail ? { display: 'none' } : undefined}>
            <h1 className="auth-title"><span>{t('common.create.account.b71cd668', null, 'ساخت حساب')}</span> <span className="grad">{t('pages.register.new.123689fe', null, 'جدید')}</span></h1>
            <p className="auth-sub">{t('pages.register.welcome.to.velora.your.professional.journey.starts.b6f07ff0', null, 'به VELORA خوش آمدید — سفر حرفه‌ای شما از اینجا شروع می‌شود')}</p>
            <form id="regForm" noValidate onSubmit={onSubmit}>
              <InlineNotice visible={error.visible}>{error.value}</InlineNotice>
              <div className="field">
                <label htmlFor="name"><span>{t('pages.register.full.name.f6bb7d96', null, 'نام و نام خانوادگی')}</span> <span style={{ color: 'var(--faint)', fontWeight: 400 }}>{t('pages.register.optional.dd853d28', null, '(اختیاری)')}</span></label>
                <div className="input-wrap">
                  <span className="icon"><RegUserIcon /></span>
                  <input ref={nameRef} autoComplete="name" id="name" name="full_name" placeholder={t('pages.register.for.example.alex.morgan.6980ecc3', null, 'مثلاً: امیر محمدی')} type="text" />
                </div>
              </div>
              <div className="field">
                <label htmlFor="email">{t('common.email.0cc870ea', null, 'ایمیل')}</label>
                <div className="input-wrap">
                  <span className="icon"><RegMailIcon /></span>
                  <input ref={emailRef} autoComplete="email" id="email" name="email" placeholder="you@example.com" required type="email" />
                </div>
              </div>
              <div className="field">
                <label htmlFor="password">{t('common.password.656eabeb', null, 'رمز عبور')}</label>
                <div className="input-wrap">
                  <span className="icon"><RegLockIcon /></span>
                  <input
                    ref={passRef} autoComplete="new-password" id="password" name="password" required
                    placeholder={t('common.minimum.8.characters.0a76ac5c', null, 'حداقل 8 کاراکتر')}
                    type={showPass ? 'text' : 'password'}
                    onInput={(e) => { setPassValue((e.target as HTMLInputElement).value); setHintTouched(true); }}
                  />
                  <button aria-label={t('common.show.password.9daec630', null, 'نمایش رمز')} className="toggle" id="togglePass" type="button" onClick={() => setShowPass((v) => !v)}>
                    <RegEyeIcon />
                  </button>
                </div>
                <div className="meter"><div className={meterClass} id="meterFill" /></div>
                <div className={hintClass} id="passHint">{hintText}</div>
              </div>
              <button className="btn-gold" id="submitBtn" type="submit" disabled={busy}>
                {busy ? (<><span className="btn-spinner" /> {t('auth.creatingAccount')}</>) : t('common.create.account.b71cd668', null, 'ساخت حساب')}
              </button>
            </form>
            <div className="divider">{t('pages.register.quick.secure.registration.04d074c2', null, 'ثبت‌نام سریع و امن')}</div>
            <div className="auth-switch">
              <span>{t('pages.register.already.have.an.account.25c3e5ca', null, 'قبلاً حساب دارید؟')}</span> <a href="/login">{t('common.login.to.account.8181f948', null, 'ورود به حساب')}</a>
            </div>
            <div className="foot-note">{t('pages.register.by.signing.up.you.accept.velora.terms.06d9b8c4', null, 'با ثبت‌نام، قوانین و حریم خصوصی VELORA را می‌پذیرید.')}</div>
          </div>

          {/* success panel */}
          <div className={`success-panel${sentEmail ? ' show' : ''}`} id="successView">
            <div className="hero">
              <span className="spark s1" /><span className="spark s2" /><span className="spark s3" /><span className="spark s4" />
              <span className="hero-ring" /><span className="hero-ring2" />
              <div className="hero-core"><HeroEnvelope /></div>
            </div>
            <h2>
              <span>{t('pages.register.your.account.was.successfully.7b089076', null, 'حساب شما با موفقیت')}</span>{' '}
              <span className="gold"><span>{t('pages.register.was.created.27e65791', null, 'ایجاد شد')}</span> <SparkIcon /></span>
            </h2>
            <p className="lead">
              <span>{t('pages.register.to.activate.your.account.verification.link.02b56d15', null, 'برای فعال‌سازی حساب، لینک تأیید')}</span>{' '}
              <b>{t('pages.register.24h.b85cf297', null, '24 ساعته')}</b>{' '}
              <span>{t('pages.register.was.sent.to.this.address.977d7407', null, 'به این آدرس ارسال شد:')}</span>
            </p>
            <div className="sent-wrap">
              <span className="lbl"><span>{t('pages.register.send.to.3cdb287f', null, 'ارسال به')}</span><b><br id="sentMail" />{sentEmail || '—'}</b></span>
              <span className="mail" id="emailBadge">{sentEmail || '—'}</span>
              <button className={`copy-btn${copied ? ' copied' : ''}`} id="copyEmail" title={t('pages.register.copy.email.9f1033dd', null, 'کپی ایمیل')} type="button" onClick={copyEmail}>
                <CopyIcon />
              </button>
            </div>
            <div className="steps">
              {[
                { n: 1, icon: <StepMailIcon />, b: t('pages.register.check.your.inbox.c31b68f4', null, 'صندوق ورودی را چک کنید'), s: t('pages.register.inbox.or.spam.junk.if.not.found.a2ce5edb', null, 'پوشه Inbox و اگر نبود، Spam یا Junk') },
                { n: 2, icon: <StepLinkIcon />, b: t('pages.register.click.the.verification.link.8994e3d9', null, 'روی لینک تأیید کلیک کنید'), s: t('pages.register.the.email.link.activates.your.account.instantly.f12be73a', null, 'لینک داخل ایمیل، حساب شما را فوراً فعال می‌کند') },
                { n: 3, icon: <StepLoginIcon />, b: t('pages.register.back.start.trading.6849c6a6', null, 'بازگشت و شروع معامله'), s: t('pages.register.login.and.start.your.trading.journal.2ac941b5', null, 'وارد شوید و ژورنال معاملاتی را شروع کنید') },
              ].map((st) => (
                <div className="step" key={st.n}>
                  <div className="step-track">
                    <div className="step-badge"><span className="step-count">{number(st.n, { maximumFractionDigits: 0 })}</span>{st.icon}</div>
                    <div className="step-line" />
                  </div>
                  <div className="step-body"><b>{st.b}</b><span>{st.s}</span></div>
                </div>
              ))}
            </div>
            <div className="divider">{t('pages.register.didn.a903ee47', null, 'ایمیل به دستتان نرسید؟')}</div>
            <div id="resendStatus" className={status?.cls}>{status?.text}</div>
            <div className="resend-row">
              <button className="btn-resend" disabled={cooldown.active || resendBusy || resendDone} id="resendBtn" onClick={triggerResend} type="button">
                <span className="ring" id="resendRing" style={{ ['--pct' as string]: ringPct } as React.CSSProperties} />
                <span id="resendLabel">{resendLabel}</span>
              </button>
              <a className="btn-login" href="/login" style={{ marginTop: 0 }}>
                <StepLoginIcon size={15} sw={2.4} />
                <span>{t('common.login.to.account.8181f948', null, 'ورود به حساب')}</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </AuthPageFrame>
  );
}
