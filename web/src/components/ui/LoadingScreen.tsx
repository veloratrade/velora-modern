'use client';
/* Port of legacy `#loading.loading-screen` (gold ring spinner + caption). */
import React from 'react';

export function LoadingScreen({ text, hide }: { text: string; hide?: boolean }) {
  return (
    <div className={`loading-screen${hide ? ' hide' : ''}`} id="loading" aria-hidden={hide ? 'true' : undefined}>
      <div className="ls-logo" />
      <p>{text}</p>
    </div>
  );
}
