
"use client";
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "../../lib/auth/session";
import { createTranslator } from "../../i18n/catalog";
import type { Locale } from "../../contracts/locale";
import { SidebarIcons } from "./sidebarIcons";

type NavItem = { href: string; icon: keyof typeof SidebarIcons; key: string; fallback: string; adminOnly?: boolean };

const NAV: NavItem[] = [
  { href: "/dashboard", icon: "dash", key: "common.dashboard.2aea7aaf", fallback: "داشبورد" },
  { href: "/accounts", icon: "accounts", key: "nav.accounts", fallback: "حساب‌ها" },
  { href: "/trades", icon: "journal", key: "common.trades.c19408e7", fallback: "ژورنال معاملات" },
  { href: "/analytics", icon: "perf", key: "common.performance.a68933d2", fallback: "تحلیل عملکرد" },
  { href: "/markets", icon: "mkt", key: "common.markets.9f1cdf65", fallback: "بازارها" },
  { href: "/news", icon: "news", key: "common.news.bba91630", fallback: "اخبار" },
  { href: "/support", icon: "support", key: "common.support.152185b4", fallback: "پشتیبانی" },
  { href: "/intelligence", icon: "intel", key: "common.tradingIntelligence", fallback: "هوش معامله" },
  { href: "/wallet", icon: "wallet", key: "common.wallet.cd1a64bc", fallback: "کیف پول" },
  // Settings is the ACCOUNT surface, and it hosts the web-first Telegram linking
  // screen (ADR-018) as its "connected accounts" section. The label is the
  // PAGE's own name, not the feature's: a nav item called "Telegram connection"
  // would be a second, feature-shaped way into the same screen and would put
  // Telegram beside Dashboard/Journal instead of inside the account area, which
  // is the opposite of "one canonical location". Telegram is still reachable in
  // one click — from here — and nothing about the route or the screen changed.
  { href: "/settings", icon: "settings", key: "telegram.settings.title", fallback: "تنظیمات" },
];

function getLocaleFromPath(path: string): Locale {
  return path.startsWith("/en") ? "en" : "fa";
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname() || "";
  const { user, logout, authenticated, status } = useSession();
  const locale: Locale = getLocaleFromPath(pathname);
  const t = createTranslator(locale, ["common", "errors", "telegram"]);
  const isAdmin = user?.role === "admin" || user?.role === "super_admin" || user?.role === "system_owner";
  const name = user?.fullName?.trim() || t("common.user.cfadc9e3", null, "کاربر");
  const email = user?.email || "";
  const initial = name.trim().charAt(0) || "V";
  const prefix = locale === "en" ? "/en" : "";
  // Public app routes (markets/news/support) render this shell without a
  // session — show a Sign-in affordance instead of a phantom user card.
  const signedIn = status === "ready" && authenticated && user !== null;

  const onLogout = async (e: React.MouseEvent) => {
    e.preventDefault();
    // Legacy's own confirmation copy (public/locales/*.json @edede31) — the shell
    // used to hard-code this sentence here, which meant the EN shell could drift
    // from the catalog. The wording is Legacy's, not a Modern invention.
    const ok = window.confirm(t("pages.dashboard.are.you.sure.you.want.to.logout.16e6ca9b", null, "مطمئن هستید که می‌خواهید از حساب VELORA خارج شوید؟"));
    if (ok) {
      await logout();
      window.location.replace(prefix + "/login");
    }
  };

  return (
    <>
      <aside className={`app-sidebar${open ? " drawer-open" : ""}`} id="veloraSidebar">
        <div className="sb-logo">
          <div className="sb-logo-mark" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 64 64">
              <defs>
                <linearGradient id="sbLgD" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#fce38a" />
                  <stop offset="1" stopColor="#b88d1d" />
                </linearGradient>
              </defs>
              <path d="M8 10L21 10L32 52L43 10L56 10L32 58Z" fill="none" stroke="#e8c45a" strokeWidth=".7" />
              <path d="M8 10L21 10L32 52L43 10L56 10L32 58Z" fill="url(#sbLgD)" />
            </svg>
          </div>
          <span className="sb-logo-text">VELORA</span>
        </div>
        <nav className="sb-nav">
          {NAV.map((item) => {
            const href = prefix + item.href;
            const active = pathname === href || pathname.startsWith(href + "/") || pathname === item.href;
            return (
              <Link key={item.href} className={`sb-item${active ? " active" : ""}`} href={href} onClick={onClose}>
                <span className="sb-icon" aria-hidden="true">{SidebarIcons[item.icon]}</span>
                <span className="sb-label">{t(item.key, null, item.fallback)}</span>
              </Link>
            );
          })}
          {isAdmin ? (
            <Link className={`sb-item${pathname.includes("/admin") ? " active" : ""}`} href={prefix + "/admin"} onClick={onClose}>
              <span className="sb-icon">{SidebarIcons.admin}</span>
              <span className="sb-label">{t("common.admin.41ae8044", null, "مدیریت")}</span>
            </Link>
          ) : null}
        </nav>
        {/* The account card is the SECOND door to the account surface, and the
            natural one: a signed-in user looks at their own name to change
            anything about their own account. The markup inside is untouched
            (same classes, same avatar, same online dot, same two lines) — only
            the wrapper becomes a link, so the visual language and the density
            are identical. Signed-out visitors get no link: they have no
            account screen. */}
        {signedIn ? (
          <Link className="sb-user" href={prefix + "/settings"} onClick={onClose} aria-label={t("telegram.settings.title", null, "Settings")}>
            <div className="sb-av-wrap">
              <div className="sb-av" id="userAv">{initial}</div>
              <span className="sb-online" aria-hidden="true" />
            </div>
            <div className="sb-user-meta">
              <div className="sb-name v-latn-num">{name}</div>
              <div className="sb-email v-latn-num">{email}</div>
            </div>
          </Link>
        ) : (
          <div className="sb-user">
            <div className="sb-av-wrap">
              <div className="sb-av" id="userAv">{initial}</div>
              <span className="sb-online" aria-hidden="true" />
            </div>
            <div className="sb-user-meta">
              <div className="sb-name v-latn-num">{name}</div>
              <div className="sb-email v-latn-num">{email}</div>
            </div>
          </div>
        )}
        {signedIn ? (
          <button className="sb-logout" onClick={onLogout} type="button">
            <span>{t("nav.logout", null, "خروج")}</span>
          </button>
        ) : (
          <Link className="sb-logout sb-signin" href={prefix + "/login"} onClick={onClose}>
            <span>{t("common.login.to.account.8181f948", null, "ورود به حساب")}</span>
          </Link>
        )}
      </aside>
    </>
  );
}
