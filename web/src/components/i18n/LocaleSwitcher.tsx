'use client';
/*
 * Port of legacy `mountSwitcher()` in velora-localization.js.
 * App pages: placement="inline" (prepended into `.velora-nav-right`).
 * Auth/minimal pages: placement="dock" (fixed bottom corner).
 */
import React from 'react';
import { LOCALE_REGISTRY, SUPPORTED_LOCALES, type LocaleCode } from '@/i18n/registry';
import { useI18n } from '@/i18n/I18nProvider';

export function LocaleSwitcher({ placement }: { placement: 'inline' | 'dock' }) {
  const { locale, setLocale, t } = useI18n();
  const label = t('common.language', null, 'Language');
  return (
    <div
      className="velora-locale-switcher"
      data-velora-locale-switcher=""
      data-placement={placement}
      data-context={placement === 'dock' ? 'fallback' : 'app'}
      title={label}
    >
      <span className="velora-locale-icon" aria-hidden="true" />
      <label htmlFor="velora-locale-select">{label}</label>
      <select
        id="velora-locale-select"
        data-velora-locale-select=""
        aria-label={label}
        value={locale}
        onChange={(e) => void setLocale(e.target.value as LocaleCode)}
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code}>
            {LOCALE_REGISTRY.locales[code].nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}
