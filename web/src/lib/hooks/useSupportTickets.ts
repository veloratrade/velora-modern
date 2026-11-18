'use client';
import { useCallback, useState } from 'react';
import { request } from '@/lib/api/client';
import { useApiResource } from './useApiResource';

/* Support-desk contract as consumed by the legacy page (GET/POST /support/tickets, GET :id,
 * POST :id/messages, POST :id/reopen). The modern `support` module is still a scaffold — gap G8. */
export type TicketStatus = 'open' | 'pending' | 'closed' | 'archived';
export interface TicketSummary {
  id: number; subject: string; status: TicketStatus; waiting_for?: 'admin' | 'user' | 'none';
  unread_user_count?: number; last_message_at?: string;
}
export interface TicketMessage { id?: number; sender_type: 'user' | 'admin' | string; body: string; created_at?: string }
export interface TicketThread { conversation: TicketSummary; messages: TicketMessage[] }

export const isClosed = (s: TicketStatus) => s === 'closed' || s === 'archived';

export function useSupportTickets() {
  const list = useApiResource<{ tickets?: TicketSummary[]; unread_total?: number }, { tickets: TicketSummary[]; unreadTotal: number | null }>(
    '/api/v1/support/tickets',
    (d) => ({ tickets: d.tickets || [], unreadTotal: typeof d.unread_total === 'number' ? d.unread_total : null }),
  );
  const [thread, setThread] = useState<TicketThread | null>(null);

  const tickets = list.data?.tickets || [];
  const open = tickets.filter((t) => !isClosed(t.status));
  const closed = tickets.filter((t) => isClosed(t.status));
  const unread = list.data?.unreadTotal ?? tickets.reduce((n, t) => n + Number(t.unread_user_count || 0), 0);

  const openTicket = useCallback(async (id: number) => {
    try { setThread(await request<TicketThread>('/api/v1/support/tickets/' + encodeURIComponent(id))); return true; }
    catch { setThread(null); return false; }
  }, []);
  const closeThread = useCallback(() => { setThread(null); void list.reload(); }, [list]);
  const create = useCallback(async (subject: string, message: string) => {
    await request('/api/v1/support/tickets', { method: 'POST', body: { subject, message } });
    await list.reload();
  }, [list]);
  const reply = useCallback(async (message: string) => {
    if (!thread) return;
    const id = thread.conversation.id;
    await request('/api/v1/support/tickets/' + encodeURIComponent(id) + '/messages', { method: 'POST', body: { message } });
    await openTicket(id); void list.reload();
  }, [thread, openTicket, list]);
  const reopen = useCallback(async () => {
    if (!thread) return;
    const id = thread.conversation.id;
    await request('/api/v1/support/tickets/' + encodeURIComponent(id) + '/reopen', { method: 'POST' });
    await openTicket(id); void list.reload();
  }, [thread, openTicket, list]);

  return { loading: list.loading, loadError: list.error, open, closed, unread, thread, openTicket, closeThread, create, reply, reopen };
}
