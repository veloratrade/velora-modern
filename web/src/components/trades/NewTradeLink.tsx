'use client';
import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';
/** Top-bar "＋ New trade" action shared by app pages (legacy `.velora-btn-back` green variant). */
export function NewTradeLink() {
  const { t } = useI18n();
  return <a className="velora-btn-back velora-btn-newtrade" href="/trades/new/"><span>{t('common.new.trade.b499532d', null, '＋ ثبت معامله')}</span></a>;
}
