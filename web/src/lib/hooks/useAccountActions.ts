'use client';
import { useCallback, useState } from 'react';
import { request } from '@/lib/api/client';

export interface ConnectInput { login: string; investorPassword: string; server?: string; provider?: string; label: string; broker?: string }

/**
 * Broker-account operations (MetaApi cloud bridge). Endpoints are the ones the
 * legacy UI calls; `connect-metaapi` / `sync-status` are integration gaps (G1/G3)
 * in the modern API and are documented in the migration map.
 */
export function useAccountActions() {
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const connect = useCallback((input: ConnectInput) => request<{ account?: { id: number } }>('/api/v1/accounts/connect-metaapi', {
    method: 'POST',
    body: { mt_login: input.login, investorPassword: input.investorPassword, server: input.server || '', provider: input.provider || 'MT4', label: input.label, ...(input.broker ? { broker: input.broker } : {}) },
  }), []);
  const sync = useCallback(async (id: number) => {
    setSyncingId(id);
    try { await request('/api/v1/accounts/' + id + '/sync', { method: 'POST' }); }
    finally { setSyncingId(null); }
  }, []);
  const syncStatus = useCallback((id: number) => request<{ syncStatus?: string; lastSyncedAt?: string; recentJobs?: unknown[] }>('/api/v1/accounts/' + id + '/sync-status'), []);
  const remove = useCallback((id: number) => request('/api/v1/accounts/' + encodeURIComponent(id), { method: 'DELETE' }), []);
  const detectServer = useCallback((login: string) => request<{ suggestedServers?: string[] }>('/api/v1/accounts/detect-server', { method: 'POST', body: { mt_login: login } }), []);
  return { connect, sync, syncStatus, remove, detectServer, syncingId };
}
