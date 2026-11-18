'use client';
/*
 * Ported from legacy trades/new/index.html (markup + 3 inline scripts).
 * API: GET /api/v1/trades/symbols (integration gap G2 — not in modern API yet;
 * failure falls back to the built-in list exactly as legacy), POST /api/v1/trades.
 * Time evidence: raw wall-clock text only (VeloraTime.buildTimeEvidence port,
 * no tz conversion in the browser).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import './legacy.css';
import * as api from '@/lib/api/client';
import { useI18n } from '@/i18n/I18nProvider';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { useTimedMessage } from '@/lib/hooks/useTimedFlag';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { SymbolIcon, displayCode, nameOf, base as symBase, useSymbolRegistry } from '@/lib/symbols/symbolIcons';
import { EmotionIcon } from '@/lib/symbols/emotionIcons';

const KNOWN_SYMBOLS = [
  'BTC/USDT','ETH/USDT','SOL/USDT','BNB/USDT','XRP/USDT','ADA/USDT','DOGE/USDT','LTC/USDT','DOT/USDT','AVAX/USDT','LINK/USDT','MATIC/USDT',
  'EUR/USD','GBP/USD','USD/JPY','USD/CHF','AUD/USD','USD/CAD','NZD/USD','EUR/GBP','EUR/JPY','GBP/JPY','EUR/CHF','AUD/JPY',
  'CAD/JPY','CHF/JPY','NZD/JPY','CAD/CHF','EUR/CAD','EUR/AUD','EUR/NZD','AUD/CAD','AUD/NZD','AUD/CHF',
  'GBP/CHF','GBP/CAD','GBP/AUD','GBP/NZD','NZD/CAD','NZD/CHF',
  'XAU/USD','XAG/USD','XPT/USD','XPD/USD','OIL','BRENT','COPPER','NG',
  'NAS100','SPX500','US30','GER40','DAX40','DAX','FTSE100','UK100','N225','JP225','HSI','VIX',
];
const GROUP_ORDER = ['starred', 'recent', 'metal', 'forex', 'crypto', 'commodity', 'index', 'other'] as const;
type GroupKey = typeof GROUP_ORDER[number];
const DEFAULT_STARS = ['XAU/USD', 'XAG/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'NAS100'];

function classifySymbol(symbol: string): GroupKey {
  const u = String(symbol || '').toUpperCase().replace(/\//g, '');
  if (/XAU|XAG|XPT|XPD/.test(u)) return 'metal';
  if (/BTC|ETH|SOL|BNB|XRP|ADA|DOGE|LTC|DOT|AVAX|LINK|MATIC|USDT/.test(u)) return 'crypto';
  if (/OIL|BRENT|WTI|NG|GAS|COPPER/.test(u)) return 'commodity';
  if (/NAS|SPX|SP500|US30|GER|DAX|FTSE|UK100|N225|JP225|HSI|VIX/.test(u)) return 'index';
  if (/^[A-Z]{6}$/.test(u)) return 'forex';
  return 'other';
}
function readRecents(): string[] {
  try { const raw = JSON.parse(localStorage.getItem('velora_recent_symbols') || '[]'); return Array.isArray(raw) ? raw.slice(0, 6) : []; } catch { return []; }
}
function pushRecent(symbol: string) {
  const next = [symbol].concat(readRecents().filter((s) => s !== symbol)).slice(0, 6);
  try { localStorage.setItem('velora_recent_symbols', JSON.stringify(next)); } catch { /* ignore */ }
}
function readStars(): string[] {
  try {
    const raw = localStorage.getItem('velora_starred_symbols');
    if (raw == null) return DEFAULT_STARS.slice();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULT_STARS.slice();
  } catch { return DEFAULT_STARS.slice(); }
}
function writeStars(list: string[]) { try { localStorage.setItem('velora_starred_symbols', JSON.stringify(list)); } catch { /* ignore */ } }

/* VeloraTime.toRawWallText / buildTimeEvidence (no tz math) */
function toRawWallText(value: unknown): string | null {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace('T', ' ');
  return s.length > 64 ? s.slice(0, 64) : s;
}
function buildTimeEvidence(openRaw: string, closeRaw: string) {
  const body: Record<string, string> = {};
  const o = toRawWallText(openRaw), c = toRawWallText(closeRaw);
  if (o) body.rawOpenText = o;
  if (c) body.rawCloseText = c;
  return body;
}
function localWall(offsetMs = 0) {
  const d = new Date(Date.now() + offsetMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
const LATIN = (s: string) => s.replace(/[\u06F0-\u06F9\u0660-\u0669]/g, (c) => { const n = c.charCodeAt(0); return n >= 0x06F0 ? String(n - 0x06F0) : String(n - 0x0660); });

export default function NewTradePage() {
  const { t, locale, number, errorMessage } = useI18n();
  useSymbolRegistry();

  const [allSymbols, setAllSymbols] = useState<string[]>(KNOWN_SYMBOLS.slice());
  const [symbol, setSymbol] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [starsVersion, bump] = useState(0);
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [emotion, setEmotion] = useState(4);
  const [busy, setBusy] = useState(false);
  const error = useTimedMessage<string>(4000);
  const toast = useTimedMessage<{ msg: string; err: boolean }>(2500);
  const [f, setF] = useState({ entry: '', exit: '', volume: '', contract: '1', commission: '0', swap: '0', sl: '', tp: '', openTime: '', closeTime: '', strategy: '', notes: '' });
  const searchRef = useRef<HTMLInputElement>(null);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    api.request<{ symbols?: unknown[] }>('/api/v1/trades/symbols').then((data) => {
      setAllSymbols((prev) => {
        const next = prev.slice();
        (data.symbols || []).forEach((s) => { const u = String(s || '').trim().toUpperCase(); if (u && next.indexOf(u) === -1) next.push(u); });
        return next;
      });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      setF((p) => ({ ...p, openTime: p.openTime || localWall(0), closeTime: p.closeTime || localWall(3600000) }));
    }, 200);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!(e.target as Element).closest('#symSelect')) setOpen(false); };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  const showError = error.show;
  const showToast = (msg: string, isErr = false) => toast.show({ msg, err: isErr });

  /* ---- symbol list ---- */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allSymbols;
    return allSymbols.filter((s) => (s + ' ' + displayCode(s) + ' ' + (symBase(s) || '') + ' ' + (nameOf(s, locale) || '')).toLowerCase().indexOf(q) !== -1);
  }, [allSymbols, query, locale]);
  const groups = useMemo(() => {
    void starsVersion;
    const buckets: Record<GroupKey, string[]> = { starred: [], recent: [], metal: [], forex: [], crypto: [], commodity: [], index: [], other: [] };
    const stars = readStars().filter((s) => filtered.indexOf(s) !== -1);
    const recents = readRecents().filter((s) => filtered.indexOf(s) !== -1 && stars.indexOf(s) === -1);
    stars.forEach((s) => buckets.starred.push(s));
    recents.forEach((s) => buckets.recent.push(s));
    filtered.forEach((s) => { if (stars.indexOf(s) !== -1 || recents.indexOf(s) !== -1) return; buckets[classifySymbol(s)].push(s); });
    return buckets;
  }, [filtered, starsVersion]);
  const GROUP_TITLE: Record<GroupKey, string> = {
    starred: t('pages.trades.new.p05.group_starred'), recent: t('pages.trades.new.p05.group_recent'),
    crypto: t('pages.trades.new.p05.group_crypto'), forex: t('pages.trades.new.p05.group_forex'),
    metal: t('pages.trades.new.p05.group_metal'), commodity: t('pages.trades.new.p05.group_commodity'),
    index: t('pages.trades.new.p05.group_index'), other: t('pages.trades.new.p05.group_other'),
  };
  const stars = readStars();
  function selectSymbol(s: string) { setSymbol(s); pushRecent(s); setOpen(false); bump((v) => v + 1); }
  function toggleStar(s: string) {
    const list = readStars(); const i = list.indexOf(s);
    if (i === -1) list.unshift(s); else list.splice(i, 1);
    writeStars(list); bump((v) => v + 1);
  }

  /* ---- calculate ---- */
  const entry = parseFloat(f.entry) || 0, exit = parseFloat(f.exit) || 0, volume = parseFloat(f.volume) || 0;
  const contract = parseFloat(f.contract) || 1, commission = parseFloat(f.commission) || 0, swap = parseFloat(f.swap) || 0, stopLoss = parseFloat(f.sl) || 0;
  const [preview, setPreview] = useState({ pnl: '+0.00', cls: 'big', r: '0.00' });
  useEffect(() => {
    if (entry && exit && volume) {
      let difference = exit - entry;
      if (direction === 'sell') difference = -difference;
      const pnl = difference * volume * contract - commission - swap;
      const risk = Math.abs(entry - stopLoss), reward = Math.abs(exit - entry);
      setPreview({
        pnl: LATIN(number(pnl, { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'always' })),
        cls: 'big ' + (pnl >= 0 ? 'pos' : 'neg'),
        r: LATIN(number(risk > 0 ? reward / risk : 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 })),
      });
    }
  }, [entry, exit, volume, contract, commission, swap, stopLoss, direction, number]);

  async function submit() {
    const sym = symbol.trim().toUpperCase();
    if (!sym) { showError(t('trades.symbolRequired')); return; }
    if (!f.entry || !f.exit || !f.volume) { showError(t('trades.coreFieldsRequired')); return; }
    if (!f.openTime || !f.closeTime) { showError(t('trades.timesRequired')); return; }
    setBusy(true);
    try {
      await api.request('/api/v1/trades', {
        method: 'POST',
        body: {
          symbol: sym, direction, entryPrice: f.entry, exitPrice: f.exit, volume: f.volume,
          contractSize: f.contract || 1, commission: f.commission || 0, swap: f.swap || 0,
          stopLoss: f.sl || null, takeProfit: f.tp || null, openTime: f.openTime, closeTime: f.closeTime,
          ...buildTimeEvidence(f.openTime, f.closeTime),
          strategyTag: f.strategy.trim() || null, emotionalScore: emotion, notes: f.notes.trim() || null,
        },
      });
      showToast(t('trades.created'));
      setTimeout(() => window.location.replace('/trades/'), 900);
    } catch (e) {
      showError(errorMessage(e, 'trades.createFailed'));
      setBusy(false);
    }
  }

  const ltr = { lang: 'en', dir: 'ltr' as const };
  const symName = symbol ? nameOf(symbol, locale) : '';

  return (
    <div className="pg-trades-new">
      <AppShell topRight={<NewTradeLink />}>
        <div className="panel">
          <InlineNotice visible={error.visible}>{error.value}</InlineNotice>
          <div className="form-grid">
            <div className="desk-sec"><span>{t('pages.trades.new.p05.symbol_setup', null, 'نماد و ستاپ')}</span></div>
            <div className="field">
              <label>{t('common.symbol.159cbe33', null, 'نماد')}</label>
              <div className="sym-select" id="symSelect">
                <button className={`sym-select-btn${open ? ' open' : ''}`} id="symBtn" type="button" onClick={() => { setOpen((o) => !o); setTimeout(() => searchRef.current?.focus(), 0); }}>
                  <span id="symBtnIcon">{symbol ? <SymbolIcon symbol={symbol} size={32} /> : null}</span>
                  <span className="sym-btn-copy">
                    {symbol
                      ? <span id="symBtnText" {...ltr} style={{ color: 'var(--txt)', letterSpacing: '.04em' }}>{displayCode(symbol)}</span>
                      : <span id="symBtnText" style={{ color: 'var(--faint)' }}>{t('pages.trades.new.select.symbol.c19b8d3d', null, 'انتخاب نماد...')}</span>}
                    <span className="sym-btn-meta" id="symBtnMeta">{symName}</span>
                  </span>
                  <svg className="sym-caret" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" viewBox="0 0 24 24" width="14"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                <div className={`sym-dropdown${open ? ' show' : ''}`} id="symDropdown">
                  <div className="sym-search-wrap">
                    <svg fill="none" height="15" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="15"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
                    <input ref={searchRef} autoComplete="off" id="symSearch" placeholder={t('pages.trades.new.search.symbol.btc.gold.xau.199a33aa', null, 'جستجوی نماد... (BTC، طلا، XAU)')} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { const first = GROUP_ORDER.map((k) => groups[k][0]).find(Boolean); if (first) selectSymbol(first); } }} />
                  </div>
                  <div className="sym-list" id="symList">
                    {GROUP_ORDER.map((key) => groups[key].length ? (
                      <React.Fragment key={key}>
                        <div className="sym-group">{GROUP_TITLE[key]}</div>
                        {groups[key].map((s) => {
                          const starred = stars.indexOf(s) !== -1;
                          const name = nameOf(s, locale);
                          return (
                            <div className={`sym-item${symbol === s ? ' sel' : ''}`} key={s} onClick={() => selectSymbol(s)}>
                              <SymbolIcon symbol={s} size={34} />
                              <span className="sym-symbol" data-value-type="symbol" {...ltr}>{displayCode(s)}</span>
                              {name ? <span className="sym-name">{name}</span> : null}
                              <button type="button" className={`sym-star${starred ? ' on' : ''}`} aria-label={t('pages.trades.new.p05.star')} onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleStar(s); }}>{starred ? '★' : '☆'}</button>
                            </div>
                          );
                        })}
                      </React.Fragment>
                    ) : null)}
                  </div>
                  <div className="sym-empty" id="symEmpty" style={{ display: filtered.length ? 'none' : 'block' }}>{t('pages.trades.new.no.symbol.found.59946e6a', null, 'نمادی یافت نشد')}</div>
                </div>
              </div>
              <div className="hint">{t('pages.trades.new.trading.symbol.search.or.type.06beee9a', null, 'نماد معاملاتی — با جستجو پیدا کنید یا تایپ کنید')}</div>
            </div>
            <div className="field">
              <label>{t('common.strategy.1b590fba', null, 'استراتژی')}</label>
              <input className="input" id="strategy" placeholder={t('pages.trades.new.pullback.breakout.296f1e6b', null, 'پل‌بک، بریک‌اوت...')} value={f.strategy} onChange={set('strategy')} />
            </div>

            <div className="desk-sec"><span>{t('pages.trades.new.p05.direction_section', null, 'جهت معامله')}</span></div>
            <div className="field" style={{ gridColumn: '1/-1' }}>
              <label>{t('pages.trades.new.trade.direction.2f8ac7b6', null, 'جهت معامله')}</label>
              <div className="dir-toggle">
                <div className={`dir-opt buy${direction === 'buy' ? ' sel' : ''}`} id="optBuy" onClick={() => setDirection('buy')}><div className="d-lbl">{t('pages.trades.new.buy.buy.7dab154d', null, '▲ خرید (BUY)')}</div><div className="d-sub">{t('pages.trades.new.long.expecting.growth.5bf30f85', null, 'پوزیشن لانگ — انتظار رشد')}</div></div>
                <div className={`dir-opt sell${direction === 'sell' ? ' sel' : ''}`} id="optSell" onClick={() => setDirection('sell')}><div className="d-lbl">{t('pages.trades.new.sell.sell.7e23a93b', null, '▼ فروش (SELL)')}</div><div className="d-sub">{t('pages.trades.new.short.expecting.decline.c09a8f55', null, 'پوزیشن شورت — انتظار افت')}</div></div>
              </div>
            </div>
            <div className="field"><label>{t('pages.trades.new.entry.price.8d5e74ab', null, 'قیمت ورود')}</label><input className="input" id="entry" inputMode="decimal" placeholder="61000" required type="text" value={f.entry} onChange={set('entry')} /></div>
            <div className="field"><label>{t('pages.trades.new.exit.price.7ded7c82', null, 'قیمت خروج')}</label><input className="input" id="exit" inputMode="decimal" placeholder="64200" required type="text" value={f.exit} onChange={set('exit')} /></div>
            <div className="field"><label>{t('pages.trades.new.volume.lot.6b042d07', null, 'حجم (لات)')}</label><input className="input" id="volume" inputMode="decimal" placeholder="0.5" required type="text" value={f.volume} onChange={set('volume')} /></div>
            <div className="field"><label>{t('pages.trades.new.contract.size.fbd9b24e', null, 'اندازه قرارداد')}</label><input className="input" id="contract" inputMode="decimal" placeholder="1" type="text" value={f.contract} onChange={set('contract')} /></div>
            <div className="field"><label>{t('pages.trades.new.commission.075f0257', null, 'کمیسیون')}</label><input className="input" id="commission" inputMode="decimal" placeholder="0" type="text" value={f.commission} onChange={set('commission')} /></div>
            <div className="field"><label>{t('pages.trades.new.swap.10e4a1fd', null, 'سوآپ')}</label><input className="input" id="swap" inputMode="decimal" placeholder="0" type="text" value={f.swap} onChange={set('swap')} /></div>
            <div className="field"><label>{t('pages.trades.new.stop.loss.sl.a16f5daa', null, 'حد ضرر (SL)')}</label><input className="input" id="sl" inputMode="decimal" placeholder={t('common.optional.4efaacbe', null, 'اختیاری')} type="text" value={f.sl} onChange={set('sl')} /></div>
            <div className="field"><label>{t('pages.trades.new.take.profit.tp.f3e73cce', null, 'حد سود (TP)')}</label><input className="input" id="tp" inputMode="decimal" placeholder={t('common.optional.4efaacbe', null, 'اختیاری')} type="text" value={f.tp} onChange={set('tp')} /></div>

            <div className="desk-sec"><span>{t('pages.trades.new.p05.timing_psychology', null, 'زمان و روان‌شناسی')}</span></div>
            <div className="field">
              <label>{t('pages.trades.new.open.time.f5d607ee', null, 'زمان باز')}</label>
              <input autoComplete="off" className="input" id="openTime" placeholder="2026-08-14T13:01" required spellCheck={false} type="text" value={f.openTime} onChange={set('openTime')} />
              <div className="session-row"><span className="session-pill off" id="sessionPill">{t('pages.trades.new.p05.session_unknown', null, 'سشن')}</span><span className="session-sub" id="sessionSub" /></div>
            </div>
            <div className="field"><label>{t('pages.trades.new.close.time.3fc955ae', null, 'زمان بسته')}</label><input autoComplete="off" className="input" id="closeTime" placeholder="2026-08-14T13:01" required spellCheck={false} type="text" value={f.closeTime} onChange={set('closeTime')} /></div>
            <div className="field" style={{ gridColumn: '1/-1' }}>
              <label>{t('pages.trades.new.emotional.score.3adcd56b', null, 'امتیاز احساسی')}</label>
              <div className="emot-row" id="emotRow">
                {[
                  [1, t('pages.trades.new.very.bad.49845cb0', null, 'خیلی بد')], [2, t('pages.trades.new.bad.49ec77c4', null, 'بد')], [3, t('pages.trades.new.neutral.373d476e', null, 'خنثی')],
                  [4, t('pages.trades.new.good.107c8e66', null, 'خوب')], [5, t('common.excellent.9c67b8eb', null, 'عالی')],
                ].map(([lv, label]) => (
                  <div className={`emot${emotion === lv ? ' sel' : ''}`} data-e={lv} key={lv as number} onClick={() => setEmotion(lv as number)}>
                    <span className="emot-ico"><EmotionIcon level={lv as number} size={30} /></span><small>{label}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="field" style={{ gridColumn: '1/-1' }}><label>{t('pages.trades.new.notes.936ba8f8', null, 'یادداشت')}</label><input className="input" id="notes" placeholder={t('pages.trades.new.analysis.entry.rationale.notes.f8de391f', null, 'تحلیل، دلیل ورود، نکات...')} value={f.notes} onChange={set('notes')} /></div>
          </div>

          <div className="pnl-box">
            <div>
              <div className="lbl">{t('pages.trades.new.estimated.p.l.d17fba70', null, 'سود/زیان تخمینی')}</div>
              <div className={preview.cls} id="pnlPreview" {...ltr}>{preview.pnl}</div>
              <div className="pnl-meta"><span>R: <b id="rPreview" {...ltr}>{preview.r}</b></span></div>
            </div>
            <div style={{ textAlign: 'left' }}>
              <div className="lbl">{t('pages.trades.new.details.27928bea', null, 'جزئیات')}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9 }}>
                <span>{t('common.login.e09e596b', null, 'ورود')}</span> <b id="mEntry" {...ltr}>{entry ? LATIN(number(entry, { maximumFractionDigits: 8 })) : '—'}</b>{' '}
                <span>{t('pages.trades.new.logout.e97aeff6', null, '· خروج')}</span> <b id="mExit" {...ltr}>{exit ? LATIN(number(exit, { maximumFractionDigits: 8 })) : '—'}</b><br />
                <span>{t('pages.trades.new.volume.b81fbec4', null, 'حجم')}</span> <b id="mVol" {...ltr}>{volume ? LATIN(number(volume, { maximumFractionDigits: 4 })) : '—'}</b>{' '}
                <span>{t('pages.trades.new.commission.1254ba0b', null, '· کمیسیون')}</span> <b id="mComm" {...ltr}>{LATIN(number(commission, { maximumFractionDigits: 2 }))}</b>
              </div>
            </div>
          </div>
          <button className="btn-gold" id="submitBtn" style={{ marginTop: 18 }} disabled={busy} onClick={() => void submit()}>
            {busy ? (<><span className="btn-spinner" /> {t('trades.saving')}</>) : t('pages.trades.new.record.trade.in.journal.d60654ec', null, 'ثبت معامله در ژورنال')}
          </button>
        </div>
      </AppShell>
      <div className={`toast${toast.value?.err ? ' err' : ''}${toast.visible ? ' show' : ''}`}>{toast.value?.msg}</div>
    </div>
  );
}
