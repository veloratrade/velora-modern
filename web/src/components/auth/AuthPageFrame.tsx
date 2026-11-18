'use client';
/* Legacy login/register page chrome: gradient defs, .bg, .noise, .shell (brand panel + card). */
import React from 'react';
import { LogoGradientDefs } from '@/components/brand/LogoMark';
import { LocaleSwitcher } from '@/components/i18n/LocaleSwitcher';

export function AuthPageFrame({ page, children }: { page: 'login' | 'register'; children: React.ReactNode }) {
  return (
    <div className={`pg-${page}`}>
      <LogoGradientDefs />
      <div className="bg" />
      <div className="noise" />
      <div className="shell">{children}</div>
      <LocaleSwitcher placement="dock" />
    </div>
  );
}
