"use client";
/*
 * App group session gate — the contract decides, not the Legacy habit.
 *
 * PUBLIC_APP_PATHS are listed as public (route classes A/B/C) in the frozen
 * PUBLIC_ROUTES contract (locale.ts / ADR-009 C-03). They render the app shell
 * WITHOUT a session requirement so the proxy's `Cache-Control: public` for
 * those routes never sits in front of auth-gated HTML.
 *
 * R8 (owner decision) may later amend the contract to protect these routes —
 * that is a contract change, not a frontend change: one line here flips them
 * back behind RequireSession.
 *
 * Every other app route (dashboard, accounts, trades, analytics, profile,
 * admin, wallet, performance, intelligence) stays authenticated.
 */
import React, { useEffect } from "react";
import { usePathname } from "next/navigation";
import { RequireSession } from "./session";

/** Paths (without /en prefix) whose contract class is public. */
const PUBLIC_APP_PATHS: ReadonlySet<string> = new Set(["/markets", "/news", "/support"]);

function stripLocale(pathname: string): string {
  return pathname === "/en" ? "/" : pathname.startsWith("/en/") ? pathname.slice(3) : pathname;
}

export function AppSessionGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const bare = stripLocale(pathname).replace(/\/+$/, "") || "/";
  const isPublic = PUBLIC_APP_PATHS.has(bare);
  if (isPublic) return <>{children}</>;
  return <RequireSession>{children}</RequireSession>;
}
