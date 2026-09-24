"use client";
import React, { useEffect, useRef, useState } from "react";
import * as api from "../../lib/api/client";
import { useTimedMessage } from "../../lib/hooks/useTimedFlag";
import { PasswordField } from "../../components/ui/PasswordField";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { BrandLogo } from "../../components/brand/LogoMark";
import { AuthPageFrame } from "./components/AuthPageFrame";
import { AuthBrandPanel } from "./components/AuthBrandPanel";
import { MailIcon, LockIcon, EyeOpen, EyeShut, FootLockIcon } from "./components/authIcons";
import type { Locale } from "../../contracts/locale";
import { createTranslator } from "../../i18n/catalog";
import { htmlLang } from "../../i18n/registry";

// W1 login: capability-first, Modern contract adaptation.
// - No frontend password length policy (R1 OWNER DECISION): only non-empty check.
//   Backend enforces 10..128 via Zod, but frontend must NOT lock out 8-9 char legacy users.
// - Uses string IDs, fullName, details.messageKey via client.
// - Locale-aware via t()/number/percent, RTL/LTR via proxy html dir.
// - Security: no token in localStorage, HttpOnly cookie, no inline styles, nonce CSP.

type TFn = (k: string, p?: Record<string, unknown> | null, fb?: string) => string;

export function LoginForm({ locale }: { locale: Locale }) {
  const t: TFn = createTranslator(locale, ["common", "errors", "auth"]);
  const number = (v: unknown, o?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(htmlLang(locale), { ...o, numberingSystem: "latn" } as Intl.NumberFormatOptions).format(Number(v) || 0);
  const percent = (v: unknown, o?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(htmlLang(locale), { style: "percent", ...o, numberingSystem: "latn" } as Intl.NumberFormatOptions).format(Number(v) || 0);
  const error = useTimedMessage<string>(7000);
  const [btnState, setBtnState] = useState<"idle" | "busy" | "done">("idle");
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    // If already authenticated, go to dashboard (protected)
    api
      .ready()
      .then((user) => {
        if (user && api.getAccessToken()) {
          const target = locale === "en" ? "/en/dashboard" : "/dashboard";
          // Only redirect if user explicitly visited login while auth'd — don't break flow if they just landed
          // But 6F does immediate redirect; we keep it.
          window.location.replace(target);
        }
      })
      .catch(() => {});
  }, [locale]);

  const showError = error.show;

  function errorMessageFor(err: unknown, fallbackKey = "errors.api"): string {
    const e = err as api.ApiError;
    // Prefer Modern details.messageKey if present, else e.messageKey, else fallback
    const key = (e.details && typeof (e.details as Record<string, unknown>).messageKey === "string"
      ? String((e.details as Record<string, unknown>).messageKey)
      : e.messageKey) || fallbackKey;
    // Try to translate key via t, else use e.message
    const translated = t(key, (e.params as Record<string, unknown>) || null, "");
    if (translated && translated !== key) return translated;
    if (e.message && e.message !== e.code) return e.message;
    return t(fallbackKey, null, "Something went wrong.");
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const email = (emailRef.current?.value || "").trim().toLowerCase();
    const password = passRef.current?.value || "";
    const errs: Record<string, string> = {};
    if (!email) errs.email = t("auth.emailRequired", null, "Please enter your email.");
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.email = t("auth.emailInvalid", null, "Enter a valid email address.");
    if (!password) errs.password = t("auth.credentialsRequired", null, "Please enter your email and password.");
    // NOTE: no password length check here — R1 OWNER DECISION, backend will validate
    if (Object.keys(errs).length) {
      setFieldErrors(errs);
      showError(Object.values(errs).join(" "));
      return;
    }
    setFieldErrors({});
    setBtnState("busy");
    error.hide();
    try {
      const payload = await api.request<{ tokens?: api.TokenPayload }>("/api/v1/auth/login", {
        method: "POST",
        token: "",
        body: { email, password },
      });
      api.setSession(payload && payload.tokens);
      setBtnState("done");
      const target = locale === "en" ? "/en/dashboard" : "/dashboard";
      window.location.replace(target);
    } catch (err) {
      const e = err as api.ApiError;
      // Map known codes to localized messages — must bypass e.messageKey (http.4xx) for user-facing auth errors
      if (e.code === "EMAIL_NOT_VERIFIED") {
        showError(t("auth.verifyEmail", null, "Please verify your email first."));
        setBtnState("idle");
        return;
      }
      if (e.code === "INVALID_CREDENTIALS") {
        showError(t("errors.auth.invalidCredentials", null, "Invalid credentials."));
        setBtnState("idle");
        return;
      }
      if (e.code === "VALIDATION_FAILED") {
        const hasPasswordDetail = e.details && Object.prototype.hasOwnProperty.call(e.details, "password");
        if (hasPasswordDetail) {
          showError(t("errors.auth.invalidCredentials", null, "Invalid credentials."));
          setBtnState("idle");
          return;
        }
        showError(t("errors.validation", null, "Validation failed."));
        setBtnState("idle");
        if (e.details) {
          const fe: Record<string, string> = {};
          for (const [k, v] of Object.entries(e.details)) {
            if (k === "messageKey" || k === "params") continue;
            fe[k] = String(v);
          }
          if (Object.keys(fe).length) setFieldErrors(fe);
        }
        return;
      }
      if (e.code === "TOO_MANY_REQUESTS") {
        showError(t("errors.rateLimited", null, "Too many requests."));
        setBtnState("idle");
        return;
      }
      if (e.code === "ACCOUNT_INACTIVE") {
        showError(t("errors.auth.accountInactive", null, "Account inactive."));
        setBtnState("idle");
        return;
      }
      showError(errorMessageFor(err, "errors.api"));
      setBtnState("idle");
      // Surface field details if present
      if (e.details) {
        const fe: Record<string, string> = {};
        for (const [k, v] of Object.entries(e.details)) {
          if (k === "messageKey" || k === "params") continue;
          fe[k] = String(v);
        }
        if (Object.keys(fe).length) setFieldErrors(fe);
      }
    }
  }

  const isFa = locale === "fa";
  const dashboardUrl = locale === "en" ? "/en/dashboard" : "/dashboard";
  const registerUrl = locale === "en" ? "/en/register" : "/register";
  const forgotUrl = locale === "en" ? "/en/forgot-password" : "/forgot-password";

  return (
    <AuthPageFrame page="login">
      <AuthBrandPanel variant="login" t={t} number={number} percent={percent} />
      <div className="card-outer">
        <div className="card-inner">
          <BrandLogo />
          <h1 className="auth-title">
            <span>{t("pages.login.welcome.back.2437078d", null, "خوش برگشتید")}</span>
          </h1>
          <p className="auth-sub">{t("pages.login.login.to.access.your.trading.dashboard.32a261f6", null, "برای دسترسی به داشبورد معاملاتی خود وارد شوید")}</p>
          <form noValidate onSubmit={onSubmit} aria-busy={btnState === "busy"}>
            <InlineNotice visible={error.visible}>{error.value}</InlineNotice>
            <div className="field">
              <label htmlFor="email">{t("common.email.0cc870ea", null, "ایمیل")}</label>
              <div className="input-wrap">
                <span className="icon" aria-hidden="true">
                  <MailIcon />
                </span>
                <input ref={emailRef} autoComplete="email" id="email" name="email" placeholder="you@example.com" required type="email" aria-invalid={!!fieldErrors.email} />
              </div>
              {fieldErrors.email ? <div className="field-error" role="alert">{fieldErrors.email}</div> : null}
            </div>
            <div className="field">
              <div className="row-between">
                <label htmlFor="password">{t("common.password.656eabeb", null, "رمز عبور")}</label>
                <a className="forgot" href={forgotUrl}>
                  {t("pages.login.forgot.password.60e66930", null, "فراموشی رمز؟")}
                </a>
              </div>
              <PasswordField
                ref={passRef}
                autoComplete="current-password"
                id="password"
                name="password"
                placeholder="••••••••"
                required
                toggleLabel={t("common.show.password.9daec630", null, "نمایش رمز")}
                icon={
                  <>
                    <EyeOpen />
                    <span className="hidden-toggle">
                      <EyeShut />
                    </span>
                  </>
                }
              >
                <span className="icon" aria-hidden="true">
                  <LockIcon />
                </span>
              </PasswordField>
              {fieldErrors.password ? <div className="field-error" role="alert" >{fieldErrors.password}</div> : null}
            </div>
            <button className="btn-gold" type="submit" disabled={btnState === "busy"} aria-live="polite">
              {btnState === "busy" ? (
                <>
                  <span className="btn-spinner" aria-hidden="true" /> {t("auth.signingIn", null, "Signing in")}
                </>
              ) : btnState === "done" ? (
                t("auth.loginSuccess", null, "Signed in — redirecting")
              ) : (
                t("common.login.to.account.8181f948", null, "ورود به حساب")
              )}
            </button>
          </form>
          <div className="divider">{t("pages.login.login.with.velora.account.ef95b9e8", null, "ورود با حساب VELORA")}</div>
          <div className="auth-switch">
            <span>{t("pages.login.don.bab36e7c", null, "حساب ندارید؟")}</span> <a href={registerUrl}>{t("common.create.account.b71cd668", null, "ساخت حساب")}</a>
          </div>
          <div className="foot-note" >
            <FootLockIcon />
            <span>{t("pages.login.your.info.is.protected.with.advanced.encryption.3b0af8d8", null, "اطلاعات شما با رمزنگاری پیشرفته محافظت می‌شود")}</span>
          </div>
        </div>
      </div>
    </AuthPageFrame>
  );
}
