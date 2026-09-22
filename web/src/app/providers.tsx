'use client';
import React from 'react';
import { I18nProvider } from '@/i18n/I18nProvider';
import type { Feature } from '@/i18n/catalog';
import { SessionProvider } from '@/lib/auth/session';
import { ToastProvider } from '@/components/ui/Toast';

export function Providers({ features, children }: { features: Feature[]; children: React.ReactNode }) {
  return (
    <I18nProvider features={features}>
      <SessionProvider>
        <ToastProvider>{children}</ToastProvider>
      </SessionProvider>
    </I18nProvider>
  );
}
