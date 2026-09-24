"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../../contracts";
import { LOCALE_REGISTRY, normalizeLocale } from "../../i18n/registry";

/**
 * Language switcher — the ONE switcher for the landing (Stage 1 §G).
 * Renders as a <select> inside the header (desktop) and as a menu row (mobile).
 * Behavior mirrors Legacy velora-localization.js setLocale():
 *  - write cookie `velora_locale` (Path=/, 1y, Lax) and localStorage `velora.locale`
 *  - if signed in (VeloraData.getAccessToken), PATCH /api/v1/auth/me/preferences {locale}
 *  - then navigate to the alternate public URL via <link hreflang> if the
 *    current path has an explicit locale prefix that differs from the chosen one.
 *  - otherwise reload to let the server render the new locale (proxy sets html lang/dir).
 */

export function LocaleSwitcher({
  locale,
  label,
  placement,
}: {
  locale: Locale;
  label: string;
  placement: "header" | "menu";
}) {
  const [value, setValue] = useState<Locale>(locale);

  useEffect(() => {
    setValue(locale);
  }, [locale]);

  const onChange = useCallback(
    async (next: string) => {
      const norm = normalizeLocale(next);
      if (!norm || norm === value) return;
      setValue(norm);
      try {
        localStorage.setItem(LOCALE_REGISTRY.storageKey, norm);
      } catch {}
      try {
        document.cookie = `${encodeURIComponent(LOCALE_REGISTRY.cookieKey)}=${encodeURIComponent(norm)}; Path=/; Max-Age=31536000; SameSite=Lax`;
      } catch {}
      // Best-effort server persistence if signed in (mirrors Legacy persistPreference).
      try {
        const vd = (window as unknown as { VeloraData?: { getAccessToken?: () => string | null } }).VeloraData;
        const token = vd?.getAccessToken?.() ?? null;
        if (token && typeof fetch === "function") {
          const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
          const tid = ctrl ? setTimeout(() => ctrl.abort(), 4000) : null;
          await fetch("/api/v1/auth/me/preferences", {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ locale: norm }),
            ...(ctrl?.signal ? { signal: ctrl.signal } : {}),
            credentials: "same-origin",
          } as RequestInit).catch(() => {});
          if (tid) clearTimeout(tid);
        }
      } catch {}

      // Navigate to the alternate landing URL if we're on a locale-prefixed path.
      const path = window.location.pathname;
      const first = path.replace(/^\/+/, "").split("/")[0]?.toLowerCase() ?? "";
      const hasPrefix = first === "en" || first === "fa";
      if (hasPrefix && first !== norm) {
        // Use <link hreflang> targets like Legacy did, else synthesize.
        const alt = document.querySelector(`link[rel~="alternate"][hreflang="${norm}"]`) as HTMLLinkElement | null;
        if (alt?.href) {
          const url = new URL(alt.href);
          window.location.assign(url.pathname + url.search + url.hash);
          return;
        }
        const rest = path.replace(/^\/[^/]+/, "") || "/";
        window.location.assign(norm === "fa" ? rest || "/" : `/en${rest}`);
        return;
      }
      if (!hasPrefix) {
        // From "/" (fa) to "/en/" or vice versa.
        if (norm === "en" && path === "/") {
          window.location.assign("/en/");
          return;
        }
        if (norm === "fa" && path === "/en/") {
          window.location.assign("/");
          return;
        }
      }
      // Fallback: reload so proxy can set html lang/dir from cookie.
      window.location.reload();
    },
    [value],
  );

  // The landing CSS already handles placement via [data-placement] and
  // [data-mobile-menu-item]. We render both instances; CSS hides the header
  // one on small viewports inside the menu (mirroring arrangeLandingLanguageControl).
  const isMenu = placement === "menu";
  return (
    <div
      className="velora-locale-switcher"
      data-placement={isMenu ? "dock" : "inline"}
      data-context="site"
      {...(isMenu ? { "data-mobile-menu-item": "" } : {})}
      title={label}
    >
      <span className="velora-locale-icon" aria-hidden="true" />
      <label htmlFor={`velora-locale-select-${placement}`}>{label}</label>
      <select
        id={`velora-locale-select-${placement}`}
        aria-label={label}
        value={value}
        onChange={(e) => void onChange(e.target.value)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {(Object.entries(LOCALE_REGISTRY.locales) as [Locale, (typeof LOCALE_REGISTRY.locales)[Locale]][]).map(
          ([code, meta]) => (
            <option key={code} value={code}>
              {meta.nativeName}
            </option>
          ),
        )}
      </select>
    </div>
  );
}
