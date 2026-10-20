// NotificationService — the transactional-email orchestrator
// (MG-EMAIL-TYPES, audit §12.3; the port of Legacy
// api/src/Core/NotificationService.php @edede31, READ-ONLY source-read
// 2026-10-06).
//
// WHAT LEGACY DOES (source-verified), and what this port preserves:
//   - Ten email types assembled from the shared template + catalog copy
//     (the assembly lives in @velora/domain/notifications — pure).
//   - Preference gating EXACTLY where Legacy gated: welcome→'welcome',
//     new-device→'security', first-trade→'trades', achievement→
//     'achievements'. The six essential/security flows (verification,
//     password-reset, admin-invite, password-changed, support×2) are NEVER
//     gated — an account-security email is not a marketing preference.
//   - sendWithIcon: the branded template ships CID logo + per-type icon; a
//     MISSING ICON ASSET FAILS THE SEND (logged failed) — the brand identity
//     is part of the capability, not decoration.
//   - logNotification: EVERY attempt lands in email_notifications with its
//     honest outcome (sent/failed + reason).
//   - Nothing here ever throws into a caller's flow (Legacy returned bool;
//     Modern returns the MailResult-derived outcome and swallows adapter
//     surprises).
//
// PORT NOTES:
//   - The icon assets are vendored byte-identical at apps/api/assets/
//     email-icons/ (md5-verified against Legacy public/assets at extraction).
//   - Locale comes from the caller (auth paths resolve users.locale through
//     the same rule Legacy used: stored preference first, request hint
//     second, manifest default last).
//   - SUPPORT_NOTIFY_EMAIL keeps Legacy's env contract (default
//     support@veloratrade.ir) for the desk inbox.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BuiltEmail,
  EmailLocale,
} from "@velora/domain";
import {
  buildAchievementEmail,
  buildAdminInviteEmail,
  buildFirstTradeEmail,
  buildNewDeviceEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildSupportNewTicketEmail,
  buildSupportReplyEmail,
  buildVerificationEmail,
  buildWelcomeEmail,
} from "@velora/domain";
import type { MailInlineImage, MailPort, MailResult } from "../mail/mailPort.js";
import type { EmailNotificationLog, EmailEventType } from "./notificationStores.js";

/** Email-preference keys exactly where Legacy gated (EmailPreferenceRepository::canSend). */
export type NotificationPreferenceGate = "welcome" | "security" | "trades" | "achievements";

export interface NotificationRecipient {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly locale: string | null | undefined;
}

export interface NotificationServiceDeps {
  readonly mail: MailPort;
  readonly log: EmailNotificationLog;
  /** Frontend origin (no trailing slash) — links + List-Unsubscribe. */
  readonly appOrigin: string;
  /** Support desk inbox (Legacy SUPPORT_NOTIFY_EMAIL, same default). */
  readonly supportDeskEmail?: string;
  /** Injectable clock (TestClock pattern). */
  readonly now?: () => Date;
  /** Injectable asset directory override (tests). */
  readonly iconsDir?: string;
}

const ICON_FILES: Readonly<Record<string, string>> = Object.freeze({
  verification: "verification.png",
  welcome: "welcome.png",
  "password-reset": "password-reset.png",
  "admin-invite": "admin-invite.png",
  "password-changed": "password-changed.png",
  security: "security.png",
  "first-trade": "first-trade.png",
  achievement: "achievement.png",
});

/**
 * Where the email icons live next to the source — resolved LAZILY, on purpose.
 *
 * This used to run in the constructor, and that was a whole-API outage in a Cloudflare Worker: a
 * bundled Worker has no `import.meta.url` and no filesystem, `fileURLToPath(undefined)` throws, the
 * composition root throws with it, and EVERY route answers 500 — including `/health` and the panel's
 * login — because building the notification service is part of building the app. Measured in
 * `wrangler dev` (workerd) before this change; see `apps/api-cf/README.md`.
 *
 * Resolving it here instead keeps the documented contract intact: a send whose icons cannot be loaded
 * still FAILS and is recorded as `icon-missing` ("the brand identity is part of the capability, not
 * decoration" — Legacy sendWithIcon). What changes is the blast radius: one email fails, the API runs.
 */
function defaultIconsDir(): string {
  const moduleUrl: string | undefined = import.meta.url;
  if (moduleUrl === undefined || !moduleUrl.startsWith("file:")) {
    throw new Error("email icon assets are not reachable in this runtime (no file:// module URL)");
  }
  // src/notifications → apps/api/assets/email-icons (tsx runs from src).
  return join(dirname(fileURLToPath(moduleUrl)), "..", "..", "assets", "email-icons");
}

/**
 * One send outcome, for callers that want the truth without exceptions.
 * `skipped` means a preference gate said no (Legacy returned false).
 */
export type NotificationSendResult =
  | { readonly outcome: "sent" }
  | { readonly outcome: "skipped"; readonly reason: "preference-off" }
  | { readonly outcome: "failed"; readonly reason: string };

export class NotificationService {
  private readonly mail: MailPort;
  private readonly log: EmailNotificationLog;
  private readonly appOrigin: string;
  private readonly supportDeskEmail: string;
  private readonly now: () => Date;
  /** `null` ⇒ resolve the built-in directory on first use (and fail the send if it cannot be). */
  private readonly iconsDir: string | null;
  private iconCache: ReadonlyMap<string, MailInlineImage> | null = null;

  constructor(deps: NotificationServiceDeps) {
    this.mail = deps.mail;
    this.log = deps.log;
    this.appOrigin = deps.appOrigin.replace(/\/+$/, "");
    this.supportDeskEmail = (deps.supportDeskEmail ?? "support@veloratrade.ir").trim();
    this.now = deps.now ?? (() => new Date());
    this.iconsDir = deps.iconsDir ?? null;
  }

  /** Load + cache the icon set; a missing file throws HERE (caller decides). */
  private async icons(): Promise<ReadonlyMap<string, MailInlineImage>> {
    if (this.iconCache !== null) return this.iconCache;
    // Throws when the assets are unreachable; the caller turns that into `icon-missing` (see
    // `defaultIconsDir`). This is the one place the directory is resolved.
    const dir = this.iconsDir ?? defaultIconsDir();
    const entries = await Promise.all(
      Object.entries(ICON_FILES).map(async ([name, file]) => {
        const content = await readFile(join(dir, file));
        return [name, { cid: `velora-${name}`, filename: file, contentBase64: content.toString("base64") }] as const;
      }),
    );
    const logo = await readFile(join(dir, "velora-email-logo.png"));
    entries.push([
      "logo",
      { cid: "velora-logo", filename: "velora-email-logo.png", contentBase64: logo.toString("base64") },
    ] as const);
    const cache = new Map<string, MailInlineImage>(entries);
    this.iconCache = cache;
    return cache;
  }

  /**
   * The shared pipeline: gate → build → attach icons → send → log.
   * Never throws; every branch records what actually happened.
   */
  private async dispatch(input: {
    recipient: NotificationRecipient;
    locale: EmailLocale;
    gate: NotificationPreferenceGate | null;
    eventType: EmailEventType;
    build: () => BuiltEmail;
    to?: string;
  }): Promise<NotificationSendResult> {
    if (input.gate !== null && !(await this.preferenceAllows(input.recipient.userId, input.gate))) {
      return { outcome: "skipped", reason: "preference-off" };
    }

    let built: BuiltEmail;
    try {
      built = input.build();
    } catch {
      // Builder failure = programming error; log failed and move on.
      await this.log.log(
        {
          userId: input.recipient.userId,
          eventType: input.eventType,
          recipientEmail: input.to ?? input.recipient.email,
          subject: "",
          status: "failed",
          errorMessage: "build-error",
        },
        this.now(),
      );
      return { outcome: "failed", reason: "build-error" };
    }

    // Legacy sendWithIcon: a missing icon or logo asset fails the send —
    // the brand identity is part of the capability, not decoration. An
    // unreadable asset directory is the same failure.
    let icons: ReadonlyMap<string, MailInlineImage>;
    try {
      icons = await this.icons();
    } catch {
      await this.log.log(
        {
          userId: input.recipient.userId,
          eventType: input.eventType,
          recipientEmail: input.to ?? input.recipient.email,
          subject: built.subject,
          status: "failed",
          errorMessage: "Email icon asset is missing",
        },
        this.now(),
      );
      return { outcome: "failed", reason: "icon-missing" };
    }
    const icon = icons.get(built.iconName);
    const logo = icons.get("logo");
    if (icon === undefined || logo === undefined) {
      await this.log.log(
        {
          userId: input.recipient.userId,
          eventType: input.eventType,
          recipientEmail: input.to ?? input.recipient.email,
          subject: built.subject,
          status: "failed",
          errorMessage: "Email icon asset is missing",
        },
        this.now(),
      );
      return { outcome: "failed", reason: "icon-missing" };
    }

    let result: MailResult;
    try {
      result = await this.mail.send({
        to: input.to ?? input.recipient.email,
        subject: built.subject,
        text: built.text,
        html: built.html,
        inlineImages: [logo, icon],
      });
    } catch {
      result = { ok: false, reason: "transport-error" };
    }

    await this.log.log(
      {
        userId: input.recipient.userId,
        eventType: input.eventType,
        recipientEmail: input.to ?? input.recipient.email,
        subject: built.subject,
        status: result.ok ? "sent" : "failed",
        errorMessage: result.ok ? null : result.reason,
      },
      this.now(),
    );
    return result.ok ? { outcome: "sent" } : { outcome: "failed", reason: result.reason };
  }

  private ctx(locale: EmailLocale): { locale: EmailLocale; frontendBase: string; year: number } {
    return { locale, frontendBase: this.appOrigin, year: this.now().getUTCFullYear() };
  }

  /**
   * Preference gate. Implemented against a `preferences` callback so the
   * service stays store-agnostic; the auth wiring passes the UserStore's
   * getEmailPreferences. Defaults to ALLOW (Legacy: no preference row ⇒
   * sendable — "policy: absent record allows delivery").
   */
  preferences:
    | ((userId: string, gate: NotificationPreferenceGate) => Promise<boolean>)
    | null = null;

  private async preferenceAllows(userId: string, gate: NotificationPreferenceGate): Promise<boolean> {
    if (this.preferences === null) return true;
    try {
      return await this.preferences(userId, gate);
    } catch {
      return true; // fail-open: a preference read failure must not drop mail
    }
  }

  // --- the ten email types (Legacy order) ------------------------------------

  async sendVerificationEmail(
    recipient: NotificationRecipient,
    verifyUrl: string,
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: null,
      eventType: "VERIFICATION_EMAIL",
      build: () =>
        buildVerificationEmail({
          ...this.ctx(locale),
          email: recipient.email,
          fullName: recipient.fullName ?? "",
          verifyUrl,
        }),
    });
  }

  async sendWelcomeEmail(
    recipient: NotificationRecipient,
    dashboardUrl: string,
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: "welcome", // BUG-A8 (Legacy): welcome respects the user's preference
      eventType: "WELCOME_EMAIL",
      build: () =>
        buildWelcomeEmail({
          ...this.ctx(locale),
          email: recipient.email,
          fullName: recipient.fullName ?? "",
          dashboardUrl,
        }),
    });
  }

  async sendPasswordResetTokenEmail(
    recipient: NotificationRecipient,
    resetUrl: string,
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: null,
      eventType: "PASSWORD_RESET_LINK",
      build: () =>
        buildPasswordResetEmail({
          ...this.ctx(locale),
          email: recipient.email,
          fullName: recipient.fullName ?? "",
          resetUrl,
        }),
    });
  }

  async sendAdminInviteEmail(
    recipient: NotificationRecipient,
    inviteUrl: string,
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: null,
      eventType: "ADMIN_INVITE",
      build: () =>
        buildAdminInviteEmail({
          ...this.ctx(locale),
          email: recipient.email,
          fullName: recipient.fullName ?? "",
          inviteUrl,
        }),
    });
  }

  async sendPasswordChangedEmail(
    recipient: NotificationRecipient,
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: null,
      eventType: "PASSWORD_CHANGED",
      build: () =>
        buildPasswordChangedEmail({
          ...this.ctx(locale),
          email: recipient.email,
          fullName: recipient.fullName ?? "",
        }),
    });
  }

  async sendNewDeviceDetectedEmail(
    recipient: NotificationRecipient,
    details: { ip: string; userAgent: string; time: string },
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: "security",
      eventType: "NEW_DEVICE_DETECTED",
      build: () =>
        buildNewDeviceEmail({
          ...this.ctx(locale),
          email: recipient.email,
          fullName: recipient.fullName ?? "",
          ip: details.ip,
          userAgent: details.userAgent,
          time: details.time,
        }),
    });
  }

  async sendFirstTradeEmail(
    recipient: NotificationRecipient,
    details: { symbol: string; direction: string },
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: "trades",
      eventType: "FIRST_TRADE_RECORDED",
      build: () =>
        buildFirstTradeEmail({
          ...this.ctx(locale),
          email: recipient.email,
          fullName: recipient.fullName ?? "",
          symbol: details.symbol,
          direction: details.direction,
        }),
    });
  }

  async sendAchievementUnlockedEmail(
    recipient: NotificationRecipient,
    details: { achievementTitle: string; achievementDescription: string },
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: "achievements",
      eventType: "ACHIEVEMENT_UNLOCKED",
      build: () =>
        buildAchievementEmail({
          ...this.ctx(locale),
          email: recipient.email,
          fullName: recipient.fullName ?? "",
          achievementTitle: details.achievementTitle,
          achievementDescription: details.achievementDescription,
        }),
    });
  }

  /** SUPPORT_NEW_TICKET — admin-facing, addressed to the desk inbox. */
  async sendSupportNewTicketEmail(
    recipient: NotificationRecipient,
    details: { ticketId: number | string; subject: string; userLabel: string; preview: string },
    userLocale: EmailLocale | null,
  ): Promise<NotificationSendResult> {
    // Legacy: resolveEmailLocale('en', userLocale) ?? default → desk reads
    // English unless the reporter's locale is known.
    const locale: EmailLocale = userLocale ?? "en";
    return this.dispatch({
      recipient,
      locale,
      gate: null,
      eventType: "SUPPORT_NEW_TICKET",
      to: this.supportDeskEmail,
      build: () =>
        buildSupportNewTicketEmail({
          ...this.ctx(locale),
          ticketId: details.ticketId,
          ticketSubject: details.subject,
          preview: details.preview,
          userLabel: details.userLabel,
        }),
    });
  }

  /** SUPPORT_FIRST_REPLY — user-facing, fired once per ticket. */
  async sendSupportReplyEmail(
    recipient: NotificationRecipient,
    details: { ticketId: number | string; subject: string; preview: string },
    locale: EmailLocale,
  ): Promise<NotificationSendResult> {
    return this.dispatch({
      recipient,
      locale,
      gate: null,
      eventType: "SUPPORT_FIRST_REPLY",
      build: () =>
        buildSupportReplyEmail({
          ...this.ctx(locale),
          ticketId: details.ticketId,
          ticketSubject: details.subject,
          preview: details.preview,
          userLabel: recipient.fullName ?? recipient.email,
        }),
    });
  }
}
