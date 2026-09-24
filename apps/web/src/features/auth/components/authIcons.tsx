import React from "react";

export const MailIcon = () => (
  <svg fill="none" viewBox="0 0 24 24">
    <rect height="13" rx="3" width="18" x="3" y="5.5" stroke="currentColor" strokeWidth="1.65" />
    <path d="M4.4 7.4 12 12.6l7.6-5.2" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const LockIcon = () => (
  <svg fill="none" viewBox="0 0 24 24">
    <path d="M8 10.8V8.1a4 4 0 0 1 8 0v2.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    <rect height="9.2" rx="2.6" width="13.2" x="5.4" y="10.8" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="12" cy="15.4" r="1.15" fill="currentColor" />
  </svg>
);
export const EyeOpen = () => (
  <svg fill="none" height="18" viewBox="0 0 24 24" width="18">
    <path d="M2.6 12S6.2 6.4 12 6.4 21.4 12 21.4 12 17.8 17.6 12 17.6 2.6 12 2.6 12Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
  </svg>
);
export const EyeShut = () => (
  <svg fill="none" height="18" viewBox="0 0 24 24" width="18">
    <path d="M3.2 3.2 20.8 20.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    <path d="M9.3 9.5A3.2 3.2 0 0 0 14.5 14.7M6.2 6.7C4.1 8.1 2.6 12 2.6 12S6.2 17.6 12 17.6c1.7 0 3.2-.4 4.5-1M17.6 15.2c1.8-1.3 3.2-3.2 3.8-3.2 0 0-3.6-5.6-9.4-5.6-.9 0-1.8.1-2.6.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const FootLockIcon = () => (
  <svg fill="none" height="14" viewBox="0 0 24 24" width="14">
    <path d="M8 10.8V8.2a4 4 0 0 1 8 0v2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    <rect height="8.8" rx="2.4" width="12.6" x="5.7" y="10.8" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="12" cy="15.2" r="1" fill="currentColor" />
  </svg>
);
const F = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, viewBox: "0 0 24 24" } as const;
export const RegUserIcon = () => (
  <svg {...F}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);
export const RegMailIcon = () => (
  <svg {...F}>
    <rect height="16" rx="3" width="20" x="2" y="4" />
    <path d="M2 8l10 7L22 8" />
  </svg>
);
export const RegLockIcon = () => (
  <svg {...F}>
    <rect height="10" rx="3" width="18" x="3" y="11" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
export const RegEyeIcon = () => (
  <svg {...F} height="18" width="18">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const FeatChartIcon = () => (
  <svg {...F} height="20" width="20">
    <path d="M3 3v18h18" />
    <path d="M7 15l4-6 4 3 5-8" />
  </svg>
);
export const FeatShieldIcon = () => (
  <svg {...F} height="20" width="20">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);
export const FeatCardIcon = () => (
  <svg {...F} height="20" width="20">
    <rect height="14" rx="3" width="20" x="2" y="4" />
    <path d="M2 9h20" />
    <path d="M6 14h.01M10 14h.01M14 14h.01" />
  </svg>
);
export const SparkIcon = () => (
  <svg fill="none" height="16" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="16">
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
  </svg>
);
export const CopyIcon = () => (
  <svg {...F} height="16" width="16">
    <rect height="12" rx="2" width="12" x="9" y="9" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
export const HeroEnvelope = () => (
  <svg fill="none" height="46" viewBox="0 0 48 48" width="46" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient gradientUnits="userSpaceOnUse" id="vgEnv2" x1="8" x2="40" y1="10" y2="40">
        <stop stopColor="#fce38a" />
        <stop offset=".55" stopColor="#d4af37" />
        <stop offset="1" stopColor="#b88d1d" />
      </linearGradient>
    </defs>
    <rect fill="#0F1B3D" height="24" rx="6" stroke="url(#vgEnv2)" strokeWidth="1.6" width="38" x="5" y="13" />
    <path d="M8 17L24 29L40 17" fill="none" stroke="url(#vgEnv2)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
    <path d="M40 36L35.2 30M8 36L12.8 30" opacity=".85" stroke="url(#vgEnv2)" strokeLinecap="round" strokeWidth="2" />
    <circle cx="40.5" cy="10.5" fill="#10b981" r="5" stroke="#0F1B3D" strokeWidth="1.6" />
    <path d="M38 10.5L40 12.5L43 8.5" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
  </svg>
);
