'use client';
/* News digest: headline stats + feed. Content is illustrative (no news endpoint exists — gap G5). */
import React from 'react';
import './legacy.css';
import { useI18n } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { StatCards, ShowcasePanel } from '@/components/showcase/StatCards';

export default function NewsPage() {
  const { t, percent, number } = useI18n();
  const feed = [
    ['pages.news.gold.approached.a.new.all.time.high.18dddc59', 'طلا به سقف تاریخی جدید 2,458 دلار نزدیک شد', 'pages.news.30m.ago.bloomberg.7ef42f29', '30 دقیقه پیش · Bloomberg', 'pages.news.higher.demand.for.safe.haven.assets.and.b242598a', 'افزایش تقاضا برای دارایی‌های امن و انتظار برای کاهش نرخ بهره آمریکا موجب رشد قوی طلا در سشن لندن شد.'],
    ['pages.news.us.cpi.inflation.data.came.in.below.03cb6e0b', 'آمار تورم آمریکا (CPI) کمتر از پیش‌بینی‌ها منتشر شد', 'pages.news.2h.ago.reuters.45c2af51', '2 ساعت پیش · Reuters', 'pages.news.annual.inflation.reached.3.2.raising.the.63336563', 'تورم سالانه به 3.2٪ رسید که احتمال کاهش نرخ بهره در جلسه بعدی فدرال رزرو را به بالای 85٪ رساند.'],
    ['pages.news.bitcoin.reclaimed.62k.channel.b7adea1e', 'بیت‌کوین کانال 62 هزار دلار را با قدرت پس گرفت', 'pages.news.4h.ago.coindesk.907091e0', '4 ساعت پیش · CoinDesk', 'pages.news.bitcoin.etfs.recorded.positive.inflows.for.a.a44d9141', 'ورود سرمایه به صندوق‌های ETF بیت‌کوین برای سومین روز متوالی مثبت شد.'],
  ];
  return (
    <div className="pg-news">
      <AppShell topRight={<NewTradeLink />}>
        <StatCards cards={[
          { label: t('pages.news.today.s.important.news.88663162', null, 'خبرهای مهم امروز'), value: t('pages.news.3.key.events.b5ebaa7f', null, '3 رویداد کلیدی'), color: '#fce38a' },
          { label: t('pages.news.high.risk.events.0b69975c', null, 'رویدادهای پرریسک'), value: t('pages.news.us.interest.rate.0d47e91b', null, 'نرخ بهره آمریکا'), color: '#FF6B6B' },
          { label: t('pages.news.dollar.index.dxy.a70e9ab8', null, 'شاخص دلار (DXY)'), value: <>{number(103.45, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({percent(0.003, { signDisplay: 'always', maximumFractionDigits: 1 })})</>, color: '#4CD39A' },
        ]} />
        <ShowcasePanel title={t('pages.news.latest.forex.and.crypto.news.live.news.d3dad383', null, 'تازه‌ترین اخبار فارکس و کریپتو (Live News Feed)')} gap={12}>
          {feed.map(([tk, tf, mk, mf, bk, bf]) => (
            <div className="sc-item" key={tk}>
              <div className="sc-item-head"><b>{t(tk, null, tf)}</b><span>{t(mk, null, mf)}</span></div>
              <p>{t(bk, null, bf)}</p>
            </div>
          ))}
        </ShowcasePanel>
      </AppShell>
    </div>
  );
}
