
"use client";
import React, { useCallback, useState } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import "./shell.css";

export function AppShell({ children, topRight }: { children: React.ReactNode; topRight?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      <div className="app-shell">
        <Sidebar open={open} onClose={close} />
        {open ? <button className="app-overlay" aria-label="Close menu" onClick={close} /> : null}
        <main className="app-main">
          <TopBar onToggleSidebar={toggle} right={topRight} />
          <div className="app-content">{children}</div>
        </main>
      </div>
    </>
  );
}
