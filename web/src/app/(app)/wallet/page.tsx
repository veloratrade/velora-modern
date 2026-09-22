'use client';
/* Wallet: aggregated balances of connected accounts. Illustrative until wired to /accounts aggregation (gap G5). */
import React from 'react';
import './legacy.css';
import { useI18n } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { StatCards, ShowcasePanel } from '@/components/showcase/StatCards';

export default function WalletPage() {
  const { t, currency } = useI18n();
  const usd = (v: number) => currency(v, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const accounts = [
    ['pages.wallet.primary.vittaverse.account.813578.2057ece3', 'حساب اصلی Vittaverse (813578)'],
    ['pages.wallet.second.vittaverse.account.815526.60c69744', 'حساب دوم Vittaverse (815526)'],
  ];
  return (
    <div className="pg-wallet">
      <AppShell topRight={<NewTradeLink />}>
        <StatCards cards={[
          { label: t('pages.wallet.total.account.balance.9cc8b58f', null, 'موجودی کل حساب‌ها'), value: usd(10432.5), color: '#4CD39A' },
          { label: t('pages.wallet.connected.accounts.b3737245', null, 'حساب‌های متصل'), value: t('pages.wallet.2.active.accounts.925c357f', null, '2 حساب فعال'), color: '#fce38a' },
          { label: t('pages.wallet.live.equity.d468d9ec', null, 'اکویتی لحظه‌ای'), value: usd(10510.2), color: '#3B82F6' },
        ]} />
        <ShowcasePanel title={t('pages.wallet.connected.trading.accounts.and.cloud.wallet.63cd7eff', null, 'حساب‌های معاملاتی متصل و کیف پول ابری')} gap={12}>
          {accounts.map(([k, fb]) => (
            <div className="sc-row lg" key={k}>
              <div>
                <b style={{ fontSize: 14, color: '#fce38a' }}>{t(k, null, fb)}</b><br />
                <small className="sub">{t('common.mt5.cloud.bridge.vittaverse.server.0025d42f', null, 'MT5 Cloud Bridge · سرور Vittaverse-Server')}</small>
              </div>
              <div className="end">
                <b style={{ color: '#4CD39A', fontSize: 16 }}>{usd(10432.5)}</b><br />
                <small style={{ color: '#3B82F6' }}>EQ <span>{usd(10510.2)}</span></small>
              </div>
            </div>
          ))}
        </ShowcasePanel>
      </AppShell>
    </div>
  );
}
