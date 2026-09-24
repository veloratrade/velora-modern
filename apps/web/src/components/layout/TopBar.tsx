
"use client";
import React from "react";
import { usePathname } from "next/navigation";
import type { Locale } from "../../contracts/locale";

export function TopBar({ onToggleSidebar, right }: { onToggleSidebar: () => void; right?: React.ReactNode }) {
  const pathname = typeof window !== "undefined" ? window.location.pathname : "";
  // Use a simple locale detection for the toggle label
  const isFa = !pathname.startsWith("/en");
  return (
    <div className="app-topbar">
      <div className="tb-left">
        <button aria-label={isFa ? "منو" : "Menu"} className="tb-toggle" onClick={onToggleSidebar} type="button">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>
      <div className="tb-right">
        <a className="tb-locale" href={isFa ? "/en" + pathname : pathname.replace(/^\/en/, "") || "/"}>
          {isFa ? "EN" : "فا"}
        </a>
        {right}
      </div>
    </div>
  );
}
