'use client';
/* VELORA AI: journal Q&A + analytic insights. */
import React from 'react';
import './legacy.css';
import { useI18n } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { JournalChat, InsightCards } from '@/components/intelligence/JournalChat';

export default function IntelligencePage() {
  const { t } = useI18n();
  return (
    <div className="pg-intelligence">
      <AppShell topRight={<NewTradeLink />}>
        <header className="topbar" style={{ marginBottom: 18 }}>
          <div>
            <div className="h1"><span>{t('common.ai.834c1d93', null, 'هوش مصنوعی')}</span> <span className="grad">{t('common.velora.ai.9017596d', null, 'VELORA AI')}</span> ✦</div>
            <div className="sub">{t('pages.intelligence.automatic.trade.and.emotional.behaviour.analysis.with.a328e039', null, 'تحلیل خودکار معاملات، رفتار احساسی و پرسش از ژورنال ترید')}</div>
          </div>
        </header>
        <JournalChat />
        <InsightCards />
      </AppShell>
    </div>
  );
}
