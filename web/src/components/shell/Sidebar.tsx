'use client';
/*
 * App sidebar — ported from the legacy `<aside id="veloraSidebar">` markup
 * shared by every app page (dashboard/trades/accounts/profile/...).
 * Item order, i18n keys, avatar block, logout button and admin-only hiding
 * are preserved.
 */
import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/i18n/I18nProvider';
import { useSession } from '@/lib/auth/session';
import { SidebarMark, type SidebarIconKey } from './sidebarIcons';
import { confirmDialog } from '@/components/ui/ConfirmDialog';

interface NavItem {
  href: string;
  icon: SidebarIconKey;
  key: string;
  fallback: string;
  adminOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard/', icon: 'dash', key: 'common.dashboard.2aea7aaf', fallback: 'داشبورد' },
  { href: '/markets/', icon: 'mkt', key: 'common.markets.9f1cdf65', fallback: 'بازارها' },
  { href: '/intelligence/', icon: 'intel', key: 'common.tradingIntelligence', fallback: 'Trading Intelligence' },
  { href: '/trades/', icon: 'journal', key: 'common.trades.c19408e7', fallback: 'ژورنال معاملات' },
  { href: '/wallet/', icon: 'wallet', key: 'common.wallet.cd1a64bc', fallback: 'کیف پول' },
  { href: '/performance/', icon: 'perf', key: 'common.performance.a68933d2', fallback: 'عملکرد' },
  { href: '/news/', icon: 'news', key: 'common.news.bba91630', fallback: 'اخبار' },
  { href: '/profile/', icon: 'profile', key: 'common.profile.8b081d3b', fallback: 'پروفایل' },
  { href: '/support/', icon: 'support', key: 'common.support.152185b4', fallback: 'پشتیبانی' },
  { href: '/admin/', icon: 'admin', key: 'common.admin.41ae8044', fallback: 'مدیریت', adminOnly: true },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const pathname = usePathname() || '';
  const { user, logout } = useSession();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const name = user?.fullName?.trim() || t('common.user.cfadc9e3', null, 'کاربر');
  const email = user?.email || '';
  const av = name.trim().charAt(0) || 'V';

  const onLogout = async (e: React.MouseEvent) => {
    e.preventDefault();
    const fa = locale === 'fa';
    const yes = await confirmDialog(
      fa ? 'آیا می‌خواهید از حساب VELORA خارج شوید؟' : 'Do you want to sign out of your VELORA account?',
      { title: fa ? 'خروج از حساب' : 'Sign out', confirm: fa ? 'خروج' : 'Sign out', cancel: fa ? 'انصراف' : 'Cancel' },
    );
    if (yes) {
      await logout();
      window.location.replace('/login/');
    }
  };

  return (
    <>
      <aside className={`sidebar${open ? ' drawer-open' : ''}`} id="veloraSidebar">
        <div className="sb-logo">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="V" src="/velora-logo.svg" />
          <span>VELORA</span>
        </div>
        <nav className="sb-nav">
          {NAV_ITEMS.map((item) => {
            if (item.adminOnly && !isAdmin) return null;
            const active = pathname === item.href || pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                className={`sb-item${active ? ' active' : ''}`}
                href={item.href}
                id={item.adminOnly ? 'adminLinkSide' : undefined}
                onClick={onClose}
              >
                <SidebarMark icon={item.icon} />
                <span>{t(item.key, null, item.fallback)}</span>
              </Link>
            );
          })}
        </nav>
        <div
          className="sb-user"
          style={{
            marginTop: 'auto',
            padding: 14,
            background: 'linear-gradient(135deg,rgba(14,26,51,0.9),rgba(6,10,20,0.95))',
            border: '1px solid rgba(212,175,55,0.35)',
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
          }}
        >
          <div className="av-wrap" style={{ position: 'relative', flexShrink: 0 }}>
            <div
              className="av"
              id="userAv"
              style={{
                width: 42,
                height: 42,
                borderRadius: '50%',
                background: 'linear-gradient(135deg,#ffb703,#d4af37)',
                border: '2px solid #fff0bd',
                boxShadow: '0 0 15px rgba(255,183,3,0.45)',
                display: 'grid',
                placeItems: 'center',
                color: '#060a14',
                fontWeight: 900,
                fontSize: 17,
              }}
            >
              {av}
            </div>
            <span
              style={{
                position: 'absolute',
                bottom: 0,
                insetInlineEnd: 0,
                width: 11,
                height: 11,
                background: '#4CD39A',
                border: '2px solid #060a14',
                borderRadius: '50%',
                boxShadow: '0 0 6px #4CD39A',
              }}
            />
          </div>
          <div className="nm" style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <b
              id="userName"
              style={{ color: '#fff', fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {name}
            </b>
            <small
              id="userEmail"
              style={{ color: '#8fa0c0', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {email}
            </small>
          </div>
          <button
            className="logout"
            id="logoutBtn"
            type="button"
            title={t('common.logout.27be6c53', null, 'خروج از حساب')}
            onClick={onLogout}
            style={{
              background: 'rgba(255,183,3,0.12)',
              border: '1px solid rgba(255,183,3,0.45)',
              borderRadius: 10,
              color: '#ffb703',
              cursor: 'pointer',
              marginInlineStart: 'auto',
              width: 34,
              height: 34,
              display: 'grid',
              placeItems: 'center',
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
          >
            <svg
              fill="none"
              height="16"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="16"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" x2="9" y1="12" y2="12" />
            </svg>
          </button>
        </div>
      </aside>
      <div className={`sidebar-overlay${open ? ' open' : ''}`} id="veloraSidebarOverlay" onClick={onClose} />
    </>
  );
}
