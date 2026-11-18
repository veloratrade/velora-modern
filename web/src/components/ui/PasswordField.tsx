'use client';
import React, { forwardRef, useState } from 'react';

type Props = React.InputHTMLAttributes<HTMLInputElement> & {
  toggleLabel: string; icon: React.ReactNode; wrapClass?: string; toggleClass?: string;
  /** Leading adornment (e.g. lock icon) rendered before the input, as in the legacy markup. */
  children?: React.ReactNode;
};
/** Password input with the legacy show/hide toggle (`.input-wrap > input + button.toggle`). */
export const PasswordField = forwardRef<HTMLInputElement, Props>(function PasswordField(
  { toggleLabel, icon, wrapClass = 'input-wrap', toggleClass = 'toggle', children, ...rest }, ref,
) {
  const [show, setShow] = useState(false);
  return (
    <div className={wrapClass}>
      {children}
      <input ref={ref} {...rest} type={show ? 'text' : 'password'} />
      <button aria-label={toggleLabel} className={toggleClass} id="togglePass" type="button" onClick={() => setShow((v) => !v)}>{icon}</button>
    </div>
  );
});
