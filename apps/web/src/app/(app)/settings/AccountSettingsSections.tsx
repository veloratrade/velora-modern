"use client";
/*
 * Account sections for the Settings page — Phase 1 (audit §4).
 *
 * These three sections wire THREE capabilities that already existed on the
 * server and had no way in from the browser (ACC-04 change password, ACC-07
 * locale preference, ACC-08 AI consent), plus the six email categories whose
 * API Legacy had already shipped (ACC-09). Nothing here invents a backend: every
 * write goes to the endpoint that was audited, and every state shown is the
 * value that came BACK from the server.
 *
 * WHY A SEPARATE FILE. `settings/page.tsx` owns the Connected-Accounts section
 * (ADR-018, Telegram) and is deliberately untouched by this change. Keeping the
 * new sections beside it means the Telegram surface cannot regress by accident,
 * and the diff is additive and reversible.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   * No optimistic state: a preference shows the server's answer, never the
 *     click. If the write fails the row keeps its old value and says so.
 *   * No client-side password policy of its own beyond the two checks Legacy
 *     also did (both fields present, length) — the server remains the authority.
 *   * No new management surface: this is `/settings`, the ONE place account
 *     state is changed. `/profile` shows, this page edits.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  getMe,
  changePassword,
  getEmailPreferences,
  updateEmailPreferences,
  updatePreferences,
  type AccountUserView,
  type EmailPreferenceKey,
  type EmailPreferences,
} from "../../../lib/api/resources";
import * as api from "../../../lib/api/client";
import { ApiError } from "../../../lib/api/client";
import { createTranslator, type Translate } from "../../../i18n/catalog";
import { LOCALE_REGISTRY, normalizeLocale } from "../../../i18n/registry";
import type { Locale } from "../../../contracts/locale";

const MIN_PASSWORD_LENGTH = 10;

type Busy = "" | "password" | "locale" | "consent" | EmailPreferenceKey;

export function AccountSettingsSections({ onSessionEnded }: { onSessionEnded: () => void }) {
  const locale: Locale = typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
  const t = createTranslator(locale, ["common", "errors", "settings"]);
  const fa = locale === "fa";

  const [user, setUser] = useState<AccountUserView | null>(null);
  const [prefs, setPrefs] = useState<EmailPreferences | null>(null);
  const [busy, setBusy] = useState<Busy>("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [form, setForm] = useState({ current: "", next: "" });

  const load = useCallback(async () => {
    const [me, pref] = await Promise.allSettled([getMe(), getEmailPreferences()]);
    if (me.status === "fulfilled") setUser(me.value.user);
    if (pref.status === "fulfilled") setPrefs(pref.value.preferences);
    if (me.status === "rejected" && pref.status === "rejected") {
      setMessage({ kind: "error", text: t("settings.loadFailed", null, "") });
    }
  }, [t]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- password --
  const onChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (form.current === "" || form.next === "") {
      setMessage({ kind: "error", text: t("profile.passwordFieldsRequired", null, "") });
      return;
    }
    if (form.next.length < MIN_PASSWORD_LENGTH) {
      setMessage({ kind: "error", text: t("profile.passwordTooShort", null, "") });
      return;
    }
    setBusy("password");
    try {
      await changePassword({ currentPassword: form.current, newPassword: form.next });
      setForm({ current: "", next: "" });
      // The server revoked every session (Legacy did the same — its copy says so,
      // and the Modern service calls revokeAllSessionsForUser). The honest next
      // step is the sign-in screen, not a page that can no longer load.
      setMessage({ kind: "ok", text: t("profile.passwordChanged", null, "") });
      window.setTimeout(() => {
        void api.logout().finally(() => onSessionEnded());
      }, 1400);
    } catch (err) {
      setMessage({ kind: "error", text: passwordErrorText(err, t) });
    } finally {
      setBusy("");
    }
  };

  // ----------------------------------------------------------------- locale --
  const onLocale = async (raw: string) => {
    const next = normalizeLocale(raw);
    if (next === null || next === user?.locale) return;
    setBusy("locale");
    setMessage(null);
    try {
      await updatePreferences({ locale: next });
      setUser((u) => (u === null ? u : { ...u, locale: next }));
      // Same client-side persistence the landing switcher performs, so the
      // server-rendered lang/dir on the next request agrees with the choice.
      try {
        window.localStorage.setItem(LOCALE_REGISTRY.storageKey, next);
      } catch { /* storage unavailable — the server value still wins */ }
      try {
        document.cookie = `${encodeURIComponent(LOCALE_REGISTRY.cookieKey)}=${encodeURIComponent(next)}; Path=/; Max-Age=31536000; SameSite=Lax`;
      } catch { /* cookie unavailable — the server value still wins */ }
      setMessage({ kind: "ok", text: t("settings.locale.saved", null, "") });
      window.location.assign(localeHref(next));
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? t("settings.locale.failed", null, "") : String(err) });
    } finally {
      setBusy("");
    }
  };

  // ------------------------------------------------------------ ai consent --
  const onConsent = async () => {
    if (user === null) return;
    const next = !user.aiConsent;
    setBusy("consent");
    setMessage(null);
    try {
      await updatePreferences({ ai_consent: next });
      setUser({ ...user, aiConsent: next });
      // Keep the browser session's copy in step: other islands read it.
      api.setUser({ ...user, aiConsent: next });
      setMessage({ kind: "ok", text: t("profile.saved", null, "") });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? t("profile.aiConsent.error", null, "") : String(err) });
    } finally {
      setBusy("");
    }
  };

  // --------------------------------------------------------------- emails ----
  const onToggleEmail = async (key: EmailPreferenceKey) => {
    if (prefs === null) return;
    setBusy(key);
    setMessage(null);
    try {
      const { preferences } = await updateEmailPreferences({ [key]: prefs[key] !== 1 });
      setPrefs(preferences); // server's answer, not the click
      setMessage({ kind: "ok", text: t("auth.emailPreferencesUpdated", null, "") });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof ApiError ? t("settings.email.saveFailed", null, "") : String(err) });
    } finally {
      setBusy("");
    }
  };

  // Two different questions, two different vocabularies: the AI row reports the
  // consent pill Legacy shipped (`pillOn`/`pillOff`), while an email category is
  // simply on or off — the shell's shared status words. Reusing the AI copy for
  // the email rows (as this file first did) put "enable AI processing" on a
  // welcome-email toggle, which is not what the row means.
  const stateWord = (on: boolean) => (on ? t("profile.aiConsent.pillOn", null, "") : t("profile.aiConsent.pillOff", null, ""));
  const statusWord = (on: boolean) => (on ? t("status.active", null, "") : t("status.inactive", null, ""));

  return (
    <>
      <section aria-labelledby="account-security" className="grid-gap-12">
        <h2 className="label mt-4" id="account-security">
          {t("settings.section.security", null, fa ? "امنیت" : "Security")}
        </h2>
        <div className="card">
          <h3 className="label text-gold">{t("profile.changePassword", null, fa ? "تغییر رمز عبور" : "Change password")}</h3>
          <form className="grid-gap-12 mt-12" onSubmit={onChangePassword}>
            <div className="grid-2">
              <label>
                <span className="label">{t("pages.profile.current.password.5935e783", null, fa ? "رمز فعلی" : "Current password")}</span>
                <input
                  className="input v-latn-num"
                  type="password"
                  autoComplete="current-password"
                  value={form.current}
                  onChange={(e) => setForm({ ...form, current: e.target.value })}
                  disabled={busy === "password"}
                />
              </label>
              <label>
                <span className="label">{t("common.new.password.f8211826", null, fa ? "رمز جدید" : "New password")}</span>
                <input
                  className="input v-latn-num"
                  type="password"
                  autoComplete="new-password"
                  value={form.next}
                  onChange={(e) => setForm({ ...form, next: e.target.value })}
                  disabled={busy === "password"}
                />
              </label>
            </div>
            <p className="muted-xs">{t("profile.passwordTooShort", null, "")}</p>
            <div className="flex-gap-8 flex-wrap">
              <button className="btn-primary" type="submit" disabled={busy === "password"}>
                {busy === "password" ? t("profile.changingPassword", null, "") : t("profile.changePassword", null, "")}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section aria-labelledby="account-preferences" className="grid-gap-12">
        <h2 className="label mt-4" id="account-preferences">
          {t("settings.section.preferences", null, fa ? "ترجیحات" : "Preferences")}
        </h2>
        <div className="card">
          <div className="pref-row">
            <div>
              <span className="label label-nocap">{t("settings.locale.title", null, fa ? "زبان رابط کاربری" : "Interface language")}</span>
              <p className="muted-xs">{t("settings.locale.description", null, "")}</p>
            </div>
            <div className="flex-gap-8 flex-center">
              <select
                className="input select-locale"
                aria-label={t("settings.locale.title", null, fa ? "زبان رابط کاربری" : "Interface language")}
                value={user?.locale ?? locale}
                onChange={(e) => void onLocale(e.target.value)}
                disabled={busy === "locale" || user === null}
              >
                {(Object.entries(LOCALE_REGISTRY.locales) as [Locale, (typeof LOCALE_REGISTRY.locales)[Locale]][]).map(([code, meta]) => (
                  <option key={code} value={code}>
                    {meta.nativeName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pref-row">
            <div>
              <span className="label label-nocap">{t("profile.aiConsent.title", null, fa ? "پردازش هوش مصنوعی" : "AI processing")}</span>
              <p className="muted-xs">{t("profile.aiConsent.description", null, "")}</p>
            </div>
            <div className="flex-gap-8 flex-wrap flex-center">
              <span className={`badge ${user?.aiConsent ? "badge-connected" : "badge-disconnected"}`}>
                {user === null ? t("profile.aiConsent.statusLoading", null, "…") : stateWord(user.aiConsent)}
              </span>
              <button
                className="btn-ghost btn-sm"
                type="button"
                onClick={() => void onConsent()}
                disabled={busy === "consent" || user === null}
              >
                {busy === "consent"
                  ? t("profile.aiConsent.saving", null, "")
                  : user?.aiConsent
                    ? t("profile.aiConsent.deactivate", null, "")
                    : t("profile.aiConsent.activate", null, "")}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="account-notifications" className="grid-gap-12">
        <h2 className="label mt-4" id="account-notifications">
          {t("auth.emailPreferences", null, fa ? "ترجیحات اعلان ایمیل" : "Email notification preferences")}
        </h2>
        <div className="card">
          {prefs === null ? (
            <p className="muted-sm">{t("settings.loading", null, "…")}</p>
          ) : (
            EMAIL_KEYS.map((key) => {
              const on = prefs[key] === 1;
              return (
                <div className="pref-row" key={key}>
                  <span className="label label-nocap">
                    {t(EMAIL_LABEL_KEYS[key], null, key)}
                  </span>
                  <div className="flex-gap-8 flex-wrap flex-center">
                    <span className={`badge ${on ? "badge-connected" : "badge-disconnected"}`}>{statusWord(on)}</span>
                    <button className="btn-ghost btn-sm" type="button" onClick={() => void onToggleEmail(key)} disabled={busy !== ""}>
                      {on ? t("settings.email.disable", null, "") : t("settings.email.enable", null, "")}
                    </button>
                  </div>
                </div>
              );
            })
          )}
          <p className="muted-xs mt-12">{t("settings.email.note", null, "")}</p>
        </div>
      </section>

      {message !== null ? (
        <p className={message.kind === "ok" ? "muted-sm mt-12" : "text-error mt-12"} role={message.kind === "ok" ? "status" : "alert"}>
          {message.text}
        </p>
      ) : null}
    </>
  );
}

/** The six categories, in the API's own names (order = Legacy's preference list). */
const EMAIL_KEYS: readonly EmailPreferenceKey[] = [
  "welcome_email",
  "security_alerts",
  "trade_notifications",
  "weekly_report",
  "monthly_report",
  "achievement_notifications",
];

const EMAIL_LABEL_KEYS: Readonly<Record<EmailPreferenceKey, string>> = {
  welcome_email: "settings.email.welcome",
  security_alerts: "settings.email.securityAlerts",
  trade_notifications: "settings.email.tradeNotifications",
  weekly_report: "settings.email.weeklyReport",
  monthly_report: "settings.email.monthlyReport",
  achievement_notifications: "settings.email.achievements",
};

/** The same page, in the other locale (ADR-009 URL contract: fa bare, en prefixed). */
function localeHref(next: Locale): string {
  const path = typeof window === "undefined" ? "/settings" : window.location.pathname;
  const bare = path === "/en" ? "/" : path.startsWith("/en/") ? path.slice(3) : path;
  return next === "en" ? `/en${bare}` : bare;
}

/** Server refusal → the sentence a user can act on (never a raw code). */
function passwordErrorText(e: unknown, t: Translate): string {
  if (!(e instanceof ApiError)) return t("errors.api", null, String(e));
  const details = (e.details ?? {}) as Record<string, unknown>;
  if (typeof details.currentPassword === "string") return t("errors.auth.currentPasswordInvalid", null, "");
  if (typeof details.newPassword === "string") {
    const reason = String(details.newPassword);
    if (/differ/i.test(reason)) return t("errors.auth.passwordMustDiffer", null, "");
    if (/short|policy/i.test(reason)) return t("profile.passwordTooShort", null, "");
    if (/long/i.test(reason)) return t("errors.validation.maxLength", { max: 128 }, "");
    return t("errors.auth.passwordComplexity", null, "");
  }
  if (e.code === "RATE_LIMITED") return t("errors.rateLimited", null, "");
  if (e.code === "UNAUTHENTICATED") return t("errors.unauthorized", null, "");
  const byKey = e.messageKey ? t(e.messageKey, e.params, "") : "";
  if (byKey !== "") return byKey;
  return t("errors.api", null, e.message);
}

/** Exported for the catalog test: the keys this surface renders. */
export const SETTINGS_TEXT_KEYS = [
  "settings.section.security",
  "settings.section.preferences",
  "auth.emailPreferences",
  "profile.changePassword",
  "profile.changingPassword",
  "profile.passwordChanged",
  "profile.passwordFieldsRequired",
  "profile.passwordTooShort",
  "pages.profile.current.password.5935e783",
  "common.new.password.f8211826",
  "settings.locale.title",
  "settings.locale.description",
  "settings.locale.saved",
  "settings.locale.failed",
  "profile.aiConsent.title",
  "profile.aiConsent.description",
  "profile.aiConsent.activate",
  "profile.aiConsent.deactivate",
  "profile.aiConsent.pillOn",
  "profile.aiConsent.pillOff",
  "profile.aiConsent.saving",
  "profile.aiConsent.error",
  "profile.aiConsent.statusLoading",
  "profile.saved",
  "settings.email.welcome",
  "settings.email.securityAlerts",
  "settings.email.tradeNotifications",
  "settings.email.weeklyReport",
  "settings.email.monthlyReport",
  "settings.email.achievements",
  "settings.email.note",
  "settings.email.saveFailed",
  "settings.email.enable",
  "settings.email.disable",
  "status.active",
  "status.inactive",
  "settings.loading",
  "settings.loadFailed",
  ...Object.values(EMAIL_LABEL_KEYS),
] as const;
