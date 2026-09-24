"use client";
/*
 * Session context — W1 auth frontend.
 * Adapted from 6F web/src/lib/auth/session.tsx but reconciled to Modern contracts:
 *  - string IDs (not number)
 *  - Modern refresh flow includes UNAUTHENTICATED → client already handles it
 *  - No legacy localStorage tokens (purge already in client)
 *  - Locale persistence via PATCH /api/v1/auth/me/preferences (best-effort)
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as api from "../api/client";
import type { SessionUser } from "../api/client";

interface SessionCtx {
  user: SessionUser | null;
  authenticated: boolean;
  status: "booting" | "ready";
  refresh: () => Promise<SessionUser | null>;
  logout: () => Promise<void>;
  setUser: (u: SessionUser | null) => void;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [status, setStatus] = useState<"booting" | "ready">("booting");

  useEffect(() => {
    const onSession = (e: Event) => {
      const d = (e as CustomEvent<{ authenticated: boolean; user: SessionUser | null }>).detail;
      setAuthenticated(!!d?.authenticated);
      setUserState(d?.user ?? null);
    };
    window.addEventListener("velora:session", onSession as EventListener);
    api
      .ready()
      .catch(() => null)
      .finally(() => setStatus("ready"));
    return () => window.removeEventListener("velora:session", onSession as EventListener);
  }, []);

  // Locale persistence: when locale changes elsewhere, PATCH if authenticated
  // The auth pages and LocaleSwitcher will dispatch velora:locale-change; we hook here to persist
  useEffect(() => {
    const onLocaleChange = (e: Event) => {
      const locale = (e as CustomEvent<{ locale?: string }>).detail?.locale;
      if (!locale) return;
      if (!api.getAccessToken()) return;
      void api
        .request("/api/v1/auth/me/preferences", { method: "PATCH", body: { locale } })
        .catch(() => undefined);
    };
    window.addEventListener("velora:locale-change", onLocaleChange as EventListener);
    window.addEventListener("velora:user-locale", onLocaleChange as EventListener);
    return () => {
      window.removeEventListener("velora:locale-change", onLocaleChange as EventListener);
      window.removeEventListener("velora:user-locale", onLocaleChange as EventListener);
    };
  }, []);

  const refresh = useCallback(async () => {
    api.resetSessionReady();
    return api.ready().catch(() => null);
  }, []);

  const logout = useCallback(() => api.logout(), []);
  const setUser = useCallback((u: SessionUser | null) => api.setUser(u), []);

  const value = useMemo<SessionCtx>(
    () => ({ user, authenticated, status, refresh, logout, setUser }),
    [user, authenticated, status, refresh, logout, setUser],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}

export function RequireSession({ children, loadingKey }: { children: React.ReactNode; loadingKey?: string }) {
  const { status, authenticated } = useSession();

  // For pages that use RequireSession, we need to redirect unauthenticated after ready
  useEffect(() => {
    if (status === "ready" && !authenticated) {
      // Use locale-aware login path — proxy will have set html lang, but we fallback to /login
      const isEn = document.documentElement.getAttribute("data-locale") === "en" || document.documentElement.lang.startsWith("en");
      const target = isEn ? "/en/login" : "/login";
      // Avoid loop: if already on login/register, don't redirect
      if (!window.location.pathname.includes("/login") && !window.location.pathname.includes("/register")) {
        window.location.replace(target);
      }
    }
  }, [status, authenticated]);

  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        void api.ready().then(() => {
          if (!api.getAccessToken()) {
            const isEn = document.documentElement.getAttribute("data-locale") === "en";
            window.location.replace(isEn ? "/en/login" : "/login");
          }
        });
      }
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const booting = status !== "ready";
  if (booting) {
    return (
      <div className="velora-loading-screen" aria-live="polite" aria-busy="true">
        <div className="velora-loading-inner">
          <span className="btn-spinner" aria-hidden="true" />
          <span>{loadingKey ? loadingKey : "در حال بارگذاری..."}</span>
        </div>
      </div>
    );
  }
  if (!authenticated) return null;
  return <>{children}</>;
}
