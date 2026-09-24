"use client";
import React, { useEffect, useRef, useState } from "react";
import * as api from "../../lib/api/client";
import { useTimedMessage } from "../../lib/hooks/useTimedFlag";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { PasswordField } from "../../components/ui/PasswordField";
import { BrandLogo } from "../../components/brand/LogoMark";
import { AuthPageFrame } from "./components/AuthPageFrame";
import { RegLockIcon, RegEyeIcon } from "./components/authIcons";
import type { Locale } from "../../contracts/locale";
import { createTranslator } from "../../i18n/catalog";

type TFn = (k: string, p?: Record<string, unknown> | null, fb?: string) => string;

export function ResetPassword({ locale }: { locale: Locale }) {
  const t: TFn = createTranslator(locale, ["common", "errors", "auth"]);
  const tokenRef = useRef<string>("");
  const passRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const notice = useTimedMessage<string>(7000);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const hash = window.location.hash || "";
    const search = window.location.search || "";
    let token: string | null = null;
    if (hash.includes("token=")) token = new URLSearchParams(hash.slice(1)).get("token");
    else if (search.includes("token=")) token = new URLSearchParams(search).get("token");
    if (!token) setMissing(true);
    else tokenRef.current = token;
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (missing) { notice.show(t("auth.resetTokenMissing", null, "The recovery token is missing.")); return; }
    const p = passRef.current?.value || "";
    const c = confirmRef.current?.value || "";
    if (p.length < 10 || !/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) { notice.show(t("auth.passwordInvalid", null, "The password must be at least 10 characters and include one Latin letter and one number.")); return; }
    if (p !== c) { notice.show(t("auth.passwordMismatch", null, "The password confirmation does not match.")); return; }
    setBusy(true);
    notice.hide();
    try {
      await api.request("/api/v1/auth/reset-password", { method: "POST", token: "", body: { token: tokenRef.current, newPassword: p } });
      setDone(true);
    } catch (err) {
      const e2 = err as api.ApiError;
      if (e2.code === "INVALID_TOKEN" || e2.code === "TOKEN_EXPIRED") notice.show(t("auth.resetLinkInvalid", null, "The recovery link is invalid or has expired."));
      else if (e2.code === "TOKEN_ALREADY_USED") notice.show(t("auth.resetLinkInvalid", null, "This reset link has already been used."));
      else notice.show(t("auth.recoveryFailed", null, "The recovery link could not be sent."));
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <AuthPageFrame page="login">
        <div className="brand-panel hidden-panel" />
        <div className="card-outer">
          <div className="card-inner">
            <BrandLogo />
            <h1 className="auth-title">{t("pages.reset_password.reset.password.eecd5ebe", null, "Reset Password")}</h1>
            <p className="auth-sub">{t("auth.resetComplete", null, "Your password was reset successfully. You can now sign in.")}</p>
            <a className="btn-gold btn-block mt-20" href={locale === "en" ? "/en/login" : "/login"}>{t("common.login.to.account.8181f948", null, "Login to Account")}</a>
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
          <h1 className="auth-title">{t("pages.reset_password.set.new.password.ad123390", null, "Set New Password")}</h1>
          <p className="auth-sub">{t("pages.reset_password.enter.your.new.password.it.must.contain.6e604b70", null, "Enter your new password. It must contain at least 10 characters, including one Latin letter and one number.")}</p>
          {missing ? <div className="error-box show">{t("auth.resetTokenMissing", null, "The recovery token is missing or the link is incomplete.")}</div> : null}
          <form noValidate onSubmit={onSubmit}>
            <InlineNotice visible={notice.visible}>{notice.value}</InlineNotice>
            <div className="field">
              <label htmlFor="password">{t("pages.reset_password.set.new.password.ad123390", null, "Set New Password")}</label>
              <PasswordField ref={passRef} id="password" required placeholder={t("pages.reset_password.example.velora2026.f94f471c", null, "Example: VELORA2026")} toggleLabel={t("common.show.password.9daec630", null, "Show password")} icon={<RegEyeIcon />}>
                <span className="icon"><RegLockIcon /></span>
              </PasswordField>
            </div>
            <div className="field">
              <label htmlFor="confirm">{t("pages.reset_password.confirm.password.9071dd6d", null, "Confirm password")}</label>
              <PasswordField ref={confirmRef} id="confirm" required placeholder={t("pages.reset_password.repeat.new.password.d313e98a", null, "Repeat New Password")} toggleLabel={t("common.show.password.9daec630", null, "Show password")} icon={<RegEyeIcon />}>
                <span className="icon"><RegLockIcon /></span>
              </PasswordField>
            </div>
            <button className="btn-gold" type="submit" disabled={busy || missing}>
              {busy ? <><span className="btn-spinner" /> {t("auth.savingPassword", null, "Saving")}</> : t("auth.savePassword", null, "Save new password")}
            </button>
          </form>
        </div>
      </div>
    </AuthPageFrame>
  );
}
