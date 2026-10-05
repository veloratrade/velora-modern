
"use client";
import React, { useCallback, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { createTranslator } from "../../i18n/catalog";
import type { Locale } from "../../contracts/locale";
import "./shell.css";

export function AppShell({ children, topRight }: { children: React.ReactNode; topRight?: React.ReactNode }) {
  const pathname = usePathname() || "";
  const locale: Locale = pathname.startsWith("/en") ? "en" : "fa";
  const t = createTranslator(locale, ["common"]);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      <div className="app-shell">
        <Sidebar open={open} onClose={close} />
        {/* The overlay is the tap-anywhere-to-dismiss target on mobile; its label is the
            catalog's `common.close` (Legacy public/locales @edede31), not a literal. */}
        {open ? <button className="app-overlay" aria-label={t("common.close", null, "بستن")} onClick={close} /> : null}
        <main className="app-main">
          <TopBar onToggleSidebar={toggle} right={topRight} />
          <div className="app-content">{children}</div>
        </main>
      </div>
    </>
  );
}
