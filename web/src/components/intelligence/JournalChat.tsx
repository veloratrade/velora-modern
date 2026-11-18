'use client';
import React, { useEffect, useRef } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { useJournalChat } from '@/lib/hooks/useJournalChat';
import './intelligence.css';

const PROMPTS: [string, string][] = [
  ['common.why.did.i.lose.this.month.eedf2355', 'چرا این ماه ضرر کردم؟'],
  ['pages.intelligence.what.is.my.repeated.mistake.2022448e', 'اشتباه تکراری من چیست؟'],
  ['pages.intelligence.what.is.my.best.setup.53d921df', 'بهترین ستاپ من چیست؟'],
  ['pages.intelligence.next.week.plan.07df3891', 'برنامه هفته بعد'],
  ['pages.intelligence.am.i.trading.emotionally.75585ef5', 'آیا هیجانی معامله می‌کنم؟'],
];

function SeedAnswer() {
  const { t, percent, currency } = useI18n();
  return (
    <>
      <b className="ai-head">{t('pages.intelligence.velora.ai.analysis.fc20477c', null, '✦ تحلیل هوش مصنوعی VELORA AI:')}</b>
      <span>{t('pages.intelligence.the.main.causes.of.this.month.s.c7a3da5c', null, 'عامل اصلی افت عملکرد شما در این ماه، ورود خارج از سشن معاملاتی ثبت‌شده و نقض حد ضرر روزانه است.')}</span>
      <div className="ai-evidence">
        <b>{t('pages.intelligence.verifiable.evidence.from.journal.11e76a00', null, 'شواهد قابل بررسی از ژورنال:')}</b>
        <ul>
          <li>{t('pages.intelligence.6.trades.were.recorded.outside.the.london.86707d4e', null, '6 معامله خارج از سشن لندن (بین ساعت 17:00 تا 19:00) ثبت شده است.')}</li>
          <li><span>{t('pages.intelligence.4.trades.were.losses.this.group.s.a5a391d1', null, '4 معامله زیان‌ده بوده‌اند؛ نرخ برد این گروه')}</span> <b className="neg">{percent(0.33, { maximumFractionDigits: 0 })}</b> <span>{t('pages.intelligence.is.431ff080', null, 'است.')}</span></li>
          <li><span>{t('pages.intelligence.total.loss.from.these.trades.aeccb88a', null, 'مجموع زیان این معاملات:')}</span> <b className="neg">{currency(-420, 'USD', { maximumFractionDigits: 0 })}</b></li>
          <li>{t('pages.intelligence.your.personal.rule.i.trade.only.during.a4065101', null, 'قانون شخصی شما: «فقط در سشن لندن معامله می‌کنم.»')}</li>
        </ul>
      </div>
    </>
  );
}

/** "Ask your trading journal" panel: range toggles, prompt chips, transcript and composer. */
export function JournalChat() {
  const { t } = useI18n();
  const chat = useJournalChat();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chat.messages.length]);

  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="ai-panel-head">
        <div>
          <h2>{t('pages.intelligence.ask.your.trading.journal.a231c215', null, 'از ژورنال معاملاتی خود سؤال بپرسید')}</h2>
          <p>{t('pages.intelligence.answers.cite.your.trades.and.rules.stored.3cb87d14', null, 'پاسخ‌ها با استناد به معاملات و قوانین ثبت‌شده شما در دیتابیس تولید می‌شوند.')}</p>
        </div>
        <div className="ai-range">
          <button type="button" className="btn-ghost">{t('common.7.days.4b6569f5', null, '7 روز')}</button>
          <button type="button" className="btn-gold">{t('common.30.days.6ff5e162', null, '30 روز')}</button>
          <button type="button" className="btn-ghost">{t('common.all.ba7d5b65', null, 'همه')}</button>
        </div>
      </div>
      <div className="ai-chips">
        {PROMPTS.map(([k, fb]) => <button type="button" key={k} className="ai-chip" onClick={() => chat.send(t(k, null, fb))}>{t(k, null, fb)}</button>)}
      </div>
      <div className="ai-conv" ref={boxRef}>
        {chat.messages.map((m, i) => m.role === 'user'
          ? <div className="ai-msg user" key={i}><b>{m.seed ? t('common.why.did.i.lose.this.month.eedf2355', null, 'چرا این ماه ضرر کردم؟') : m.text}</b></div>
          : <div className="ai-msg ai" key={i}>{m.kind === 'seed' ? <SeedAnswer /> : <>
              <b className="ai-head tight">{t('pages.intelligence.velora.ai.analysis.fc20477c', null, '✦ تحلیل هوش مصنوعی VELORA AI:')}</b>
              <span>{t('pages.intelligence.simulatedAnswer', null, 'پاسخ شما بر اساس معاملات ثبت‌شده در ژورنال و قوانین مدیریت ریسک محاسبه و ارائه خواهد شد.')}</span>
            </>}</div>)}
      </div>
      <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); chat.send(); }}>
        <input value={chat.draft} onChange={(e) => chat.setDraft(e.target.value)} placeholder={t('pages.intelligence.for.example.did.i.increase.my.position.3c3f7f74', null, 'مثلاً: آیا بعد از ضرر حجمم را زیاد کرده‌ام؟')} />
        <button type="submit">{t('pages.intelligence.send.question.428e0f79', null, 'ارسال سؤال')}</button>
      </form>
    </div>
  );
}

/** Insight cards (best strategy / risk warning). Illustrative content — no insights endpoint (gap G4). */
export function InsightCards() {
  const { t } = useI18n();
  return (
    <div className="panel">
      <div className="ai-insights-head">
        <b>{t('pages.intelligence.analytics.strategy.performance.fea5141c', null, 'بینش‌های تحلیلی و عملکرد استراتژی‌ها')}</b>
        <span className="ai-badge">{t('common.aiInsights', null, 'AI INSIGHTS')}</span>
      </div>
      <div className="ai-insights">
        <div className="ai-insight gold">
          <div className="row"><b>{t('pages.intelligence.best.strategy.this.week.15m.order.block.5fe719d7', null, '✦ بهترین استراتژی هفته: اردر بلاک 15M')}</b><span className="pos">{t('pages.intelligence.72.win.rate.dbd22d81', null, '72٪ نرخ برد')}</span></div>
          <p>{t('pages.intelligence.this.strategy.has.an.excellent.2.4.df78baf8', null, 'شما در این استراتژی نسبت سود به زیان (Win/Loss) فوق‌العاده 2.4 دارید. پیشنهاد می‌شود تمرکز اصلی را روی همین ستاپ بگذارید.')}</p>
        </div>
        <div className="ai-insight red">
          <div className="row"><b className="neg">{t('pages.intelligence.risk.warning.ny.session.a24e21c4', null, '⚠ هشدار مدیریت ریسک در سشن نیویورک')}</b><span className="neg">{t('pages.intelligence.80.of.losses.b0f3b8ea', null, '80٪ ضررها')}</span></div>
          <p>{t('pages.intelligence.most.of.your.losses.occurred.between.17.fa6752b1', null, 'بیشتر ضررهای شما بین ساعات 17:00 تا 19:00 رخ داده است؛ کاهش حجم معاملاتی یا توقف ترید در این ساعات توصیه می‌شود.')}</p>
        </div>
      </div>
    </div>
  );
}
