
"use client";
import React from "react";
import { usePathname } from "next/navigation";
import type { Locale } from "../../contracts/locale";
import { createTranslator } from "../../i18n/catalog";

export function TopBar({ onToggleSidebar, right }: { onToggleSidebar: () => void; right?: React.ReactNode }) {
  // `usePathname()` (not `window.location`) so the server render and the first
  // client render agree — reading `window` during render produced a different
  // toggle href on the server ("/en") than in the browser.
  const pathname = usePathname() || "";
  const isFa = !pathname.startsWith("/en");
  const locale: Locale = isFa ? "fa" : "en";
  const t = createTranslator(locale, ["common"]);
  // The toggle shows the language you would switch TO; a language's own name is
  // the same in every locale, so these two codes are deliberately not in the
  // catalogs (Legacy's registry names are `فارسی` / `English`; the compact
  // two-letter form is the shell's, and it is identical in fa and en).
  const targetLabel = isFa ? "EN" : "فا";
  return (
    <div className="app-topbar">
      <div className="tb-left">
        <button aria-label={t("common.menu.1f381a4e", null, isFa ? "منو" : "Menu")} className="tb-toggle" onClick={onToggleSidebar} type="button">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      </div>
      <div className="tb-right">
        <a className="tb-locale" href={isFa ? "/en" + pathname : pathname.replace(/^\/en/, "") || "/"}>
          {targetLabel}
        </a>
        {right}
      </div>
    </div>
  );
}
