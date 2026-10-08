"use client";
/*
 * Profile — the READ-ONLY identity overview (Phase 1 of the migration audit).
 *
 * WHY THIS PAGE IS READ-ONLY. Legacy's profile screen was three things at once:
 * who you are (identity), plus change-password and the AI-consent switch. The
 * Modern account surface is `/settings` (ADR-018 kept it as the ONE place where
 * account state is CHANGED), so the management half of Legacy's profile lives
 * there and this page shows what the account IS. Splitting them is what keeps a
 * single canonical management location — duplicating the forms here would give
 * the same capability two owners and let them drift.
 *
 * EVERY VALUE IS READ BACK. Nothing on this screen is inferred, cached in a
 * component default, or invented: the page renders `GET /api/v1/auth/me`
 * (`PublicUserDto`) and nothing else. When the request fails the page says so
 * and offers a retry instead of showing a plausible-looking placeholder.
 *
 * LOCALIZATION: all copy resolves through the `settings` catalog next to
 * `common`/`errors`, in both locales, with Legacy's own profile strings where
 * Legacy had them (see i18n/catalog.ts PROVENANCE note).
 */
import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getAchievements, getMe, type AccountUserView, type AchievementView } from "../../../lib/api/resources";
import { createTranslator } from "../../../i18n/catalog";
import { fmtDateLong } from "../../../i18n/format";
import type { Locale } from "../../../contracts/locale";

function useLocale(): Locale {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/en") ? "en" : "fa";
}

type Phase = "loading" | "ready" | "failed";

export default function ProfilePage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "settings"]);
  const fa = locale === "fa";
  const prefix = fa ? "" : "/en";

  const [phase, setPhase] = useState<Phase>("loading");
  const [user, setUser] = useState<AccountUserView | null>(null);
  const [achPhase, setAchPhase] = useState<Phase>("loading");
  const [achievements, setAchievements] = useState<AchievementView[]>([]);

  const load = useCallback(async () => {
    try {
      const { user: me } = await getMe();
      setUser(me);
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  }, []);

  const loadAchievements = useCallback(async () => {
    try {
      const { achievements: list } = await getAchievements();
      setAchievements(list);
      setAchPhase("ready");
    } catch {
      setAchPhase("failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadAchievements();
  }, [loadAchievements]);

  const roleLabel = (role: string): string => {
    switch (role) {
      case "user":
        return t("profile.role.user", null, fa ? "کاربر" : "User");
      case "admin":
        return t("profile.role.admin", null, fa ? "مدیر سیستم" : "Administrator");
      case "super_admin":
        return t("profile.role.superAdmin", null, fa ? "مدیر ارشد" : "Super admin");
      case "system_owner":
        return t("profile.role.systemOwner", null, fa ? "مالک سیستم" : "System owner");
      default:
        return role;
    }
  };

  const planLabel = (plan: string): string => (plan === "free" ? t("common.free.3d88da0e", null, fa ? "رایگان" : "Free") : plan);

  const initial = (user?.fullName?.trim() || user?.email || "V").trim().charAt(0) || "V";

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("common.profile.8b081d3b", null, fa ? "پروفایل" : "Profile")}</h1>
          <p className="page-sub">{t("profile.pageSubtitle", null, "")}</p>
        </div>
        <div className="flex-gap-8 flex-wrap">
          <button className="btn-ghost btn-sm" onClick={() => void load()} disabled={phase === "loading"} type="button">
            {t("settings.refresh", null, fa ? "تازه‌سازی" : "Refresh")}
          </button>
          <Link className="btn-primary btn-sm" href={`${prefix}/settings`}>
            {t("settings.profileManage", null, fa ? "مدیریت حساب و تنظیمات" : "Manage account and settings")}
          </Link>
        </div>
      </div>

      {phase === "loading" ? (
        <div className="card">
          <div className="empty">
            <h3>{t("settings.loading", null, "…")}</h3>
            <p className="muted-sm mt-8 v-latn-num">GET /api/v1/auth/me</p>
          </div>
        </div>
      ) : null}

      {phase === "failed" ? (
        <div className="card">
          <p className="text-error">{t("settings.loadFailed", null, "")}</p>
          <button className="btn-ghost mt-12" onClick={() => void load()} type="button">
            {t("settings.refresh", null, fa ? "تازه‌سازی" : "Refresh")}
          </button>
        </div>
      ) : null}

      {phase === "ready" && user !== null ? (
        <>
          <div className="card">
            <div className="flex-between flex-wrap">
              <div className="flex-gap-8 flex-center">
                <span className="sb-av" aria-hidden="true">
                  {initial}
                </span>
                <div>
                  <h3 className="label text-gold mb-2">
                    {t("profile.identity.title", null, fa ? "هویت حساب" : "Account identity")}
                  </h3>
                  <p className="text-ede v-latn-num font-800">
                    {user.fullName.trim() || user.email}
                  </p>
                  <p className="muted-xs v-latn-num">{user.email}</p>
                </div>
              </div>
              <div className="flex-gap-8 flex-wrap">
                <span className="badge badge-connected">{roleLabel(user.role)}</span>
                <span className="badge badge-disconnected">{planLabel(user.plan)}</span>
              </div>
            </div>
          </div>

          <div className="grid-2 mt-16">
            <div className="card-alt">
              <h3 className="label text-gold">{t("pages.profile.account.info.399022fc", null, fa ? "اطلاعات حساب" : "Account Info")}</h3>
              <dl className="pf-facts mt-12">
                <div className="pf-fact">
                  <dt className="kpi-label">{t("common.member.since.f0ceac0b", null, fa ? "تاریخ عضویت" : "Member Since")}</dt>
                  <dd className="v-latn-num">{fmtDateLong(locale, user.createdAt)}</dd>
                </div>
                <div className="pf-fact">
                  <dt className="kpi-label">{t("pages.profile.timezone.06a6d9fe", null, fa ? "منطقه زمانی" : "Timezone")}</dt>
                  <dd className="v-latn-num">{user.timezone}</dd>
                </div>
                <div className="pf-fact">
                  <dt className="kpi-label">{t("settings.locale.title", null, fa ? "زبان رابط کاربری" : "Interface language")}</dt>
                  <dd className="v-latn-num">{user.locale}</dd>
                </div>
              </dl>
            </div>

            <div className="card-alt">
              <h3 className="label text-gold">{t("settings.section.security", null, fa ? "امنیت" : "Security")}</h3>
              <p className="muted-sm mt-12">
                {t("profile.aiConsent.title", null, fa ? "پردازش هوش مصنوعی" : "AI processing")}:{" "}
                <span className={user.aiConsent ? "pnl-positive" : "muted-sm"}>
                  {user.aiConsent
                    ? t("profile.aiConsent.pillOn", null, fa ? "فعال" : "Active")
                    : t("profile.aiConsent.pillOff", null, fa ? "غیرفعال" : "Inactive")}
                </span>
              </p>
              <p className="muted-xs mt-8">{t("profile.pageSubtitle", null, "")}</p>
              <Link className="btn-ghost btn-sm mt-12 inline-block" href={`${prefix}/settings`}>
                {t("settings.profileManage", null, fa ? "مدیریت حساب و تنظیمات" : "Manage account and settings")}
              </Link>
            </div>
          </div>

          <div className="card mt-16">
            <h3 className="label text-gold">{t("profile.achievements.title", null, fa ? "دستاوردها" : "Achievements")}</h3>
            {achPhase === "loading" ? (
              <p className="muted-sm mt-12">{t("profile.achievements.loading", null, "")}</p>
            ) : null}
            {achPhase === "failed" ? (
              <p className="text-error mt-12">{t("profile.achievements.loadFailed", null, "")}</p>
            ) : null}
            {achPhase === "ready" && achievements.length === 0 ? (
              <p className="muted-sm mt-12">{t("profile.achievements.empty", null, "")}</p>
            ) : null}
            {achPhase === "ready" && achievements.length > 0 ? (
              <ul className="stack-8 mt-12">
                {achievements.map((a) => (
                  <li key={a.key} className="flex-between flex-wrap card-alt">
                    <div>
                      <p className="font-800">{t(a.titleKey, null, a.key)}</p>
                      <p className="muted-xs mt-4">{t(a.descriptionKey, null, "")}</p>
                      <p className="muted-xs v-latn-num mt-4">{fmtDateLong(locale, a.achievedAt)}</p>
                    </div>
                    <span className="badge badge-connected v-latn-num">{a.key}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
