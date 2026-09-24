
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
  { href: "/accounts", icon: "accounts", key: "common.accounts", fallback: "حساب‌ها" },
  { href: "/trades", icon: "journal", key: "common.trades.c19408e7", fallback: "ژورنال معاملات" },
  { href: "/analytics", icon: "perf", key: "common.performance.a68933d2", fallback: "تحلیل عملکرد" },
  { href: "/markets", icon: "mkt", key: "common.markets.9f1cdf65", fallback: "بازارها" },
  { href: "/news", icon: "news", key: "common.news.bba91630", fallback: "اخبار" },
  { href: "/support", icon: "support", key: "common.support.152185b4", fallback: "پشتیبانی" },
  { href: "/intelligence", icon: "intel", key: "common.tradingIntelligence", fallback: "هوش معامله" },
  { href: "/wallet", icon: "wallet", key: "common.wallet.cd1a64bc", fallback: "کیف پول" },
];

function getLocaleFromPath(path: string): Locale {
  return path.startsWith("/en") ? "en" : "fa";
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname() || "";
  const { user, logout, authenticated, status } = useSession();
  const locale: Locale = getLocaleFromPath(pathname);
  const t = createTranslator(locale, ["common", "errors"]);
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
    const fa = locale === "fa";
    const msg = fa ? "آیا می‌خواهید از حساب VELORA خارج شوید؟" : "Do you want to sign out?";
    const ok = window.confirm(msg);
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
        {signedIn ? (
          <button className="sb-logout" onClick={onLogout} type="button">
            <span>{locale === "fa" ? "خروج" : "Sign out"}</span>
          </button>
        ) : (
          <Link className="sb-logout sb-signin" href={prefix + "/login"} onClick={onClose}>
            <span>{locale === "fa" ? "ورود به حساب" : "Sign in"}</span>
          </Link>
        )}
      </aside>
    </>
  );
}
