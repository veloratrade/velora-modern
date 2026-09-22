/*
 * Legacy auth-page brand logo: gold "V" mark with lgA/lgD/lgC gradients +
 * gradient "VELORA" word-mark. Markup and inline styles preserved from
 * login/register/index.html (`.brand-logo`).
 */
import React from 'react';
import Link from 'next/link';

export function LogoGradientDefs() {
  return (
    <svg aria-hidden="true" height="0" style={{ position: 'absolute' }} width="0">
      <defs>
        <linearGradient id="lgA" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#f9e6a8" />
          <stop offset=".55" stopColor="#e8c45a" />
          <stop offset="1" stopColor="#b8862a" />
        </linearGradient>
        <linearGradient id="lgD" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#9a741f" />
          <stop offset="1" stopColor="#5f4510" />
        </linearGradient>
        <linearGradient id="lgC" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fdf3cd" />
          <stop offset="1" stopColor="#d9a936" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function LogoMarkSvg({ size = 26 }: { size?: number }) {
  return (
    <svg aria-hidden="true" style={{ width: size, height: size }} viewBox="0 0 64 64">
      <path d="M8 10L21 10L32 52L43 10L56 10L32 58Z" fill="none" stroke="#e8c45a" strokeWidth=".7" />
      <path d="M8 10L21 10L32 52L43 10L56 10L32 58Z" fill="url(#lgD)" />
      <path d="M21 10L32 52L32 58L8 10Z" fill="url(#lgD)" opacity=".75" />
      <path d="M43 10L32 52L32 58L56 10Z" fill="url(#lgA)" />
      <path d="M32 14V24M32 37V52" stroke="url(#lgC)" strokeWidth="2.6" />
      <rect fill="url(#lgC)" height="13" width="7" x="28.5" y="24" />
      <path d="M32 6.5L33.3 9.7L36.5 11L33.3 12.3L32 15.5L30.7 12.3L27.5 11L30.7 9.7Z" fill="#f7e3a1" />
    </svg>
  );
}

export function BrandLogo() {
  return (
    <Link
      className="brand-logo"
      href="/"
      style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'inherit', marginBottom: 24 }}
    >
      <div
        className="logo-mark"
        style={{
          width: 44,
          height: 44,
          display: 'grid',
          placeItems: 'center',
          borderRadius: 14,
          background: 'linear-gradient(140deg,rgba(212,175,55,.22),rgba(212,175,55,.06))',
          border: '1px solid rgba(212,175,55,.34)',
          boxShadow: '0 0 28px rgba(212,175,55,.5),inset 0 0 10px rgba(212,175,55,.1)',
        }}
      >
        <LogoMarkSvg />
      </div>
      <span
        className="logo-txt"
        style={{
          fontSize: 20,
          fontWeight: 800,
          letterSpacing: 3,
          color: 'var(--gold)',
          background: 'linear-gradient(120deg,var(--gold3),var(--gold) 50%,var(--gold2))',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}
      >
        VELORA
      </span>
    </Link>
  );
}
