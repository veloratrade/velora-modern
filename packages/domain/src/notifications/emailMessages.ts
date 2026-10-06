// Transactional email message builders — the port of Legacy
// api/src/Core/NotificationService.php (@edede31, READ-ONLY source-read
// 2026-10-06, MG-EMAIL-TYPES / audit §12.3).
//
// WHAT LEGACY SHIPS (source-verified): ten email types, each a fixed assembly
// of localized copy keys around the shared EmailTemplate shell:
//   1 verification    (badge/title/intro/email-box/after/cta/notice, subtitleSecurity)
//   2 welcome         (same box shape, subtitleAnalytics)
//   3 password-reset  (same box shape, subtitleSecurity)
//   4 admin-invite    (same box shape, subtitleSecurity)
//   5 password-changed(green #10b981 box, NO cta button)
//   6 new-device      (ip/device/time detail box)
//   7 first-trade     (symbol • direction box)
//   8 achievement     (localized title/desc box — localizeCopy rule)
//   9 support new-ticket (admin-facing; ticket box; #id — subject)
//  10 support first-reply (user-facing; ticket box)
// Subject lines are catalog keys; HTML + a derived plain text come out of the
// same builder so MIME_HTML_ONLY can never happen.
//
// ESCAPING CONTRACT (Legacy order, preserved): dynamic VALUES are escaped
// FIRST, then substituted into copy params (Legacy: htmlspecialchars before
// translateFor). Template-level fields (badge/title/notice/urls) are escaped
// inside renderEmailTemplate. Content fragments are assembled pre-escaped.
//
// PORT SHAPE: pure builders — no IO, no clock (URLs and the copyright year
// are inputs). The service layer (apps/api) owns preference gating, icon
// attachment, sending and the delivery log.

import { emailCopy, type EmailLocale } from "./emailCopy.js";
import { escapeHtml, htmlToPlain, renderEmailTemplate } from "./emailTemplate.js";

export interface BuiltEmail {
  readonly subject: string;
  readonly html: string;
  /** Plain-text alternative derived from the HTML (Mailer::htmlToPlain). */
  readonly text: string;
  /** Icon CID suffix for sendWithIcon (e.g. "verification"). */
  readonly iconName: string;
}

interface CommonContext {
  readonly locale: EmailLocale;
  readonly frontendBase: string;
  readonly year: number;
}

/** The legacy "email box": a gold-bordered card centered on one value. */
function emailBox(value: string, accent = "#d4af37"): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:#141f32;border:1px solid ${accent};border-radius:10px;box-shadow:0 4px 15px rgba(212,175,55,0.15);">` +
    `<tr><td align="center" style="padding:14px 20px;font-family:Tahoma,Arial,sans-serif;font-size:16px;font-weight:bold;color:${accent};letter-spacing:0.5px;direction:ltr;">${value}</td></tr>` +
    `</table>`
  );
}

function greeting(locale: EmailLocale, nameSafe: string): string {
  return `<p style="margin:0 0 14px;color:#ffffff;font-size:16px;font-weight:bold;">${emailCopy(locale, "email.common.greeting", { name: nameSafe })}</p>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;color:#f3f4f6;">${text}</p>`;
}

interface VerificationEmailInput extends CommonContext {
  readonly email: string;
  readonly fullName: string;
  readonly verifyUrl: string;
}

export function buildVerificationEmail(input: VerificationEmailInput): BuiltEmail {
  const { locale } = input;
  const t = (k: string): string => emailCopy(locale, k);
  const nameSafe = escapeHtml(input.fullName);
  const emailSafe = escapeHtml(input.email);
  const html = renderEmailTemplate({
    locale,
    badge: t("email.verification.badge"),
    title: t("email.verification.title"),
    contentHtml:
      greeting(locale, nameSafe) +
      paragraph(t("email.verification.intro")) +
      emailBox(emailSafe) +
      paragraph(t("email.verification.after")),
    buttonLabel: t("email.verification.cta"),
    buttonUrl: input.verifyUrl,
    notice: t("email.verification.notice"),
    subtitle: t("email.common.subtitleSecurity"),
    iconName: "verification",
    iconAlt: t("email.verification.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return { subject: t("email.verification.subject"), html, text: htmlToPlain(html), iconName: "verification" };
}

interface WelcomeEmailInput extends CommonContext {
  readonly email: string;
  readonly fullName: string;
  readonly dashboardUrl: string;
}

export function buildWelcomeEmail(input: WelcomeEmailInput): BuiltEmail {
  const { locale } = input;
  const t = (k: string): string => emailCopy(locale, k);
  const nameSafe = escapeHtml(input.fullName);
  const emailSafe = escapeHtml(input.email);
  const html = renderEmailTemplate({
    locale,
    badge: t("email.welcome.badge"),
    title: t("email.welcome.title"),
    contentHtml:
      greeting(locale, nameSafe) +
      paragraph(t("email.welcome.intro")) +
      emailBox(emailSafe) +
      paragraph(t("email.welcome.after")),
    buttonLabel: t("email.welcome.cta"),
    buttonUrl: input.dashboardUrl,
    notice: t("email.welcome.notice"),
    subtitle: t("email.common.subtitleAnalytics"),
    iconName: "welcome",
    iconAlt: t("email.welcome.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return { subject: t("email.welcome.subject"), html, text: htmlToPlain(html), iconName: "welcome" };
}

interface PasswordResetEmailInput extends CommonContext {
  readonly email: string;
  readonly fullName: string;
  readonly resetUrl: string;
}

export function buildPasswordResetEmail(input: PasswordResetEmailInput): BuiltEmail {
  const { locale } = input;
  const t = (k: string): string => emailCopy(locale, k);
  const nameSafe = escapeHtml(input.fullName);
  const emailSafe = escapeHtml(input.email);
  const html = renderEmailTemplate({
    locale,
    badge: t("email.passwordReset.badge"),
    title: t("email.passwordReset.title"),
    contentHtml:
      greeting(locale, nameSafe) +
      paragraph(t("email.passwordReset.intro")) +
      emailBox(emailSafe) +
      paragraph(t("email.passwordReset.after")),
    buttonLabel: t("email.passwordReset.cta"),
    buttonUrl: input.resetUrl,
    notice: t("email.passwordReset.notice"),
    subtitle: t("email.common.subtitleSecurity"),
    iconName: "password-reset",
    iconAlt: t("email.passwordReset.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return { subject: t("email.passwordReset.subject"), html, text: htmlToPlain(html), iconName: "password-reset" };
}

interface AdminInviteEmailInput extends CommonContext {
  readonly email: string;
  readonly fullName: string;
  readonly inviteUrl: string;
}

export function buildAdminInviteEmail(input: AdminInviteEmailInput): BuiltEmail {
  const { locale } = input;
  const t = (k: string): string => emailCopy(locale, k);
  const nameSafe = escapeHtml(input.fullName);
  const emailSafe = escapeHtml(input.email);
  const html = renderEmailTemplate({
    locale,
    badge: t("email.invite.badge"),
    title: t("email.invite.title"),
    contentHtml:
      greeting(locale, nameSafe) +
      paragraph(t("email.invite.intro")) +
      emailBox(emailSafe) +
      paragraph(t("email.invite.after")),
    buttonLabel: t("email.invite.cta"),
    buttonUrl: input.inviteUrl,
    notice: t("email.invite.notice"),
    subtitle: t("email.common.subtitleSecurity"),
    iconName: "admin-invite",
    iconAlt: t("email.invite.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return { subject: t("email.invite.subject"), html, text: htmlToPlain(html), iconName: "admin-invite" };
}

interface PasswordChangedEmailInput extends CommonContext {
  readonly email: string;
  readonly fullName: string;
}

export function buildPasswordChangedEmail(input: PasswordChangedEmailInput): BuiltEmail {
  const { locale } = input;
  const t = (k: string): string => emailCopy(locale, k);
  const nameSafe = escapeHtml(input.fullName);
  const emailSafe = escapeHtml(input.email);
  const html = renderEmailTemplate({
    locale,
    badge: t("email.passwordChanged.badge"),
    title: t("email.passwordChanged.title"),
    contentHtml:
      greeting(locale, nameSafe) +
      paragraph(t("email.passwordChanged.intro")) +
      emailBox(emailSafe, "#10b981") +
      paragraph(t("email.passwordChanged.after")),
    buttonLabel: null,
    buttonUrl: null,
    notice: t("email.passwordChanged.notice"),
    subtitle: t("email.common.subtitleSecurity"),
    iconName: "password-changed",
    iconAlt: t("email.passwordChanged.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return { subject: t("email.passwordChanged.subject"), html, text: htmlToPlain(html), iconName: "password-changed" };
}

interface NewDeviceEmailInput extends CommonContext {
  readonly email: string;
  readonly fullName: string;
  readonly ip: string;
  readonly userAgent: string;
  /** Pre-formatted time string (Legacy renders it verbatim, direction ltr). */
  readonly time: string;
}

export function buildNewDeviceEmail(input: NewDeviceEmailInput): BuiltEmail {
  const { locale } = input;
  const t = (k: string): string => emailCopy(locale, k);
  const nameSafe = escapeHtml(input.fullName);
  const ipSafe = escapeHtml(input.ip !== "" ? input.ip : "0.0.0.0");
  const uaSafe = escapeHtml(input.userAgent !== "" ? input.userAgent : t("email.common.unknownDevice"));
  const timeSafe = escapeHtml(input.time);
  const detailBox =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:#141f32;border-radius:10px;border:1px solid #d4af37;box-shadow:0 4px 15px rgba(212,175,55,0.15);">` +
    `<tr><td style="padding:16px 20px;color:#e2e8f0;font-size:14px;line-height:2.2;">` +
    `<strong style="color:#d4af37;">${t("email.newDevice.ip")}:</strong> <span style="color:#ffffff;font-weight:bold;direction:ltr;display:inline-block;">${ipSafe}</span><br>` +
    `<strong style="color:#d4af37;">${t("email.newDevice.device")}:</strong> <span style="color:#ffffff;">${uaSafe}</span><br>` +
    `<strong style="color:#d4af37;">${t("email.newDevice.time")}:</strong> <span style="color:#ffffff;direction:ltr;display:inline-block;">${timeSafe}</span>` +
    `</td></tr></table>`;
  const html = renderEmailTemplate({
    locale,
    badge: t("email.newDevice.badge"),
    title: t("email.newDevice.title"),
    contentHtml:
      greeting(locale, nameSafe) +
      paragraph(t("email.newDevice.intro")) +
      detailBox +
      paragraph(t("email.newDevice.after")),
    buttonLabel: t("email.newDevice.cta"),
    buttonUrl: `${input.frontendBase.replace(/\/+$/, "")}/profile`,
    notice: t("email.newDevice.notice"),
    subtitle: t("email.common.subtitleSecurity"),
    iconName: "security",
    iconAlt: t("email.newDevice.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return { subject: t("email.newDevice.subject"), html, text: htmlToPlain(html), iconName: "security" };
}

interface FirstTradeEmailInput extends CommonContext {
  readonly email: string;
  readonly fullName: string;
  readonly symbol: string;
  readonly direction: string;
}

export function buildFirstTradeEmail(input: FirstTradeEmailInput): BuiltEmail {
  const { locale } = input;
  const t = (k: string): string => emailCopy(locale, k);
  const nameSafe = escapeHtml(input.fullName);
  const symbolSafe = escapeHtml(input.symbol);
  const dirLabel = input.direction.toLowerCase() === "buy" ? t("email.firstTrade.buy") : t("email.firstTrade.sell");
  const tradeBox =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:#141f32;border-radius:10px;border:1px solid #d4af37;box-shadow:0 4px 15px rgba(212,175,55,0.15);">` +
    `<tr><td style="padding:16px 20px;color:#e2e8f0;font-size:14px;line-height:2.2;text-align:center;">` +
    `<div style="font-size:18px;font-weight:bold;color:#d4af37;margin-bottom:8px;">${symbolSafe} &nbsp;•&nbsp; ${dirLabel}</div>` +
    `<div style="color:#ffffff;font-size:13px;">${t("email.firstTrade.status")}</div>` +
    `</td></tr></table>`;
  const html = renderEmailTemplate({
    locale,
    badge: t("email.firstTrade.badge"),
    title: t("email.firstTrade.title"),
    contentHtml:
      greeting(locale, nameSafe) +
      paragraph(t("email.firstTrade.intro")) +
      tradeBox +
      paragraph(t("email.firstTrade.after")),
    buttonLabel: t("email.firstTrade.cta"),
    buttonUrl: `${input.frontendBase.replace(/\/+$/, "")}/dashboard`,
    notice: t("email.firstTrade.notice"),
    subtitle: t("email.common.subtitleAnalytics"),
    iconName: "first-trade",
    iconAlt: t("email.firstTrade.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return { subject: t("email.firstTrade.subject"), html, text: htmlToPlain(html), iconName: "first-trade" };
}

interface AchievementEmailInput extends CommonContext {
  readonly email: string;
  readonly fullName: string;
  /** May be a catalog KEY (achievements.emailVerified.title) or plain text. */
  readonly achievementTitle: string;
  readonly achievementDescription: string;
}

/**
 * BUG-A3 (Legacy): copy arriving as an i18n KEY must be translated before
 * rendering; unknown keys fall back to the generic localized line — a raw
 * key never appears in the final email. Plain (non-key) text passes through.
 */
export function localizeEmailCopy(value: string, locale: EmailLocale, fallbackKey: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value)) return value;
  const translated = emailCopy(locale, value);
  if (translated !== value) return translated;
  return emailCopy(locale, fallbackKey);
}

export function buildAchievementEmail(input: AchievementEmailInput): BuiltEmail {
  const { locale } = input;
  const t = (k: string): string => emailCopy(locale, k);
  const nameSafe = escapeHtml(input.fullName);
  const titleSafe = escapeHtml(localizeEmailCopy(input.achievementTitle, locale, "email.achievement.title"));
  const descSafe = escapeHtml(localizeEmailCopy(input.achievementDescription, locale, "email.achievement.notice"));
  const achievementBox =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:#141f32;border-radius:10px;border:1px solid #d4af37;box-shadow:0 4px 15px rgba(212,175,55,0.18);">` +
    `<tr><td style="padding:18px 20px;text-align:center;">` +
    `<div style="font-size:18px;font-weight:bold;color:#d4af37;margin-bottom:8px;">${titleSafe}</div>` +
    `<div style="color:#ffffff;font-size:14px;line-height:1.9;">${descSafe}</div>` +
    `</td></tr></table>`;
  const html = renderEmailTemplate({
    locale,
    badge: t("email.achievement.badge"),
    title: t("email.achievement.title"),
    contentHtml:
      greeting(locale, nameSafe) +
      paragraph(t("email.achievement.intro")) +
      achievementBox +
      paragraph(t("email.achievement.after")),
    buttonLabel: t("email.achievement.cta"),
    buttonUrl: `${input.frontendBase.replace(/\/+$/, "")}/profile`,
    notice: t("email.achievement.notice"),
    subtitle: t("email.common.subtitleAnalytics"),
    iconName: "achievement",
    iconAlt: t("email.achievement.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return { subject: t("email.achievement.subject"), html, text: htmlToPlain(html), iconName: "achievement" };
}

interface TicketEmailInput extends CommonContext {
  readonly ticketId: number | string;
  readonly ticketSubject: string;
  readonly preview: string;
}

/** The support ticket card shared by both support emails (#id — subject). */
function ticketBox(input: TicketEmailInput, locale: EmailLocale): string {
  const subjectSafe = escapeHtml(String(input.ticketSubject).slice(0, 160));
  const previewSafe = escapeHtml(input.preview.trim().slice(0, 200));
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0;background:#141f32;border-radius:10px;border:1px solid #d4af37;">` +
    `<tr><td style="padding:16px 20px;color:#e2e8f0;font-size:14px;line-height:2;">` +
    `<div style="color:#d4af37;font-weight:bold;">#${input.ticketId} — ${subjectSafe}</div>` +
    (previewSafe !== "" ? `<div style="margin-top:8px;color:#f3f4f6;">${previewSafe}</div>` : "") +
    `</td></tr></table>`
  );
}

export interface SupportNewTicketEmailInput extends TicketEmailInput {
  /** User label shown in the intro (pre-trimmed to 120 by the caller). */
  readonly userLabel: string;
}

/**
 * SUPPORT_NEW_TICKET — admin-facing; sent to the support desk inbox.
 * ADAPTATION (documented): the CTA targets Modern's /admin console; Legacy's
 * `admin/v2/index.html#/comm-inbox` hash route does not exist in Modern.
 */
export function buildSupportNewTicketEmail(input: SupportNewTicketEmailInput): BuiltEmail {
  // Legacy pins the desk locale to English unless a hint resolves.
  const locale: EmailLocale = input.locale;
  const t = (k: string, p?: Record<string, string>): string => emailCopy(locale, k, p);
  const userSafe = escapeHtml(input.userLabel.slice(0, 120));
  const adminUrl = `${input.frontendBase.replace(/\/+$/, "")}/admin?ticket=${input.ticketId}`;
  const html = renderEmailTemplate({
    locale,
    badge: t("email.support.badge"),
    title: t("email.support.newTicket.title"),
    contentHtml:
      paragraph(t("email.support.newTicket.intro", { user: userSafe })) +
      ticketBox(input, locale),
    buttonLabel: t("email.support.newTicket.cta"),
    buttonUrl: adminUrl,
    notice: t("email.support.notice"),
    subtitle: t("email.common.subtitleAnalytics"),
    iconName: "security",
    iconAlt: t("email.support.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return {
    subject: t("email.support.newTicket.subject", { id: String(input.ticketId) }),
    html,
    text: htmlToPlain(html),
    iconName: "security",
  };
}

export interface SupportReplyEmailInput extends TicketEmailInput {
  /** Recipient display name for the intro greeting. */
  readonly userLabel: string;
}

/**
 * SUPPORT_FIRST_REPLY — user-facing; fired once per ticket on first admin reply.
 * ADAPTATION (documented): the CTA targets Modern's /support surface; Legacy's
 * `support/index.html` SPA route does not exist in Modern.
 */
export function buildSupportReplyEmail(input: SupportReplyEmailInput): BuiltEmail {
  const locale: EmailLocale = input.locale;
  const t = (k: string, p?: Record<string, string>): string => emailCopy(locale, k, p);
  const userSafe = escapeHtml(input.userLabel);
  const supportUrl = `${input.frontendBase.replace(/\/+$/, "")}/support?ticket=${input.ticketId}`;
  const html = renderEmailTemplate({
    locale,
    badge: t("email.support.badge"),
    title: t("email.support.reply.title"),
    contentHtml:
      paragraph(t("email.support.reply.intro", { name: userSafe })) +
      ticketBox(input, locale),
    buttonLabel: t("email.support.reply.cta"),
    buttonUrl: supportUrl,
    notice: t("email.support.notice"),
    subtitle: t("email.common.subtitleAnalytics"),
    iconName: "security",
    iconAlt: t("email.support.badge"),
    frontendBase: input.frontendBase,
    year: input.year,
  });
  return {
    subject: t("email.support.reply.subject", { id: String(input.ticketId) }),
    html,
    text: htmlToPlain(html),
    iconName: "security",
  };
}
