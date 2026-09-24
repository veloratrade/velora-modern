"use client";
import React, { useRef, useState } from "react";
import * as api from "../../lib/api/client";
import { useCooldown, useTimedMessage } from "../../lib/hooks/useTimedFlag";
import { PasswordField } from "../../components/ui/PasswordField";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { BrandLogo } from "../../components/brand/LogoMark";
import { AuthPageFrame } from "./components/AuthPageFrame";
import { BrandLogo as BrandLogo2 } from "../../components/brand/LogoMark";
import { RegUserIcon, RegMailIcon, RegLockIcon, RegEyeIcon, FeatChartIcon, FeatShieldIcon, FeatCardIcon, SparkIcon, CopyIcon, HeroEnvelope } from "./components/authIcons";
import type { Locale } from "../../contracts/locale";
import { createTranslator } from "../../i18n/catalog";

type TFn = (k: string, p?: Record<string, unknown> | null, fb?: string) => string;
const COOLDOWN_SECONDS = 60;
function pad(n: number) { return String(n).padStart(2, "0"); }

export function RegisterForm({ locale }: { locale: Locale }) {
  const t: TFn = createTranslator(locale, ["common", "errors", "auth"]);
  const [passValue, setPassValue] = useState("");
  const error = useTimedMessage<string>(9000);
  const [busy, setBusy] = useState(false);
  const [sentEmail, setSentEmail] = useState<string | null>(null);
  const cooldown = useCooldown();
  const [resendBusy, setResendBusy] = useState(false);
  const [resendDone, setResendDone] = useState(false);
  const [status, setStatus] = useState<{ cls: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  // Modern policy: 10..128 (not 8). Meter mirrors legacy but thresholds adapted.
  const validLength = passValue.length >= 10;
  const validMix = /[A-Za-z]/.test(passValue) && /[0-9]/.test(passValue);
  const score = Number(passValue.length >= 10) + Number(passValue.length >= 12) + Number(validMix) + Number(/[^A-Za-z0-9]/.test(passValue));
  const meterClass = passValue ? "meter-fill " + (score >= 4 ? "strong" : score >= 2 ? "med" : "weak") : "meter-fill";
  const hintClass = "hint " + (validLength && validMix ? "ok" : passValue ? "bad" : "");
  const [hintTouched, setHintTouched] = useState(false);
  const hintText = !hintTouched
    ? t("pages.register.at.least.8.characters.including.one.latin.66575ed4", null, "حداقل 10 کاراکتر، شامل یک حرف انگلیسی و یک عدد")
    : validLength && validMix
      ? t("auth.passwordStrong", null, "Strong password")
      : t("auth.passwordIncomplete", { suffix: passValue ? t("auth.passwordIncompleteSuffix", null, " — not complete yet") : "" }, "At least 10 characters, including one Latin letter and one number");

  const startCooldown = () => cooldown.start(COOLDOWN_SECONDS);

  function showSuccess(email: string) {
    setSentEmail(email);
    startCooldown();
  }

  function errorMessageFor(err: unknown, fallbackKey = "auth.registrationFailed"): string {
    const e = err as api.ApiError;
    const key = (e.details && typeof (e.details as Record<string, unknown>).messageKey === "string"
      ? String((e.details as Record<string, unknown>).messageKey)
      : e.messageKey) || fallbackKey;
    const translated = t(key, (e.params as Record<string, unknown>) || null, "");
    if (translated && translated !== key) return translated;
    if (e.message && e.message !== e.code) return e.message;
    return t(fallbackKey, null, "Account creation failed.");
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const email = (emailRef.current?.value || "").trim().toLowerCase();
    const password = passRef.current?.value || "";
    const fullName = (nameRef.current?.value || "").trim();
    if (!email) { error.show(t("auth.emailRequired", null, "Please enter your email.")); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { error.show(t("auth.emailInvalid", null, "Enter a valid email address.")); return; }
    // Modern policy: 10..128
    if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      error.show(t("auth.passwordInvalid", null, "The password must be at least 10 characters and include one Latin letter and one number."));
      return;
    }
    if (fullName.length > 100) { error.show(t("errors.validation.maxLength", { max: 100 }, "Full name is too long.")); return; }
    setBusy(true);
    error.hide();
    try {
      // Modern contract: POST /api/v1/auth/register {email, password, fullName, locale}
      // Not full_name, not notificationLocale
      const payload = await api.request<{ verificationRequired?: boolean; email?: string }>("/api/v1/auth/register", {
        method: "POST",
        token: "",
        body: { email, password, fullName: fullName || undefined, locale },
      });
      const targetEmail = (payload && payload.email) || email;
      showSuccess(targetEmail);
      setBusy(false);
    } catch (err) {
      const e = err as api.ApiError;
      // Map duplicate
      let msg = errorMessageFor(err, "auth.registrationFailed");
      if (e.code === "EMAIL_ALREADY_REGISTERED") msg = t("errors.auth.emailAlreadyRegistered", null, "Email already registered.");
      else if (e.code === "TOO_MANY_REQUESTS") msg = t("errors.rateLimited", null, "Too many requests.");
      else if (e.code === "VALIDATION_FAILED" && e.details) {
        // Surface first field error
        const first = Object.values(e.details).find((v) => typeof v === "string") as string | undefined;
        if (first) msg = first;
      }
      error.show(msg);
      setBusy(false);
    }
  }

  async function triggerResend() {
    if (!sentEmail) return;
    setResendBusy(true);
    try {
      const payload = await api.request<{ alreadyVerified?: boolean }>("/api/v1/auth/resend-verification", {
        method: "POST",
        token: "",
        body: { email: sentEmail },
      });
      if (payload && payload.alreadyVerified) {
        setStatus({ cls: "status-msg info", text: t("auth.alreadyVerified", null, "Your account is already verified.") });
        setResendDone(true);
      } else {
        setStatus({ cls: "status-msg ok", text: t("auth.verificationSent", null, "A new verification link was sent.") });
        startCooldown();
      }
    } catch (err) {
      const e = err as api.ApiError;
      setStatus({ cls: "status-msg err", text: e.status === 429 ? t("auth.resendLimited", null, "Security limit: no more than 3 attempts in 24 hours.") : errorMessageFor(err, "auth.resendFailed") });
      startCooldown();
    } finally {
      setResendBusy(false);
    }
  }

  function copyEmail() {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    if (sentEmail && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(sentEmail).then(done).catch(done);
    else done();
  }

  const loginUrl = locale === "en" ? "/en/login" : "/login";
  const resendLabel = resendBusy
    ? <><span className="btn-spinner" aria-hidden="true" /> {t("auth.sending", null, "Sending")}</>
    : resendDone
      ? t("auth.accountVerified", null, "Account verified")
      : cooldown.active
        ? t("auth.resendCountdown", { time: `${pad(Math.floor(cooldown.remaining / 60))}:${pad(cooldown.remaining % 60)}` }, `Resend verification email (${pad(Math.floor(cooldown.remaining / 60))}:${pad(cooldown.remaining % 60)})`)
        : t("auth.resendVerification", null, "Resend verification email");

  if (sentEmail) {
    return (
      <AuthPageFrame page="register">
        <div className="brand-panel brand-panel-flex">
          <BrandLogo2 />
          <h2>
            <span>{t("pages.register.start.journey.1153dc1c", null, "شروع مسیر")}</span>
            <br />
            <span className="grad">{t("pages.register.professional.trading.5cfc39d9", null, "معامله‌گری حرفه‌ای")}</span>
          </h2>
          <p className="sub">{t("pages.register.start.recording.analysing.and.improving.your.trades.1b6aad36", null, "از همین امروز معاملات خود را ثبت، تحلیل و بهینه کنید — بدون محدودیت.")}</p>
          <div className="brand-feat">
            <div className="bf">
              <div className="ic"><FeatChartIcon /></div>
              <div><b>{t("pages.register.deep.performance.analysis.78e2ed0b", null, "تحلیل عمیق عملکرد")}</b><span>{t("pages.register.win.rate.profit.factor.average.r.and.271981f1", null, "نرخ برد، فاکتور سود، میانگین R و منحنی سرمایه")}</span></div>
            </div>
            <div className="bf">
              <div className="ic"><FeatShieldIcon /></div>
              <div><b>{t("pages.register.bank.level.security.70c4bc21", null, "امنیت در سطح بانکی")}</b><span>{t("pages.register.token.encryption.two.factor.authentication.and.session.2720f3fd", null, "رمزنگاری توکن‌ها، ورود دو مرحله‌ای و مدیریت نشست‌ها")}</span></div>
            </div>
            <div className="bf">
              <div className="ic"><FeatCardIcon /></div>
              <div><b>{t("pages.register.synced.with.mt4.mt5.e94069d4", null, "همگام با MT4 / MT5")}</b><span>{t("pages.register.automatic.trade.logging.and.multi.broker.account.423e2a76", null, "ثبت خودکار معاملات و مدیریت چند حساب بروکر")}</span></div>
            </div>
          </div>
        </div>

        <div className="card-outer">
          <div className="card-inner">
            <BrandLogo />
            <div className="success-panel show" id="successView">
              <div className="hero">
                <span className="spark s1" />
                <span className="spark s2" />
                <span className="spark s3" />
                <span className="spark s4" />
                <span className="hero-ring" />
                <span className="hero-ring2" />
                <div className="hero-core">
                  <HeroEnvelope />
                </div>
              </div>
              <h2>
                <span>{t("pages.register.your.account.was.successfully.7b089076", null, "حساب شما با موفقیت")}</span>{" "}
                <span className="gold"><span>{t("pages.register.was.created.27e65791", null, "ایجاد شد")}</span> <SparkIcon /></span>
              </h2>
              <p className="lead">
                {t("pages.register.to.activate.your.account.verification.link.02b56d15", null, "To activate your account, verification link")}{" "}
                {t("pages.register.was.sent.to.this.address.977d7407", null, "was sent to this address:")}
              </p>
              <div className="email-chip">
                <span className="email">{sentEmail}</span>
                <button type="button" className="copy" onClick={copyEmail} aria-label={t("pages.register.copy.email.9f1033dd", null, "Copy email")}>
                  <CopyIcon /> {copied ? t("common.copied", null, "Copied") : t("pages.register.copy.email.9f1033dd", null, "Copy email")}
                </button>
              </div>
              <div className="steps">
                <div className="step"><span className="ic"><FeatChartIcon /></span><b>{t("pages.register.check.your.inbox.c31b68f4", null, "Check your inbox")}</b><span>{t("pages.register.inbox.or.spam.junk.if.not.found.a2ce5edb", null, "Inbox, or Spam/Junk if not found")}</span></div>
                <div className="step"><span className="ic"><FeatShieldIcon /></span><b>{t("pages.register.click.the.verification.link.8994e3d9", null, "Click the verification link")}</b><span>{t("pages.register.the.email.link.activates.your.account.instantly.f12be73a", null, "The email link activates your account instantly")}</span></div>
                <div className="step"><span className="ic"><FeatCardIcon /></span><b>{t("pages.register.login.and.start.your.trading.journal.2ac941b5", null, "Login and start your trading journal")}</b><span>{t("pages.register.back.start.trading.6849c6a6", null, "Back & Start Trading")}</span></div>
              </div>
              {status ? <div className={status.cls}>{status.text}</div> : null}
              <div className="resend-row">
                <button type="button" className="btn-gold btn-flex" disabled={cooldown.active || resendBusy} onClick={triggerResend}>
                  {resendLabel}
                </button>
                <a className="btn-ghost btn-ghost-flex" href={loginUrl}>
                  {t("pages.register.back.start.trading.6849c6a6", null, "Back & Start Trading")}
                </a>
              </div>
              <div className="progress-wrap">
                <div className="progress-fill" data-fraction={cooldown.fraction} />
              </div>
            </div>
          </div>
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame page="register">
      <div className="brand-panel">
        <BrandLogo />
        <h2>
          <span>{t("pages.register.start.journey.1153dc1c", null, "شروع مسیر")}</span>
          <br />
          <span className="grad">{t("pages.register.professional.trading.5cfc39d9", null, "معامله‌گری حرفه‌ای")}</span>
        </h2>
        <p className="sub">{t("pages.register.start.recording.analysing.and.improving.your.trades.1b6aad36", null, "از همین امروز معاملات خود را ثبت، تحلیل و بهینه کنید — بدون محدودیت.")}</p>
        <div className="brand-feat">
          <div className="bf">
            <div className="ic"><FeatChartIcon /></div>
            <div><b>{t("pages.register.deep.performance.analysis.78e2ed0b", null, "تحلیل عمیق عملکرد")}</b><span>{t("pages.register.win.rate.profit.factor.average.r.and.271981f1", null, "نرخ برد، فاکتور سود، میانگین R و منحنی سرمایه")}</span></div>
          </div>
          <div className="bf">
            <div className="ic"><FeatShieldIcon /></div>
            <div><b>{t("pages.register.bank.level.security.70c4bc21", null, "امنیت در سطح بانکی")}</b><span>{t("pages.register.token.encryption.two.factor.authentication.and.session.2720f3fd", null, "رمزنگاری توکن‌ها، ورود دو مرحله‌ای و مدیریت نشست‌ها")}</span></div>
          </div>
          <div className="bf">
            <div className="ic"><FeatCardIcon /></div>
            <div><b>{t("pages.register.synced.with.mt4.mt5.e94069d4", null, "همگام با MT4 / MT5")}</b><span>{t("pages.register.automatic.trade.logging.and.multi.broker.account.423e2a76", null, "ثبت خودکار معاملات و مدیریت چند حساب بروکر")}</span></div>
          </div>
        </div>
      </div>

      <div className="card-outer">
        <div className="card-inner">
          <BrandLogo />
          <div id="formView">
            <h1 className="auth-title">
              <span>{t("common.create.account.b71cd668", null, "ساخت حساب")}</span> <span className="grad">{t("pages.register.new.123689fe", null, "جدید")}</span>
            </h1>
            <p className="auth-sub">{t("pages.register.welcome.to.velora.your.professional.journey.starts.b6f07ff0", null, "به VELORA خوش آمدید — سفر حرفه‌ای شما از اینجا شروع می‌شود")}</p>
            <form noValidate onSubmit={onSubmit}>
              <InlineNotice visible={error.visible}>{error.value}</InlineNotice>
              <div className="field">
                <label htmlFor="name">
                  <span>{t("pages.register.full.name.f6bb7d96", null, "نام و نام خانوادگی")}</span>{" "}
                  <span className="optional-label">{t("pages.register.optional.dd853d28", null, "(اختیاری)")}</span>
                </label>
                <div className="input-wrap">
                  <span className="icon"><RegUserIcon /></span>
                  <input ref={nameRef} autoComplete="name" id="name" name="fullName" placeholder={t("pages.register.for.example.alex.morgan.6980ecc3", null, "مثلاً: امیر محمدی")} type="text" maxLength={100} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="email">{t("common.email.0cc870ea", null, "ایمیل")}</label>
                <div className="input-wrap">
                  <span className="icon"><RegMailIcon /></span>
                  <input ref={emailRef} autoComplete="email" id="email" name="email" placeholder="you@example.com" required type="email" />
                </div>
              </div>
              <div className="field">
                <label htmlFor="password">{t("common.password.656eabeb", null, "رمز عبور")}</label>
                <PasswordField
                  ref={passRef}
                  autoComplete="new-password"
                  id="password"
                  name="password"
                  required
                  placeholder={t("common.minimum.8.characters.0a76ac5c", null, "حداقل 10 کاراکتر")}
                  onInput={(e) => { setPassValue((e.target as HTMLInputElement).value); setHintTouched(true); }}
                  toggleLabel={t("common.show.password.9daec630", null, "نمایش رمز")}
                  icon={<RegEyeIcon />}
                >
                  <span className="icon"><RegLockIcon /></span>
                </PasswordField>
                <div className="meter"><div className={meterClass} /></div>
                <div className={hintClass}>{hintText}</div>
              </div>
              <button className="btn-gold" type="submit" disabled={busy}>
                {busy ? <><span className="btn-spinner" aria-hidden="true" /> {t("auth.creatingAccount", null, "Creating account")}</> : t("common.create.account.b71cd668", null, "ساخت حساب")}
              </button>
            </form>
            <div className="divider">{t("pages.register.quick.secure.registration.04d074c2", null, "ثبت‌نام سریع و امن")}</div>
            <div className="auth-switch">
              <span>{t("pages.register.already.have.an.account.25c3e5ca", null, "قبلاً حساب دارید؟")}</span> <a href={locale === "en" ? "/en/login" : "/login"}>{t("common.login.to.account.8181f948", null, "ورود به حساب")}</a>
            </div>
            <div className="foot-note">{t("pages.register.by.signing.up.you.accept.velora.terms.06d9b8c4", null, "با ثبت‌نام، قوانین و حریم خصوصی VELORA را می‌پذیرید.")}</div>
          </div>
        </div>
      </div>
    </AuthPageFrame>
  );
}
