'use client';
/* Port of legacy `#veloraToast` behaviour: single toast, 2.6s auto-hide, ok/err variants. */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';

type Kind = 'ok' | 'err' | '';
interface ToastApi {
  show: (message: string, kind?: Kind) => void;
}
const Ctx = createContext<ToastApi>({ show: () => undefined });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState('');
  const [kind, setKind] = useState<Kind>('');
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | null>(null);
  const show = useCallback((message: string, k: Kind = '') => {
    setMsg(message);
    setKind(k);
    setVisible(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), 2600);
  }, []);
  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div className={`velora-toast${visible ? ' show' : ''}${kind ? ` ${kind}` : ''}`} id="veloraToast" role="status" aria-live="polite">
        {msg}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(Ctx);
}
