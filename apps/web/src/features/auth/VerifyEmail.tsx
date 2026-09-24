"use client";
import React, { useEffect, useState } from "react";
import * as api from "../../lib/api/client";
import { AuthPageFrame } from "./components/AuthPageFrame";
import { BrandLogo } from "../../components/brand/LogoMark";
import type { Locale } from "../../contracts/locale";
import { createTranslator } from "../../i18n/catalog";

type TFn = (k: string, p?: Record<string, unknown> | null, fb?: string) => string;

export function VerifyEmail({ locale }: { locale: Locale }) {
  const t: TFn = createTranslator(locale, ["common", "errors", "auth"]);
  const [status, setStatus] = useState<"idle" | "verifying" | "success" | "error" | "missing">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const hash = window.location.hash || "";
    const search = window.location.search || "";
    let token: string | null = null;
    // Modern link: /verify-email#token=xxx
    if (hash.includes("token=")) token = new URLSearchParams(hash.slice(1)).get("token");
    else if (search.includes("token=")) token = new URLSearchParams(search).get("token");

    if (!token) {
      setStatus("missing");
      setMessage(t("auth.verifyTokenMissing", null, "The verification token is missing from the link."));
      return;
    }
    setStatus("verifying");
    api
      .request<{ verified: boolean; alreadyVerified: boolean; messageKey: string }>("/api/v1/auth/verify-email", {
        method: "POST",
        token: "",
        body: { token },
      })
      .then((res) => {
        setStatus("success");
        const key = (res as unknown as { messageKey?: string }).messageKey || "auth.emailVerified";
        setMessage(t(key, null, "Your email was verified successfully."));
      })
      .catch((err) => {
        const e = err as api.ApiError;
        setStatus("error");
        const key = (e.details as Record<string, unknown> | null)?.messageKey as string | undefined;
        if (e.code === "INVALID_TOKEN") setMessage(t("auth.verificationLinkExpired", null, "The verification link is invalid or has expired."));
        else if (key) setMessage(t(key, null, e.message));
        else setMessage(t("auth.verificationFailedTitle", null, "Email verification failed") + ": " + (e.message || ""));
      });
  }, [t]);

  const loginUrl = locale === "en" ? "/en/login" : "/login";

  return (
    <AuthPageFrame page="login">
      <div className="brand-panel hidden-panel" />
      <div className="card-outer">
        <div className="card-inner">
          <BrandLogo />
          <h1 className="auth-title">{t("pages.verify_email.verifying.email.2a98010f", null, "Verifying email")}</h1>
          <p className="auth-sub">
            {status === "verifying" && t("pages.verify_email.please.wait.a.moment.a2879e3f", null, "Please wait a moment.")}
            {status === "success" && message}
            {status === "error" && message}
            {status === "missing" && message}
            {status === "idle" && t("pages.verify_email.please.wait.a.moment.a2879e3f", null, "Please wait a moment.")}
          </p>
          {status === "verifying" ? (
            <div className="center-flex">
              <span className="btn-spinner btn-spinner-lg" aria-hidden="true" />
            </div>
          ) : null}
          {status !== "verifying" && status !== "idle" ? (
            <div className="btn-row">
              <a className="btn-gold btn-flex btn-block" href={loginUrl}>
                {t("common.login.to.account.8181f948", null, "Login to Account")}
              </a>
              {status === "error" || status === "missing" ? (
                <a className="btn-ghost btn-ghost-flex" href={locale === "en" ? "/en/register" : "/register"}>
                  {t("pages.verify_email.request.new.link.c50673c6", null, "Request new link")}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </AuthPageFrame>
  );
}
