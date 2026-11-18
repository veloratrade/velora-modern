'use client';
/*
 * Port of the legacy `data-velora-early` guard:
 *   VeloraData.requireSession('/login') on DOMContentLoaded and on bfcache
 *   `pageshow` restore. Renders the legacy loading screen while booting.
 */
import React, { useEffect } from 'react';
import { useSession } from '@/lib/auth/session';
import { getAccessToken } from '@/lib/api/client';
import { LoadingScreen } from '@/components/ui/LoadingScreen';
import { useI18n } from '@/i18n/I18nProvider';

export function RequireSession({ children, loadingKey }: { children: React.ReactNode; loadingKey?: string }) {
  const { status, authenticated, refresh } = useSession();
  const { t, ready } = useI18n();

  useEffect(() => {
    if (status === 'ready' && !authenticated) window.location.replace('/login/');
  }, [status, authenticated]);

  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        void refresh().then(() => {
          if (!getAccessToken()) window.location.replace('/login/');
        });
      }
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [refresh]);

  const booting = status !== 'ready' || !ready || !authenticated;
  return (
    <>
      <LoadingScreen text={t(loadingKey || 'pages.dashboard.loading.dashboard.4116bcc3', null, 'در حال بارگذاری...')} hide={!booting} />
      {authenticated ? children : null}
    </>
  );
}
