'use client';
import React, { useState } from 'react';
/** Password input with the legacy show/hide toggle; `icon` is the page-specific eye glyph. */
export function PasswordField(props: React.InputHTMLAttributes<HTMLInputElement> & { toggleLabel: string; icon: React.ReactNode; wrapClass?: string; toggleClass?: string }) {
  const { toggleLabel, icon, wrapClass = 'input-wrap', toggleClass = 'toggle', children: _c, ...rest } = props; void _c;
  const [show, setShow] = useState(false);
  return (
    <div className={wrapClass}>
      {props.children}
      <input {...rest} type={show ? 'text' : 'password'} />
      <button aria-label={toggleLabel} className={toggleClass} type="button" onClick={() => setShow((v) => !v)}>{icon}</button>
    </div>
  );
}
