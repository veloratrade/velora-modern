// MailPort — outbound transactional email boundary (Phase 3B-1, OD-12).
//
// Capability contract (Phase 3A, owner-approved):
//   - ONE provider abstraction; adapters implement it (Resend, log). No second
//     provider is introduced and no provider is replaced.
//   - The From identity is the C-09 external contract, verified against the
//     Legacy reference (api/src/Core/Mailer.php RESEND_FROM):
//       'VELORA TRADE <no-reply@veloratrade.ir>'
//   - Secrets are ENVIRONMENT-MANAGED ONLY. No key, token, or credential is
//     ever accepted as a literal in this repository, logged, or placed in an
//     error message (§7 security requirements).
//
// Delivery is intentionally modelled as fail-closed and non-throwing at the
// port level: a transport failure returns { ok: false, reason } so that callers
// implementing anti-enumeration flows (forgot-password) cannot leak provider
// state or account existence through a thrown error or a differing status code.

/** Fixed sender identity — external contract C-09 (do not parameterize). */
export const MAIL_FROM = "VELORA TRADE <no-reply@veloratrade.ir>";

/**
 * Fixed reply-to identity — Legacy `Mailer::sendResend` set reply_to on every
 * request (@edede31 source-read 2026-10-06): 'no-reply@veloratrade.ir'.
 */
export const MAIL_REPLY_TO = "no-reply@veloratrade.ir";

/**
 * One CID-referenced inline image (Legacy `Mailer::sendWithInlineImages` →
 * Resend `attachments: [{filename, content, content_id}]`). The HTML body
 * references it as `cid:<cid>`.
 */
export interface MailInlineImage {
  /** CID used in the HTML body, e.g. "velora-logo". Max 127 chars (Legacy cap). */
  readonly cid: string;
  /** Attachment filename shown by the provider, e.g. "velora-logo.png". */
  readonly filename: string;
  /** File bytes, base64. Callers read the asset once and cache it. */
  readonly contentBase64: string;
}

export interface MailMessage {
  /** Recipient address (single recipient; transactional only). */
  readonly to: string;
  readonly subject: string;
  /** Plain-text body. Always required — never rely on HTML alone. */
  readonly text: string;
  /** Optional HTML alternative. */
  readonly html?: string;
  /**
   * Optional CID inline images for the HTML alternative (MG-EMAIL-TYPES:
   * Legacy's branded template ships its logo + per-type icon this way).
   * Adapters that cannot carry them (the log driver) simply record them.
   */
  readonly inlineImages?: readonly MailInlineImage[];
}

/**
 * Delivery outcome. Never throws for transport-level failure: callers decide
 * whether a failure is observable (it is not, for anti-enumeration flows).
 */
export type MailResult =
  | { readonly ok: true; readonly id: string | null }
  | { readonly ok: false; readonly reason: MailFailureReason };

export type MailFailureReason =
  /** Provider not configured (e.g. missing environment key) — fail closed. */
  | "not-configured"
  /** Provider reachable but rejected the request. */
  | "rejected"
  /** Network/timeout/unknown transport error. */
  | "transport-error";

export interface MailPort {
  /** Provider identity, for diagnostics only (never includes secrets). */
  readonly name: string;
  send(message: MailMessage): Promise<MailResult>;
}
