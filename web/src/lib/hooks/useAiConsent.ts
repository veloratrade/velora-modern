'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request, type SessionUser } from '@/lib/api/client';

export type AiConsentState = 'loading' | 'on' | 'off' | 'saving' | 'unavailable';

/**
 * AI-processing consent (users.ai_consent). Server state is authoritative:
 * after every PATCH we re-read /auth/me and render what was actually persisted.
 */
export function useAiConsent(initial?: boolean | null) {
  const [state, setState] = useState<AiConsentState>(initial == null ? 'loading' : initial ? 'on' : 'off');
  const [saveFailed, setSaveFailed] = useState(false);
  const busy = useRef(false);

  const fromUser = (u?: SessionUser | null) => setState(u && typeof u.aiConsent === 'boolean' && u.aiConsent ? 'on' : 'off');

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true; setState('loading');
    try { fromUser((await request<{ user?: SessionUser }>('/api/v1/auth/me')).user); }
    catch { setState('unavailable'); }
    busy.current = false;
  }, []);

  const set = useCallback(async (next: boolean) => {
    setState('saving'); setSaveFailed(false);
    let failed = false;
    try { await request('/api/v1/auth/me/preferences', { method: 'PATCH', body: { ai_consent: next } }); } catch { failed = true; }
    try { fromUser((await request<{ user?: SessionUser }>('/api/v1/auth/me')).user); setSaveFailed(failed); }
    catch { setState('unavailable'); }
  }, []);

  useEffect(() => { if (initial != null) fromUser({ aiConsent: initial } as SessionUser); }, [initial]);

  /** Switch click semantics: retry while unknown, ignore while saving, otherwise toggle. */
  const toggle = useCallback(() => {
    if (state === 'saving') return;
    if (state === 'loading' || state === 'unavailable') { void refresh(); return; }
    void set(state !== 'on');
  }, [state, refresh, set]);

  return { state, enabled: state === 'on', saveFailed, toggle, set, refresh, markUnavailable: () => setState('unavailable') };
}
