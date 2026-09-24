"use client";
import React, { useRef, useState } from "react";
import * as api from "../../lib/api/client";
import { useTimedMessage } from "../../lib/hooks/useTimedFlag";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { BrandLogo } from "../../components/brand/LogoMark";
import { AuthPageFrame } from "./components/AuthPageFrame";
import { MailIcon } from "./components/authIcons";
import type { Locale } from "../../contracts/locale";
import { createTranslator } from "../../i18n/catalog";

type TFn = (k: string, p?: Record<string, unknown> | null, fb?: string) => string;

export function ForgotPassword({ locale }: { locale: Locale }) {
  const t: TFn = createTranslator(locale, ["common", "errors", "auth"]);
  const emailRef = useRef<HTMLInputElement>(null);
  const notice = useTimedMessage<string>(7000);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const email = (emailRef.current?.value || "").trim().toLowerCase();
    if (!email) { notice.show(t("auth.emailRequired", null, "Please enter your email.")); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { notice.show(t("auth.emailInvalid", null, "Enter a valid email address.")); return; }
    setBusy(true);
    notice.hide();
    try {
      await api.request("/api/v1/auth/forgot-password", { method: "POST", token: "", body: { email } });
      setSent(true);
    } catch (err) {
      const e2 = err as api.ApiError;
      if (e2.code === "TOO_MANY_REQUESTS") notice.show(t("errors.rateLimited", null, "Too many requests."));
      else notice.show(t("auth.recoveryFailed", null, "The recovery link could not be sent."));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthPageFrame page="login">
        <div className="brand-panel hidden-panel" />
        <div className="card-outer">
          <div className="card-inner">
            <BrandLogo />
            <h1 className="auth-title">{t("pages.forgot_password.recover.password.c795cbe8", null, "Recover Password")}</h1>
            <p className="auth-sub">{t("auth.resetSent", null, "If an account exists for this email, a recovery link has been sent.")}</p>
            <a className="btn-gold btn-block mt-20" href={locale === "en" ? "/en/login" : "/login"}>
              {t("common.login.to.account.8181f948", null, "Login to Account")}
            </a>
          </div>
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame page="login">
      <div className="brand-panel hidden-panel" />
      <div className="card-outer">
        <div className="card-inner">
          <BrandLogo />
          <h1 className="auth-title">{t("pages.forgot_password.recover.password.c795cbe8", null, "Recover Password")}</h1>
          <p className="auth-sub">{t("pages.forgot_password.enter.your.account.email.if.an.account.f58bd55b", null, "Enter your account email. If an account exists for this address, we will send a recovery link.")}</p>
          <form noValidate onSubmit={onSubmit}>
            <InlineNotice visible={notice.visible}>{notice.value}</InlineNotice>
            <div className="field">
              <label htmlFor="email">{t("common.email.0cc870ea", null, "Email")}</label>
              <div className="input-wrap">
                <span className="icon"><MailIcon /></span>
                <input ref={emailRef} id="email" type="email" placeholder="you@example.com" autoComplete="email" required />
              </div>
            </div>
            <button className="btn-gold" type="submit" disabled={busy}>
              {busy ? <><span className="btn-spinner" aria-hidden="true" /> {t("auth.sending", null, "Sending")}</> : t("pages.forgot_password.send.recovery.link.d88ddcda", null, "Send recovery link")}
            </button>
          </form>
          <div className="auth-switch mt-20 center">
            <a href={locale === "en" ? "/en/login" : "/login"}>{t("pages.forgot_password.remember.your.password.6969160e", null, "Remember your password?")}</a>
          </div>
        </div>
      </div>
    </AuthPageFrame>
  );
}
