
import React from "react";
import { AppShell } from "../../components/layout/AppShell";
import { AppSessionGate } from "../../lib/auth/AppSessionGate";
import "./app.css";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppSessionGate>
      <AppShell>{children}</AppShell>
    </AppSessionGate>
  );
}
