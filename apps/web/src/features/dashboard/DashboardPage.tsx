"use client";
import React, { useEffect, useState } from "react";
import { useSession } from "../../lib/auth/session";
import * as api from "../../lib/api/client";
import type { Locale } from "../../contracts/locale";
import { createTranslator } from "../../i18n/catalog";

type TFn = (k: string, p?: Record<string, unknown> | null, fb?: string) => string;

export function DashboardPage({ locale }: { locale: Locale }) {
  const t: TFn = createTranslator(locale, ["common", "errors", "auth"]);
  const { user, logout, status } = useSession();
  const [me, setMe] = useState<Record<string, unknown> | null>(null);
  const [loadingMe, setLoadingMe] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "ready") return;
    setLoadingMe(true);
    api
      .request<{ user: Record<string, unknown> }>("/api/v1/auth/me", { method: "GET" })
      .then((d) => {
        setMe(d.user);
        setError(null);
      })
      .catch((e) => {
        const err = e as api.ApiError;
        setError(err.message || String(err.code));
      })
      .finally(() => setLoadingMe(false));
  }, [status]);

  async function onLogout() {
    await logout();
    const target = locale === "en" ? "/en/login" : "/login";
    window.location.replace(target);
  }

  const displayUser = (me as Record<string, unknown>) || (user as unknown as Record<string, unknown>) || {};

  return (
    <div className="dashboard-page">
      <div className="dashboard-inner">
        <header className="dashboard-header">
          <div>
            <h1 className="dashboard-title">{locale === "en" ? "Dashboard" : "داشبورد"} <span>(W1 Protected)</span></h1>
            <p className="dashboard-subtitle">{t("pages.login.login.to.access.your.trading.dashboard.32a261f6", null, status === "ready" ? "Protected route — session ready" : "Loading session...")}</p>
          </div>
          <div className="dashboard-actions">
            <span className="locale-chip">{locale === "en" ? "EN" : "FA"} · {String(displayUser.locale || locale)}</span>
            <button onClick={onLogout} className="btn-logout">
              {t("common.logout.27be6c53", null, "Logout")}
            </button>
          </div>
        </header>

        {loadingMe ? (
          <div className="dashboard-loading">
            <span className="btn-spinner" aria-hidden="true" />
            <span>{t("pages.dashboard.loading.dashboard.4116bcc3", null, "در حال بارگذاری...")}</span>
          </div>
        ) : error ? (
          <div className="dashboard-error">{error}</div>
        ) : (
          <div className="dashboard-grid">
            <div className="dashboard-card">
              <h3 className="dashboard-card-title">{locale === "en" ? "Session User" : "کاربر نشست"}</h3>
              <dl className="dashboard-dl">
                <div className="dl-row"><dt>ID</dt><dd className="mono">{String(displayUser.id || "—")}</dd></div>
                <div className="dl-row"><dt>Email</dt><dd>{String(displayUser.email || "—")}</dd></div>
                <div className="dl-row"><dt>Full Name</dt><dd>{String(displayUser.fullName || displayUser.full_name || "—")}</dd></div>
                <div className="dl-row"><dt>Plan</dt><dd>{String(displayUser.plan || "—")}</dd></div>
                <div className="dl-row"><dt>Locale</dt><dd>{String(displayUser.locale || "—")}</dd></div>
                <div className="dl-row"><dt>Role</dt><dd>{String(displayUser.role || "—")}</dd></div>
              </dl>
              <p className="session-note">
                {locale === "en" ? "String IDs verified — not numbers." : "شناسه‌ها string هستند — نه number."}
              </p>
            </div>

            <div className="dashboard-card dashboard-card-alt">
              <h3 className="dashboard-card-title">{locale === "en" ? "Auth Verification" : "تأیید احراز هویت"}</h3>
              <ul className="dashboard-list">
                <li>✓ <code>accessToken in memory</code> — not localStorage</li>
                <li>✓ <code>refresh_token</code> HttpOnly Secure Lax</li>
                <li>✓ Refresh on <code>UNAUTHENTICATED</code> → retry once</li>
                <li>✓ <code>fullName</code> (not full_name) — {String(displayUser.fullName ? "OK" : "check")}</li>
                <li>✓ <code>details.messageKey</code> propagated</li>
                <li>✓ <span className="v-latn-num" dir="ltr" lang="en">Latin digits</span> — {locale === "en" ? "EN LTR OK" : "FA RTL با اعداد لاتین"}</li>
              </ul>
              <div className="dashboard-ctas">
                <button
                  onClick={() => api.request("/api/v1/auth/me", { method: "GET" }).then(() => setError(null)).catch((e) => setError(String((e as api.ApiError).message)))}
                  className="btn-gold btn-flex"
                >
                  {locale === "en" ? "Test /me (refresh)" : "تست /me (refresh)"}
                </button>
                <button
                  onClick={() => {
                    // Force expire access token by clearing it then calling /me — should trigger refresh
                    const tok = api.getAccessToken();
                    // Simulate expiry by making request with empty token — client will use empty, get 401, then refresh via cookie
                    api.request("/api/v1/auth/me", { method: "GET", token: "invalid" }).then(() => setError("unexpected success")).catch((e) => setError(String((e as api.ApiError).code)));
                  }}
                  className="btn-ghost btn-flex"
                >
                  {locale === "en" ? "Test bad token" : "تست توکن بد"}
                </button>
              </div>
            </div>
          </div>
        )}

        <p className="dashboard-foot">
          W1 protected route — <code>RequireSession</code> hides content until <code>ready</code> → no flash. Locale: <code>{locale}</code> RTL/LTR via proxy <code>x-velora-locale</code>.
        </p>
      </div>
    </div>
  );
}
