/* Ported from legacy `velora-sidebar-icons.js` — "Gold Well" icon family B. */
import React from 'react';

export type SidebarIconKey =
  | 'dash'
  | 'mkt'
  | 'intel'
  | 'journal'
  | 'wallet'
  | 'perf'
  | 'news'
  | 'profile'
  | 'support'
  | 'admin';

const PATHS: Record<SidebarIconKey, React.ReactNode> = {
  dash: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.8" />
      <rect x="13" y="3" width="8" height="8" rx="1.8" />
      <rect x="3" y="13" width="8" height="8" rx="1.8" />
      <path d="M14.1 19.2 16.4 15.6l1.7 1.8L20.8 13" />
      <path d="M19.2 13h1.7v1.8" />
    </>
  ),
  mkt: (
    <>
      <path d="M5.2 16.6V8.4" />
      <path d="M4 11.2h2.4v5.4H4z" />
      <path d="M18.8 7.4v8.2" />
      <path d="M17.6 7.4h2.4v5.2h-2.4z" />
      <path d="M8.2 14.2c2.2-3.4 5.4-3.4 7.6 0" />
    </>
  ),
  intel: (
    <>
      <path d="M12 3.2 20 8v8L12 20.8 4 16V8L12 3.2Z" />
      <circle cx="12" cy="12" r="2.1" />
      <path d="M12 7.2v1.6M12 15.2v1.6M7.2 12h1.6M15.2 12h1.6" />
    </>
  ),
  journal: (
    <>
      <path d="M7.2 4.4h8.2a2 2 0 0 1 2 2v11.4l-2.1-1.3-2 1.3-2-1.3-2 1.3-2.1-1.3V6.4a2 2 0 0 1 2-2Z" />
      <path d="M9.2 9.2h5.8M9.2 12.2h4.2" />
      <path d="M16.4 4.4v3.6" />
    </>
  ),
  wallet: (
    <>
      <path d="M4.4 8.4h12.4a2.2 2.2 0 0 1 2.2 2.2v7.2a2 2 0 0 1-2 2H6.4A2 2 0 0 1 4.4 17.8V8.4Z" />
      <path d="M4.8 8.4 8.6 4.8h7.4l-2.2 3.6" />
      <circle cx="16.2" cy="14.2" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  perf: (
    <>
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4" />
      <path d="M6.2 15.6 9.4 12.2l2.2 1.8 6-6.4" />
      <path d="M6.2 18.2h11.6" />
    </>
  ),
  news: (
    <>
      <path d="M6.4 7.2h11.2v12.2H8.2A1.8 1.8 0 0 1 6.4 17.6V7.2Z" />
      <path d="M6.4 7.2 8.6 4.6h9.4v2.6" />
      <path d="M9.2 11h6.2M9.2 13.8h4.4" />
      <circle cx="16.4" cy="16.6" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  profile: (
    <>
      <path d="M12 3.1 19.2 7.2v8.4L12 20.9 4.8 15.6V7.2L12 3.1Z" />
      <circle cx="12" cy="10" r="2.05" />
      <path d="M8.1 16.4c.8-2 2.2-3 3.9-3s3.1 1 3.9 3" />
    </>
  ),
  support: (
    <>
      <path d="M8.2 9.4c0-2.2 1.7-4 3.8-4s3.8 1.8 3.8 4v2.4c0 .9-.7 1.6-1.6 1.6h-.6" />
      <path d="M8.2 11.8H6.8A1.6 1.6 0 0 0 5.2 13.4v1.2A1.6 1.6 0 0 0 6.8 16.2h1.4V11.8Z" />
      <path d="M15.8 16.6 17.4 19" />
      <path d="M12 18.8h.01" />
    </>
  ),
  admin: (
    <>
      <path d="M12 3.2 19.2 6.2v6.2c0 4.4-3 7.4-7.2 8.8C7.8 19.8 4.8 16.8 4.8 12.4V6.2L12 3.2Z" />
      <path d="M9.2 8.4 12 16.2 14.8 8.4" />
      <path d="M10.2 12.2h3.6" />
    </>
  ),
};

export function SidebarMark({ icon }: { icon: SidebarIconKey }) {
  return (
    <span className="sb-mark">
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {PATHS[icon]}
      </svg>
    </span>
  );
}
