'use client';
import React from 'react';
import { RequireSession } from '@/components/auth/RequireSession';

export default function AppGroupLayout({ children }: { children: React.ReactNode }) {
  return <RequireSession>{children}</RequireSession>;
}
