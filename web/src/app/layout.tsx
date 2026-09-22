import type { Metadata, Viewport } from 'next';
import React from 'react';
import '@/styles/globals.css';
import { PRE_PAINT_LOCALE_SCRIPT } from '@/i18n/I18nProvider';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'VELORA — ژورنال هوشمند معاملات',
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    apple: '/apple-icon.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#060A14',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `lang`/`dir` defaults match the registry default (fa/rtl); the inline
  // pre-paint script re-resolves them from cookie/localStorage/browser exactly
  // like legacy velora-locale-bootstrap.js, before hydration.
  return (
    <html lang="fa-IR-u-nu-latn" dir="rtl" data-locale="fa" data-direction="rtl" data-numbering="latn" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT_LOCALE_SCRIPT }} />
        {/* Legacy typography: Estedad (FA) + Geist (EN). See migration map G5. */}
        <link href="https://fonts.googleapis.com" rel="preconnect" />
        <link crossOrigin="" href="https://fonts.gstatic.com" rel="preconnect" />
        <link
          href="https://fonts.googleapis.com/css2?family=Estedad:wght@100..900&family=Geist:wght@100..900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers features={['common', 'errors', 'auth', 'dashboard', 'trades', 'profile']}>{children}</Providers>
      </body>
    </html>
  );
}
