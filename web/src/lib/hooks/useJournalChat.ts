'use client';
import { useCallback, useState } from 'react';

export type ChatMessage =
  | { role: 'user'; text: string; seed?: true }   // seed = legacy sample question (localized at render)
  | { role: 'ai'; kind: 'seed' }            // the legacy sample analysis (with evidence block)
  | { role: 'ai'; kind: 'pending' };        // placeholder answer — no AI Q&A endpoint exists yet (gap G4)

/**
 * Journal Q&A transcript. Legacy behaviour: each sent question appends a user bubble and an
 * immediate canned "answer will be computed" bubble; there is no server round-trip to preserve.
 */
export function useJournalChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'user', text: '', seed: true }, { role: 'ai', kind: 'seed' }]);
  const [draft, setDraft] = useState('');
  const send = useCallback((text?: string) => {
    const q = (text ?? draft).trim();
    if (!q) return false;
    setMessages((m) => [...m, { role: 'user', text: q }, { role: 'ai', kind: 'pending' }]);
    setDraft('');
    return true;
  }, [draft]);
  return { messages, draft, setDraft, send };
}
