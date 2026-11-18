'use client';
import React, { useEffect, useState } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { useToast } from '@/components/ui/Toast';
import { useSupportTickets, isClosed, type TicketSummary, type TicketStatus } from '@/lib/hooks/useSupportTickets';
import './support.css';

const STATUS_COLOR: Record<string, string> = { open: '#4CD39A', pending: '#ffb703' };
const STATUS_KEY: Record<TicketStatus, [string, string]> = {
  open: ['pages.support.status.open', 'Open'], pending: ['pages.support.status.awaiting_your_reply', 'Awaiting your reply'],
  closed: ['pages.support.status.closed', 'Closed'], archived: ['pages.support.status.archived', 'Archived'],
};

function Badges({ t: tk }: { t: TicketSummary }) {
  const { t } = useI18n();
  const c = STATUS_COLOR[tk.status] || '#8fa0c0';
  const sk = STATUS_KEY[tk.status];
  const wf = tk.waiting_for;
  const wc = wf === 'admin' ? '#3B82F6' : '#ffb703';
  return (
    <>
      <span className="sp-badge" style={{ borderColor: c + '66', color: c }}>{sk ? t(sk[0], null, sk[1]) : tk.status}</span>
      {wf && wf !== 'none' && (
        <span className="sp-badge" style={{ borderColor: wc + '66', color: wc }}>
          {wf === 'admin' ? t('pages.support.status.awaiting_support', null, 'در انتظار پشتیبانی') : t('pages.support.status.awaiting_your_reply', null, 'در انتظار پاسخ شما')}
        </span>
      )}
      {Number(tk.unread_user_count || 0) > 0 && <span className="sp-badge unread">{t('pages.support.badge.unread', null, 'خوانده‌نشده')}</span>}
    </>
  );
}

/** Support desk: KPI cards, new-ticket form, open/closed lists, and a ticket thread view. */
export function SupportDesk({ initialTicketId }: { initialTicketId?: number }) {
  const { t, errorMessage } = useI18n();
  const toast = useToast();
  const desk = useSupportTickets();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { openTicket } = desk;
  useEffect(() => { if (initialTicketId) void openTicket(initialTicketId); }, [initialTicketId, openTicket]);
  const loadFailed = t('pages.support.err.load_failed', null, 'خطا در بارگذاری؛ دوباره تلاش کنید.');

  const submit = async () => {
    const s = subject.trim(), b = body.trim();
    if (!s || !b) { setFormErr(t('pages.support.err.subject_and_message_required', null, 'موضوع و پیام الزامی است.')); return; }
    setFormErr(null); setBusy(true);
    try { await desk.create(s, b); setSubject(''); setBody(''); toast.show(t('pages.support.toast.ticket_created', null, 'تیکت شما ثبت شد.')); }
    catch (e) { setFormErr(errorMessage(e, 'pages.support.err.load_failed')); }
    finally { setBusy(false); }
  };
  const sendReply = async () => {
    const b = reply.trim(); if (!b) return;
    setBusy(true);
    try { await desk.reply(b); setReply(''); toast.show(t('pages.support.toast.reply_sent', null, 'پاسخ ارسال شد.')); }
    catch (e) { window.alert(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const reopen = async () => {
    try { await desk.reopen(); toast.show(t('pages.support.toast.ticket_reopened', null, 'تیکت بازگشایی شد و منتظر بررسی پشتیبانی است.')); }
    catch (e) { window.alert(errorMessage(e)); }
  };

  const row = (tk: TicketSummary) => (
    <div key={tk.id} role="button" tabIndex={0} className={'sp-row' + (Number(tk.unread_user_count || 0) > 0 ? ' unread' : '')}
      onClick={() => void desk.openTicket(tk.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void desk.openTicket(tk.id); } }}>
      <div className="sp-row-head">
        <b>#{tk.id} — {tk.subject || ''}</b>
        <Badges t={tk} />
        <span className="sp-row-time" dir="ltr">{tk.last_message_at || ''}</span>
      </div>
    </div>
  );

  const th = desk.thread;
  return (
    <>
      <section className="grid">
        <div className="card"><small>{t('pages.support.open.tickets.3a2abcb4', null, 'تیکت‌های باز')}</small><b style={{ color: '#fce38a' }}>{desk.open.length}</b></div>
        <div className="card"><small>{t('pages.support.badge.unread', null, 'خوانده‌نشده')}</small><b style={{ color: '#4CD39A' }}>{desk.unread}</b></div>
        <div className="card"><small>{t('pages.support.kpi.closed_tickets', null, 'بسته‌شده')}</small><b style={{ color: '#3B82F6' }}>{desk.closed.length}</b></div>
      </section>

      {!th && (
        <>
          <section className="card panel" style={{ marginTop: 16 }}>
            <b className="sp-section-title">{t('pages.support.title.new_ticket', null, 'تیکت جدید')}</b>
            <div className="sp-form">
              <label><span>{t('pages.support.label.subject', null, 'موضوع')}</span>
                <input className="sp-input" dir="auto" maxLength={200} type="text" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
              <label><span>{t('pages.support.label.message', null, 'پیام')}</span>
                <textarea className="sp-input" dir="auto" maxLength={5000} rows={5} value={body} onChange={(e) => setBody(e.target.value)} /></label>
              <div className="sp-actions">
                <button type="button" className="sp-btn-gold" disabled={busy} onClick={() => void submit()}>{t('pages.support.action.submit_ticket', null, 'ارسال تیکت')}</button>
              </div>
              {formErr && <div className="sp-err">{formErr}</div>}
            </div>
          </section>
          <section className="card panel" style={{ marginTop: 16 }}>
            <b className="sp-section-title">{t('pages.support.kpi.open_tickets', null, 'تیکت‌های باز')}</b>
            <div className="sp-list">{desk.open.length ? desk.open.map(row) : <div className="sp-empty">{t('pages.support.empty.no_open', null, 'هنوز تیکت بازی ندارید. از دکمه «تیکت جدید» استفاده کنید.')}</div>}</div>
            <b className="sp-section-title closed">{t('pages.support.kpi.closed_tickets', null, 'تیکت‌های بسته‌شده')}</b>
            <div className="sp-list">{desk.closed.length ? desk.closed.map(row) : <div className="sp-empty">{t('pages.support.empty.no_closed', null, 'تیکت بسته‌شده‌ای وجود ندارد.')}</div>}</div>
            {desk.loadError ? <div className="sp-err list">{loadFailed}</div> : null}
          </section>
        </>
      )}

      {th && (
        <section className="card panel" style={{ marginTop: 16 }}>
          <div className="sp-thread-head">
            <button type="button" className="sp-btn-ghost" onClick={desk.closeThread}>{t('pages.support.action.back', null, 'بازگشت')}</button>
            <b className="sp-thread-subject">#{th.conversation.id} — {th.conversation.subject || ''}</b>
            <Badges t={th.conversation} />
            {isClosed(th.conversation.status) && <button type="button" className="sp-btn-gold sm" onClick={() => void reopen()}>{t('pages.support.action.reopen_ticket', null, 'بازگشایی تیکت')}</button>}
          </div>
          <div className="sp-msgs">
            {(th.messages || []).map((m, i) => {
              const mine = m.sender_type === 'user';
              const who = mine ? t('pages.support.role.you', null, 'شما') : m.sender_type === 'admin' ? t('pages.support.role.support_agent', null, 'پشتیبانی') : t('pages.support.label.ticket', null, 'تیکت');
              return (
                <div key={m.id ?? i} className={'sp-msg' + (mine ? ' mine' : '')}>
                  <div className="sp-msg-head"><b>{who}</b><span dir="ltr">{m.created_at || ''}</span></div>
                  <div className="sp-msg-body">{m.body}</div>
                </div>
              );
            })}
          </div>
          {!isClosed(th.conversation.status) && (
            <div className="sp-reply">
              <textarea className="sp-input" dir="auto" maxLength={5000} rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('pages.support.ph.write_reply', null, '')} />
              <button type="button" className="sp-btn-gold reply" disabled={busy} onClick={() => void sendReply()}>{t('pages.support.action.send_reply', null, 'ارسال پاسخ')}</button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
