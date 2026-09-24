"use client";
import React, { forwardRef, useState } from "react";

type Props = React.InputHTMLAttributes<HTMLInputElement> & {
  toggleLabel: string;
  icon: React.ReactNode;
  wrapClass?: string;
  toggleClass?: string;
  children?: React.ReactNode;
};

export const PasswordField = forwardRef<HTMLInputElement, Props>(function PasswordField(
  { toggleLabel, icon, wrapClass = "input-wrap", toggleClass = "toggle", children, ...rest },
  ref,
) {
  const [show, setShow] = useState(false);
  return (
    <div className={wrapClass}>
      {children}
      <input ref={ref} {...rest} type={show ? "text" : "password"} />
      <button aria-label={toggleLabel} className={toggleClass} type="button" onClick={() => setShow((v) => !v)}>
        {icon}
      </button>
    </div>
  );
});
