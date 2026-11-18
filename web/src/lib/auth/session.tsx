'use client';
/*
 * Session context — React adapter over the ported `velora-data` client.
 * Mirrors legacy behaviour: `ready()` on mount (silent refresh via HttpOnly
 * cookie), `velora:session` event fan-out, `pageshow` bfcache revalidation.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as api from '@/lib/api/client';
import type { SessionUser } from '@/lib/api/client';
import { registerRemoteLocalePersist } from '@/i18n/I18nProvider';

interface SessionCtx {
  user: SessionUser | null;
  authenticated: boolean;
  status: 'booting' | 'ready';
  refresh: () => Promise<SessionUser | null>;
  logout: () => Promise<void>;
  setUser: (u: SessionUser | null) => void;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [status, setStatus] = useState<'booting' | 'ready'>('booting');

  useEffect(() => {
    const onSession = (e: Event) => {
      const d = (e as CustomEvent<{ authenticated: boolean; user: SessionUser | null }>).detail;
      setAuthenticated(!!d?.authenticated);
      setUserState(d?.user ?? null);
    };
    window.addEventListener('velora:session', onSession);
    api
      .ready()
      .catch(() => null)
      .finally(() => setStatus('ready'));
    return () => window.removeEventListener('velora:session', onSession);
  }, []);

  // Legacy R3: persist manual locale choice server-side when signed in.
  useEffect(() => {
    registerRemoteLocalePersist((locale) =>
      api.getAccessToken()
        ? api.request('/api/v1/auth/me/preferences', { method: 'PATCH', body: { locale } })
        : Promise.resolve({ persisted: false }),
    );
    return () => registerRemoteLocalePersist(null);
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
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
