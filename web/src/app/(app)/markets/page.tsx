'use client';
/* Market overview: top mover, next event, live watchlist. Content is illustrative (no market-data endpoint exists — gap G5). */
import React from 'react';
import './legacy.css';
import { useI18n } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { StatCards, ShowcasePanel } from '@/components/showcase/StatCards';

export default function MarketsPage() {
  const { t, percent, currency, number } = useI18n();
  const pct = (v: number) => percent(v, { signDisplay: 'always', maximumFractionDigits: 1 });
  const watchlist = [
    { sym: 'XAU/USD', name: t('pages.markets.gold.us.dollar.b891c472', null, 'طلا / دلار آمریکا'), price: currency(2458.3, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), chg: 0.012 },
    { sym: 'EUR/USD', name: t('pages.markets.euro.us.dollar.8a347568', null, 'یورو / دلار آمریکا'), price: number(1.0924, { minimumFractionDigits: 4, maximumFractionDigits: 4 }), chg: 0.004 },
    { sym: 'BTC/USD', name: t('pages.markets.bitcoin.dollar.d01a70e1', null, 'بیت‌کوین / دلار'), price: currency(62450, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), chg: 0.038 },
    { sym: 'US30', name: t('pages.markets.dow.jones.index.6f659eda', null, 'شاخص داوجونز'), price: number(40320.5, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), chg: 0.009 },
  ];
  return (
    <div className="pg-markets">
      <AppShell topRight={<NewTradeLink />}>
        <StatCards cards={[
          { label: t('pages.markets.top.symbol.today.2bf63bd8', null, 'نماد برتر امروز'), value: <>XAU/USD <span>{pct(0.012)}</span></>, color: '#4CD39A' },
          { label: t('pages.markets.next.event.e4cec292', null, 'رویداد بعدی'), value: t('pages.markets.us.cpi.16.00.433e4048', null, 'شاخص CPI آمریکا (16:00)') },
          { label: t('pages.markets.daily.changes.8e3bb240', null, 'تغییرات روزانه'), value: t('pages.markets.display.d201afbc', null, 'نمایش') },
        ]} />
        <ShowcasePanel title={t('pages.markets.live.forex.and.crypto.watchlist.707e34a1', null, 'واچ‌لیست زنده فارکس و کریپتو (Live Watchlist)')}>
          {watchlist.map((w) => (
            <div className="sc-row" key={w.sym}>
              <div><b>{w.sym}</b> <small className="sub">{w.name}</small></div>
              <div className="end"><b>{w.price}</b> <span className="sc-up">{pct(w.chg)}</span></div>
            </div>
          ))}
        </ShowcasePanel>
      </AppShell>
    </div>
  );
}
