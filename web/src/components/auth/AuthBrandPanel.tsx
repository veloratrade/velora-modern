'use client';
/* Legacy login/register left "brand-panel": headline, animated sample equity curve, chips, trust row. */
import React from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { BrandLogo } from '@/components/brand/LogoMark';

export function AuthBrandPanel({ variant }: { variant: 'login' | 'register' }) {
  const { t, percent, number } = useI18n();
  const p = variant === 'login' ? 'pages.login' : 'pages.register';
  return (
    <div className="brand-panel">
      <BrandLogo />
      <h2>
        <span>{t('common.trading.journal.c6cb0c73', null, 'ژورنال معاملاتی')}</span>
        <br />
        <span>{t('common.in.8f5d0068', null, 'در')}</span>{' '}
        <span className="grad">{t(`${p}.world.class.88072244`, null, 'سطح جهانی')}</span>
      </h2>
      <p className="sub">
        {t(
          `${p}.record.every.trade.and.take.your.strategies.92bc640a`,
          null,
          'هر معامله‌تان را ثبت کنید و با شاخص‌های حرفه‌ای، استراتژی‌های خود را به سطح بعدی ببرید.',
        )}
      </p>
      <div className="chart-wrap">
        <div className="chart-head">
          <span className="lbl">{t(`${p}.equity.curve.sample.9799e6be`, null, 'منحنی سرمایه — نمونه')}</span>
          <span className="val">
            <span data-value-type="percent">{percent(0.324, { signDisplay: 'always', maximumFractionDigits: 1 })}</span>
            <em>▲</em>
          </span>
        </div>
        <svg className="chart-svg" preserveAspectRatio="none" viewBox="0 0 420 110">
          <defs>
            <linearGradient id="lineGrad" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#b88d1d" />
              <stop offset=".5" stopColor="#fce38a" />
              <stop offset="1" stopColor="#d4af37" />
            </linearGradient>
            <linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#d4af37" stopOpacity=".45" />
              <stop offset="1" stopColor="#d4af37" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line className="chart-grid" x1="0" x2="420" y1="30" y2="30" />
          <line className="chart-grid" x1="0" x2="420" y1="65" y2="65" />
          <line className="chart-grid" x1="0" x2="420" y1="100" y2="100" />
          <path className="chart-area" d="M0,95 C60,88 80,70 130,72 C180,74 200,48 250,50 C300,52 330,30 380,26 L420,24 L420,110 L0,110 Z" />
          <path className="chart-line" d="M0,95 C60,88 80,70 130,72 C180,74 200,48 250,50 C300,52 330,30 380,26 L420,24" />
          <circle className="chart-dot" cx="420" cy="24" r="4" />
        </svg>
        <div className="float-chip fc-1">
          <span className="ic">
            <svg fill="none" height="14" viewBox="0 0 24 24" width="14">
              <path d="M4 16.5 9.2 11l3.6 3.5L20 7.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M14.6 7.2H20v5.3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>
            <span data-value-type="percent">{percent(0.24, { signDisplay: 'always', maximumFractionDigits: 0 })}</span>
            <small>{t(`${p}.monthly.growth.6ded9551`, null, 'رشد ماهانه')}</small>
          </span>
        </div>
        <div className="float-chip fc-2">
          <span className="ic">
            <svg fill="none" height="14" viewBox="0 0 24 24" width="14">
              <circle cx="12" cy="12" r="8.1" stroke="currentColor" strokeWidth="1.8" />
              <path d="M12 7.6V12l3.1 2.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span>
            R <span data-value-type="number">{number(2.1, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
            <small>{t(`${p}.average.risk.40b91ff4`, null, 'میانگین ریسک')}</small>
          </span>
        </div>
      </div>
      <div className="trust-row">
        <span className="tr">
          <span className="tic">
            <svg fill="none" viewBox="0 0 24 24">
              <path d="M12 3.2 19.2 6v6.1c0 4.6-3.1 7.8-7.2 9.3C8 19.9 4.8 16.7 4.8 12.1V6L12 3.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="m8.7 12 2.2 2.2 4.4-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>{' '}
          <span>{t(`${p}.bank.grade.security.8d30abd2`, null, 'امنیت بانکی')}</span>
        </span>
        <span className="tr">
          <span className="tic">
            <svg fill="none" viewBox="0 0 24 24">
              <path d="M13 3.4 5.2 13.6h6.1L10.4 20.6 18.8 10.2h-6.2L13 3.4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
          </span>{' '}
          <span>{t(`${p}.high.speed.413af29c`, null, 'سرعت بالا')}</span>
        </span>
        <span className="tr">
          <span className="tic">
            <svg fill="none" viewBox="0 0 24 24">
              <path d="m12 3.2 1.9 4.6 5 .6-3.8 3.4 1.1 4.9L12 14.4 7.8 16.7l1.1-4.9-3.8-3.4 5-.6L12 3.2Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
            </svg>
          </span>{' '}
          <span>{t(`${p}.professional.analysis.b017ee85`, null, 'تحلیل حرفه‌ای')}</span>
        </span>
      </div>
    </div>
  );
}
