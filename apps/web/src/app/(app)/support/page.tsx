"use client";
// Support Center — Phase 5. Legacy's `/support` ticket center, migrated by
// capability (source: `veloratrade/veloratrade @edede31 support/index.html`
// lines 522-671 + `api/src/Support/*`), on the Modern design system.
//
// WHAT LEGACY'S SCREEN DID, AND WHAT THIS ONE DOES:
//   * three KPIs — open, unread, closed — driven by the list response;
//   * a "New ticket" form (subject ≤ 200, message ≤ 5000) that returns to the
//     list on success and shows the failure inline, never an alert();
//   * the list split into OPEN (open|pending) and CLOSED (closed|archived), each
//     row carrying `#id — subject`, the status badge, the whose-turn badge, an
//     unread marker and the last-message timestamp;
//   * a thread view with `?ticket=<id>` deep linking, role-labelled bubbles
//     (You / Support), the reopen button for a closed ticket and the reply box
//     HIDDEN while the ticket is closed;
//   * the toasts and empty/error copy Legacy already had words for.
//
// WHAT IS DELIBERATELY DIFFERENT:
//   * the copy comes from the `support` catalog chunk in BOTH locales. Legacy's
//     own fa/en catalogs already carried this screen's strings (v1.8 support UI),
//     so 34 of the 38 keys are byte copies from `public/locales/{fa,en}.json`;
//     the four `support.*` keys are authored because Legacy had no words for
//     them (page subtitle, two client-side field hints, capability-absent).
//   * API failures render through the catalog by ERROR CODE (Legacy printed the
//     server's English message), and Persian digits never appear because every
//     number goes through `fmtNumber`/`fmtDateLong` (v-latn-num rule).
//   * Legacy wrote inline styles per element; this page uses the canonical
//     classes (`page-head`, `card`, `kpi`, `btn-primary`, `input`, `badge`, …)
//     so it cannot drift from the rest of the app.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  createSupportTicket,
  getSupportTicket,
  listSupportTickets,
  reopenSupportTicket,
  replySupportTicket,
  type SupportMessageView,
  type SupportStatus,
  type SupportTicketView,
  type SupportThreadView,
} from "../../../lib/api/resources";
import { ApiError } from "../../../lib/api/client";
import type { Locale } from "../../../contracts/locale";
import { createTranslator } from "../../../i18n/catalog";
import { fmtDateLong, fmtNumber } from "../../../i18n/format";

/**
 * The route's locale, read from the ROUTER — not from `window.location`.
 *
 * This is the shell's own rule (`AppShell`/`Sidebar`/`TopBar` all use
 * `usePathname()`): the server already knows the path, so both renders agree.
 * Reading `window.location.pathname` during render made the SERVER paint Persian
 * and the client repaint English on `/en/support`, which React reports as a
 * hydration error (#418, reproduced in the Phase 5 visual QA run) — and after
 * hydration a reader briefly sees the wrong language.
 */
function useLocale(): Locale {
  const pathname = usePathname();
  return pathname !== null && pathname.startsWith("/en") ? "en" : "fa";
}

export default function SupportPage() {
  const locale = useLocale();
  const t = createTranslator(locale, ["common", "errors", "support"]);
  const [tickets, setTickets] = useState<SupportTicketView[]>([]);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [thread, setThread] = useState<SupportThreadView | null>(null);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [toast, setToast] = useState("");

  /** API error → catalog. Keyed on the Modern error codes the support routes emit. */
  const errorText = useCallback(
    (err: unknown, fallbackKey: string): string => {
      if (err instanceof ApiError) {
        if (err.code === "SUPPORT_SUBJECT_INVALID") return t("errors.support.subjectInvalid", null, err.message);
        if (err.code === "SUPPORT_MESSAGE_INVALID") return t("errors.support.messageInvalid", null, err.message);
        if (err.code === "SUPPORT_TICKET_CLOSED") return t("errors.support.ticketClosed", null, err.message);
        if (err.code === "SUPPORT_INVALID_TRANSITION") return t("errors.support.invalidTransition", null, err.message);
        if (err.code === "SUPPORT_INVALID_ACTION") return t("errors.support.invalidAction", null, err.message);
        if (err.code === "SUPPORT_STATE_CONFLICT") return t("errors.support.invalidTransition", null, err.message);
        if (err.code === "SERVICE_UNAVAILABLE") return t("support.notAvailable", null, err.message);
        if (err.code === "TOO_MANY_REQUESTS") return t("errors.rateLimited", null, err.message);
        if (err.code === "UNAUTHENTICATED") return t("errors.unauthorized", null, err.message);
        return err.message;
      }
      return t(fallbackKey);
    },
    [t],
  );

  const load = useCallback(async () => {
    try {
      const data = await listSupportTickets();
      setTickets(data.tickets);
      setUnreadTotal(data.unreadTotal);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const openTicket = useCallback(
    async (id: string) => {
      try {
        const view = await getSupportTicket(id);
        setThread(view);
        setReply("");
        // The server clears the unread marker on read, so refresh the badges.
        void load();
      } catch {
        setThread(null);
        setLoadFailed(true);
      }
    },
    [load],
  );

  useEffect(() => {
    void load();
    // Deep link (Legacy: `?ticket=<id>`), read from the URL so a notification can
    // land the user directly in the thread.
    const id = new URLSearchParams(window.location.search).get("ticket");
    if (id !== null && id !== "") void openTicket(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = useMemo(() => tickets.filter((x) => x.status === "open" || x.status === "pending"), [tickets]);
  const closed = useMemo(() => tickets.filter((x) => x.status === "closed" || x.status === "archived"), [tickets]);

  const statusLabel = useCallback(
    (status: SupportStatus): string => {
      switch (status) {
        case "open":
          return t("pages.support.status.open", null, "Open");
        case "pending":
          // Legacy labelled `pending` from the CLIENT's point of view: it means
          // the ball is in the user's court.
          return t("pages.support.status.awaiting_your_reply", null, "Awaiting your reply");
        case "closed":
          return t("pages.support.status.closed", null, "Closed");
        default:
          return t("pages.support.status.archived", null, "Archived");
      }
    },
    [t],
  );

  const statusClass = (status: SupportStatus): string =>
    status === "open" ? "badge badge-connected" : status === "pending" ? "badge" : "badge badge-disconnected";

  const waitingLabel = useCallback(
    (waiting: SupportTicketView["waitingFor"]): string =>
      waiting === "admin"
        ? t("pages.support.status.awaiting_support", null, "Awaiting support")
        : waiting === "user"
          ? t("pages.support.status.awaiting_your_reply", null, "Awaiting your reply")
          : "",
    [t],
  );

  async function submitTicket(): Promise<void> {
    setFormError("");
    if (subject.trim() === "") {
      setFormError(t("support.subjectRequired"));
      return;
    }
    if (message.trim() === "") {
      setFormError(t("pages.support.err.subject_and_message_required", null, "Subject and message are required."));
      return;
    }
    setBusy(true);
    try {
      await createSupportTicket({ subject: subject.trim(), message: message.trim() });
      setSubject("");
      setMessage("");
      setToast(t("pages.support.toast.ticket_created", null, "Your ticket has been created."));
      await load();
    } catch (err) {
      setFormError(errorText(err, "errors.api"));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(): Promise<void> {
    if (thread === null) return;
    if (reply.trim() === "") {
      setFormError(t("support.replyRequired"));
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      await replySupportTicket(thread.conversation.id, reply.trim());
      setReply("");
      setToast(t("pages.support.toast.reply_sent", null, "Reply sent."));
      await openTicket(thread.conversation.id);
    } catch (err) {
      setFormError(errorText(err, "errors.api"));
    } finally {
      setBusy(false);
    }
  }

  async function reopen(): Promise<void> {
    if (thread === null) return;
    setBusy(true);
    setFormError("");
    try {
      await reopenSupportTicket(thread.conversation.id);
      setToast(t("pages.support.toast.ticket_reopened", null, "Ticket reopened; support will review it."));
      await openTicket(thread.conversation.id);
    } catch (err) {
      setFormError(errorText(err, "errors.api"));
    } finally {
      setBusy(false);
    }
  }

  const row = (ticket: SupportTicketView) => {
    const unread = ticket.unreadUserCount > 0;
    return (
      <div
        key={ticket.id}
        role="button"
        tabIndex={0}
        className="card-alt clickable"
        onClick={() => void openTicket(ticket.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void openTicket(ticket.id);
          }
        }}
      >
        <div className="flex-wrap flex-gap-8">
          <b className="text-gold">
            #{ticket.id} — {ticket.subject}
          </b>
          <span className={statusClass(ticket.status)}>{statusLabel(ticket.status)}</span>
          {ticket.waitingFor === "none" ? null : <span className="badge">{waitingLabel(ticket.waitingFor)}</span>}
          {unread ? <span className="badge badge-error">{t("pages.support.badge.unread", null, "Unread")}</span> : null}
          <span className="muted-xs ts-mixed ms-auto">
            {fmtDateLong(locale, ticket.lastMessageAt, { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </div>
      </div>
    );
  };

  const bubble = (m: SupportMessageView) => {
    const mine = m.senderType === "user";
    const who = mine
      ? t("pages.support.role.you", null, "You")
      : m.senderType === "admin"
        ? t("pages.support.role.support_agent", null, "Support")
        : t("pages.support.label.ticket", null, "Ticket");
    return (
      <div key={m.id} className={mine ? "bubble bubble-mine" : "bubble bubble-support"}>
        <div className="flex-wrap flex-gap-8">
          <b className={mine ? "role-mine text-12" : "role-support text-12"}>
            {who}
          </b>
          <span className="muted-xs ts-mixed">
            {fmtDateLong(locale, m.createdAt, { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </div>
        <p className="thread-msg">
          {m.body}
        </p>
      </div>
    );
  };

  const isClosed = thread !== null && (thread.conversation.status === "closed" || thread.conversation.status === "archived");

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("pages.support.label.support_center", null, "Support Center")}</h1>
          <p className="page-sub">{t("support.pageSub")}</p>
        </div>
        {thread !== null ? (
          <button className="btn-ghost btn-sm" type="button" onClick={() => setThread(null)}>
            {t("pages.support.action.back", null, "Back")}
          </button>
        ) : null}
      </div>

      {toast === "" ? null : (
        <div className="card mb-12" role="status">
          <span className="muted-sm">{toast}</span>
        </div>
      )}

      {/* KPIs — Legacy's three cards (open / unread / closed). */}
      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">{t("pages.support.open.tickets.3a2abcb4", null, "Open Tickets")}</div>
          <div className="kpi-value v-latn-num kpi-gold">{fmtNumber(locale, open.length)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t("pages.support.badge.unread", null, "Unread")}</div>
          <div className="kpi-value v-latn-num kpi-green">{fmtNumber(locale, unreadTotal)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t("pages.support.kpi.closed_tickets", null, "Closed tickets")}</div>
          <div className="kpi-value v-latn-num kpi-blue">{fmtNumber(locale, closed.length)}</div>
        </div>
      </div>

      {loadFailed ? (
        <div className="error-card mt-16" role="alert">
          <span className="muted-sm">{t("pages.support.err.load_failed", null, "Load failed; please retry.")}</span>
        </div>
      ) : null}

      {thread === null ? (
        <>
          <div className="card mt-16">
            <h3 className="label text-gold">{t("pages.support.title.new_ticket", null, "New ticket")}</h3>
            <div className="grid-gap-8 mt-12">
              <label className="muted-sm grid-gap-8" htmlFor="sup-subject">
                <span>{t("pages.support.label.subject", null, "Subject")}</span>
                <input
                  id="sup-subject"
                  className="input"
                  type="text"
                  dir="auto"
                  maxLength={200}
                  placeholder={t("pages.support.ph.subject", null, "Enter the ticket subject")}
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </label>
              <label className="muted-sm grid-gap-8" htmlFor="sup-message">
                <span>{t("pages.support.label.message", null, "Message")}</span>
                <textarea
                  id="sup-message"
                  className="input"
                  dir="auto"
                  rows={5}
                  maxLength={5000}
                  placeholder={t("pages.support.ph.describe_issue", null, "Describe your issue…")}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              <div className="flex-wrap flex-gap-8">
                <button className="btn-primary" type="button" disabled={busy} onClick={() => void submitTicket()}>
                  {busy ? t("common.loading") : t("pages.support.action.submit_ticket", null, "Submit ticket")}
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSubject("");
                    setMessage("");
                    setFormError("");
                  }}
                >
                  {t("pages.support.action.clear_form", null, "Clear form")}
                </button>
              </div>
              {formError === "" ? null : (
                <div className="text-error text-12 mt-4" role="alert">
                  {formError}
                </div>
              )}
            </div>
          </div>

          <div className="card mt-16">
            <h3 className="label text-gold">{t("pages.support.kpi.open_tickets", null, "Open tickets")}</h3>
            <div className="grid-gap-8 mt-12">
              {loading ? (
                <span className="muted-sm">{t("common.loading")}</span>
              ) : open.length === 0 ? (
                <span className="muted-sm">{t("pages.support.empty.no_open", null, "You have no open tickets yet. Use “New ticket”.")}</span>
              ) : (
                open.map(row)
              )}
            </div>

            <h3 className="label text-gold mt-16">{t("pages.support.kpi.closed_tickets", null, "Closed tickets")}</h3>
            <div className="grid-gap-8 mt-12">
              {loading ? (
                <span className="muted-sm">{t("common.loading")}</span>
              ) : closed.length === 0 ? (
                <span className="muted-sm">{t("pages.support.empty.no_closed", null, "No closed tickets.")}</span>
              ) : (
                closed.map(row)
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="card mt-16">
          <div className="flex-wrap flex-gap-8">
            <b className="text-gold">
              #{thread.conversation.id} — {thread.conversation.subject}
            </b>
            <span className={statusClass(thread.conversation.status)}>{statusLabel(thread.conversation.status)}</span>
            {thread.conversation.waitingFor === "none" ? null : (
              <span className="badge">{waitingLabel(thread.conversation.waitingFor)}</span>
            )}
            <span className="muted-xs ts-mixed">
              {t("pages.support.label.created", null, "Created")}:{" "}
              {fmtDateLong(locale, thread.conversation.createdAt, { dateStyle: "medium" })}
            </span>
            {isClosed ? (
              <button className="btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void reopen()}>
                {t("pages.support.action.reopen_ticket", null, "Reopen ticket")}
              </button>
            ) : null}
          </div>

          <div className="grid-gap-8 mt-16">
            {thread.messages.length === 0 ? (
              <span className="muted-sm">{t("pages.support.empty.no_open", null, "You have no open tickets yet. Use “New ticket”.")}</span>
            ) : (
              thread.messages.map(bubble)
            )}
          </div>

          {isClosed ? null : (
            <div className="grid-gap-8 mt-16">
              <label className="muted-sm grid-gap-8" htmlFor="sup-reply">
                <span>{t("pages.support.label.message", null, "Message")}</span>
                <textarea
                  id="sup-reply"
                  className="input"
                  dir="auto"
                  rows={4}
                  maxLength={5000}
                  placeholder={t("pages.support.ph.write_reply", null, "Write your reply…")}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
              </label>
              <div>
                <button className="btn-primary" type="button" disabled={busy} onClick={() => void sendReply()}>
                  {busy ? t("common.loading") : t("pages.support.action.send_reply", null, "Send reply")}
                </button>
              </div>
            </div>
          )}

          {formError === "" ? null : (
            <div className="text-error text-12 mt-12" role="alert">
              {formError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
