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

export interface MailMessage {
  /** Recipient address (single recipient; transactional only). */
  readonly to: string;
  readonly subject: string;
  /** Plain-text body. Always required — never rely on HTML alone. */
  readonly text: string;
  /** Optional HTML alternative. */
  readonly html?: string;
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
