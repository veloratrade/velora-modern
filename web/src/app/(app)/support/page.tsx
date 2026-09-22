'use client';
/* Support centre: tickets list, new ticket, thread view (opens ?ticket=<id> on load like legacy). */
import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import './legacy.css';
import { useLocaleFeatures } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { SupportDesk } from '@/components/support/SupportDesk';

function DeskWithDeepLink() {
  const params = useSearchParams();
  const raw = params.get('ticket');
  const initial = raw ? parseInt(raw, 10) || 0 : 0;
  return <SupportDesk initialTicketId={initial || undefined} />;
}

export default function SupportPage() {
  useLocaleFeatures(['support']);
  return (
    <div className="pg-support">
      <AppShell topRight={<NewTradeLink />}>
        <Suspense fallback={null}><DeskWithDeepLink /></Suspense>
      </AppShell>
    </div>
  );
}
