'use client';
/* Port of legacy `velora-dialog.js` — glass confirmation layer. Imperative API preserved. */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface Options {
  title?: string;
  confirm?: string;
  cancel?: string;
}

function Dialog({ message, options, onDone }: { message: string; options: Options; onDone: (v: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="velora-dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onDone(false)}>
      <div className="velora-dialog" role="dialog" aria-modal="true" aria-labelledby="veloraDialogTitle">
        <div className="velora-dialog-icon">
          <svg viewBox="0 0 24 24">
            <path d="M12 8v5m0 4h.01" />
            <path d="M10.3 3.7 2.9 17a3 3 0 0 0 2.6 4.5h13a3 3 0 0 0 2.6-4.5L13.7 3.7a2 2 0 0 0-3.4 0Z" />
          </svg>
        </div>
        <h2 id="veloraDialogTitle">{options.title}</h2>
        <p>{message}</p>
        <div className="velora-dialog-actions">
          <button className="velora-dialog-confirm" type="button" onClick={() => onDone(true)}>
            {options.confirm}
          </button>
          <button className="velora-dialog-cancel" type="button" ref={cancelRef} onClick={() => onDone(false)}>
            {options.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function confirmDialog(message: string, options: Options = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const fa = (document.documentElement.lang || 'fa').toLowerCase().startsWith('fa');
    const opts: Options = {
      title: options.title || (fa ? 'تأیید عملیات' : 'Confirm action'),
      cancel: options.cancel || (fa ? 'انصراف' : 'Cancel'),
      confirm: options.confirm || (fa ? 'تأیید' : 'Confirm'),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: boolean) => {
      root.unmount();
      host.remove();
      resolve(v);
    };
    root.render(<Dialog message={message} options={opts} onDone={done} />);
  });
}

/** Hook-friendly wrapper (unused state keeps eslint happy about client-only usage). */
export function useConfirm() {
  const [, setTick] = useState(0);
  return (message: string, options?: Options) => {
    setTick((n) => n + 1);
    return confirmDialog(message, options);
  };
}
