'use client';
import React, { useEffect, useState } from 'react';
import './legacy.css';
import * as api from '@/lib/api/client';
import { useI18n } from '@/i18n/I18nProvider';
import { useSession } from '@/lib/auth/session';
import { useAiConsent } from '@/lib/hooks/useAiConsent';
import { useUiSound } from '@/lib/hooks/useUiSound';
import { AppShell } from '@/components/shell/AppShell';
import { NewTradeLink } from '@/components/trades/NewTradeLink';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

const I = {
  user: <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
  lock: <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><rect height="10" rx="3" width="18" x="3" y="11" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>,
  sound: <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><path d="M11 5 6 9v6l5 4V5Z" /><path d="M15 9a4 4 0 0 1 0 6m2.5-8.5a7 7 0 0 1 0 11" /></svg>,
  soundSmall: <svg viewBox="0 0 24 24"><path d="M11 5 6 9v6l5 4V5Z" /><path d="M15 9a4 4 0 0 1 0 6m2.5-8.5a7 7 0 0 1 0 11" /></svg>,
  ai: <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="M5 19a9 9 0 0 1 14 0" /></svg>,
  aiSmall: <svg viewBox="0 0 24 24"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /></svg>,
  devices: <svg fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24"><rect height="14" rx="3" width="20" x="2" y="5" /><path d="M2 10h20" /><path d="M6 14h.01M10 14h.01M14 14h.01" /></svg>,
  laptop: <svg fill="none" height="19" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="19"><rect height="14" rx="3" width="20" x="2" y="4" /><path d="M8 21h8M12 17v4" /></svg>,
};

export default function ProfilePage() {
  const { t, locale, date, errorMessage } = useI18n();
  const { user, setUser, logout } = useSession();
  const [profileError, setProfileError] = useState(false);
  const sound = useUiSound();
  const ai = useAiConsent(user ? user.aiConsent : null);
  const [agent, setAgent] = useState('');

  // Fresh profile from the server (session user may be stale).
  useEffect(() => {
    api.request<{ user?: api.SessionUser }>('/api/v1/auth/me')
      .then((d) => { if (d.user) setUser(d.user); })
      .catch((e: api.ApiError) => { if (e.status === 401) void logout().finally(() => window.location.replace('/login/')); else setProfileError(true); });
    setAgent((navigator.userAgent || '').slice(0, 80));
  }, [setUser, logout]);
  useEffect(() => { if (profileError) ai.markUnavailable(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileError]);

  const name = user?.fullName || t('common.user');
  const roleLabel = t(user?.role === 'admin' ? 'profile.role.admin' : 'profile.role.user');

  /* ---- change password ---- */
  const [cur, setCur] = useState(''); const [next, setNext] = useState('');
  const [pw, setPw] = useState<{ err?: string; ok?: string; busy?: boolean }>({});
  async function changePassword() {
    setPw({});
    if (!cur || !next) return setPw({ err: t('profile.passwordFieldsRequired') });
    if (next.length < 8) return setPw({ err: t('profile.passwordTooShort') });
    setPw({ busy: true });
    try {
      await api.request('/api/v1/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: next, notificationLocale: locale } });
      setPw({ ok: t('profile.passwordChanged') }); setCur(''); setNext('');
      setTimeout(() => void logout().finally(() => window.location.replace('/login/')), 2500);
    } catch (e) { setPw({ err: errorMessage(e) }); }
  }

  const pillMode = ai.state === 'on' ? ' on' : ai.state === 'unavailable' ? ' na' : '';
  const pillKey = ai.state === 'on' ? 'profile.aiConsent.pillOn' : ai.state === 'off' ? 'profile.aiConsent.pillOff' : ai.state === 'unavailable' ? 'profile.aiConsent.pillUnavailable' : 'profile.aiConsent.statusLoading';
  const ctaKey = ai.state === 'saving' ? 'profile.aiConsent.saving' : ai.enabled ? 'profile.aiConsent.deactivate' : 'profile.aiConsent.activate';
  const aiErr = ai.state === 'unavailable' ? t('profile.aiConsent.unavailable') : ai.saveFailed ? t('profile.aiConsent.error') : null;

  return (
    <div className="pg-profile">
      <AppShell topRight={<NewTradeLink />}>
        <div className="panel">
          <div className="panel-head">{I.user} <span>{t('pages.profile.account.info.399022fc', null, 'اطلاعات حساب')}</span></div>
          <div className="profile-hero">
            <div className="p-av">{name.charAt(0) || 'V'}</div>
            <div>
              <div className="p-name">{user ? name : '—'}</div>
              <div className="p-mail">{user?.email || '—'}</div>
              <span className="p-role">{user ? roleLabel : '—'}</span>
            </div>
          </div>
          <div className="meta-grid">
            <div className="meta"><div className="lbl">{t('common.role.eb5456b4', null, 'نقش')}</div><div className="val">{user ? roleLabel : '—'}</div></div>
            <div className="meta"><div className="lbl">{t('pages.profile.timezone.06a6d9fe', null, 'منطقه زمانی')}</div><div className="val">{user?.timezone || 'UTC'}</div></div>
            <div className="meta"><div className="lbl">{t('common.member.since.f0ceac0b', null, 'تاریخ عضویت')}</div><div className="val">{user ? date(user.createdAt) : '—'}</div></div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">{I.lock} <span>{t('common.change.password.ab337237', null, 'تغییر رمز عبور')}</span></div>
          <InlineNotice visible={!!pw.err}>{pw.err}</InlineNotice>
          <InlineNotice kind="ok" visible={!!pw.ok}>{pw.ok}</InlineNotice>
          <div className="form-grid">
            <div className="field"><label>{t('pages.profile.current.password.5935e783', null, 'رمز فعلی')}</label><input className="input" placeholder="••••••••" type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
            <div className="field"><label>{t('common.new.password.f8211826', null, 'رمز جدید')}</label><input className="input" placeholder={t('common.minimum.8.characters.0a76ac5c', null, 'حداقل 8 کاراکتر')} type="password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
          </div>
          <button className="btn-gold" disabled={pw.busy} onClick={() => void changePassword()}>
            {pw.busy ? <><span className="btn-spinner" /> {t('profile.changingPassword')}</> : t('common.change.password.ab337237', null, 'تغییر رمز عبور')}
          </button>
        </div>

        <div className="panel">
          <div className="panel-head">{I.sound} <span>{t('pages.profile.p05.experience', null, 'تجربه رابط کاربری')}</span></div>
          <div className="sound-pref">
            <div className="sound-pref-copy"><div className="sound-pref-ico">{I.soundSmall}</div><div><b>{t('pages.profile.p05.sounds', null, 'صداهای رابط کاربری')}</b><small>{t('pages.profile.p05.sounds_detail', null, 'صدای ملایم فقط برای تأییدها و تعامل‌های مهم')}</small></div></div>
            <ToggleSwitch on={sound.enabled} label={t('pages.profile.p05.sounds')} onClick={sound.toggle} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head ai-pref-head">
            <span className="t">{I.ai} <span>{t('profile.aiConsent.title', null, 'پردازش هوش مصنوعی')}</span></span>
            <span className={`ai-pill${pillMode}`}><span className="dot" /><span>{t(pillKey)}</span></span>
          </div>
          <div className="sound-pref">
            <div className="sound-pref-copy"><div className="sound-pref-ico">{I.aiSmall}</div><div><b>{t(ai.enabled ? 'profile.aiConsent.stateOn' : 'profile.aiConsent.stateOff')}</b><small>{t('profile.aiConsent.description')}</small></div></div>
            <ToggleSwitch on={ai.enabled} label={t('profile.aiConsent.title')} onClick={ai.toggle} />
          </div>
          <div className={`ai-consent-note${ai.state === 'off' ? ' show' : ''}`}><span>{t('profile.aiConsent.required')}</span></div>
          <div className="ai-consent-actions">
            <button className={`btn-gold${ai.state === 'saving' ? ' saving' : ''}`} type="button" disabled={ai.state !== 'on' && ai.state !== 'off'} onClick={() => void ai.set(!ai.enabled)}>{t(ctaKey)}</button>
          </div>
          <InlineNotice visible={!!aiErr}>{aiErr}</InlineNotice>
        </div>

        <div className="panel">
          <div className="panel-head">{I.devices} <span>{t('pages.profile.connected.devices.00dfa75d', null, 'دستگاه‌های متصل')}</span></div>
          <div className="dev-item">
            <div className="dev-ic">{I.laptop}</div>
            <div><b>{t('pages.profile.current.device.edc04ca5', null, 'دستگاه فعلی')}</b><small>{agent || t('pages.profile.your.browser.13d9a570', null, 'مرورگر شما')}</small></div>
            <span className="cur"><span className="dot" /> <span>{t('pages.profile.this.device.9da362b7', null, 'این دستگاه')}</span></span>
          </div>
          <div className="hint" style={{ fontSize: 11, color: 'var(--faint)', marginTop: 10 }}>{t('pages.profile.every.sign.in.from.a.new.device.898dc250', null, 'هر ورود از دستگاه جدید با ایمیل امنیتی به شما اطلاع داده می‌شود.')}</div>
        </div>
      </AppShell>
    </div>
  );
}
