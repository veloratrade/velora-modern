'use client';
/* Legacy `.shell` layout: aurora bg + sidebar + overlay + main(top bar + content). */
import React, { useCallback, useState } from 'react';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppShell({ children, topRight }: { children: React.ReactNode; topRight?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((o) => !o), []);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <div className="bgfx" />
      <div className="shell">
        <Sidebar open={open} onClose={close} />
        <main className="main">
          <TopBar onToggleSidebar={toggle} right={topRight} />
          {children}
        </main>
      </div>
    </>
  );
}
