'use client';
/* Ported from legacy `.velora-top-nav-bar` (drawer toggle + right-side actions/back button). */
import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { LocaleSwitcher } from '@/components/i18n/LocaleSwitcher';

export function TopBar({ onToggleSidebar, right }: { onToggleSidebar: () => void; right?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="velora-top-nav-bar" style={{ marginBottom: 14, padding: '10px 16px' }}>
      <div className="velora-nav-left">
        <button
          aria-label={t('common.menu.1f381a4e', null, 'منو')}
          className="sidebar-drawer-toggle"
          onClick={onToggleSidebar}
          type="button"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>
      <div className="velora-nav-right" style={{ gap: 8 }}>
        <LocaleSwitcher placement="inline" />
        {right}
      </div>
    </div>
  );
}
