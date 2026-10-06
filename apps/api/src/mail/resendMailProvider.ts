// ResendMailProvider — Resend HTTPS transport adapter (Phase 3B-1, OD-12).
//
// Behavioral reference: Legacy api/src/Core/Mailer.php (VERIFIED)
//   - endpoint: https://api.resend.com/emails
//   - auth:     Authorization: Bearer <RESEND_API_KEY>
//   - from:     'VELORA TRADE <no-reply@veloratrade.ir>'  (C-09 identity)
//   - the Legacy mailer redacts `Bearer <token>` before logging; this adapter
//     goes further and never logs request material at all.
//
// OD-12 compliance: Resend remains the only real provider. No SMTP adapter and
// no alternative provider is introduced here.
//
// SECRET HANDLING (§7): the API key is read from the environment at
// construction time and is never written to the repository, a log line, an
// error message, or a MailResult. When the key is absent the adapter FAILS
// CLOSED with reason "not-configured" — it never falls back to another
// transport and never silently drops mail.

import {
  MAIL_FROM,
  MAIL_REPLY_TO,
  type MailMessage,
  type MailPort,
  type MailResult,
} from "./mailPort.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Injectable transport so tests exercise this adapter with no network. */
export interface HttpTransport {
  (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal?: AbortSignal;
    },
  ): Promise<{ status: number; text(): Promise<string> }>;
}

export interface ResendMailProviderOptions {
  /** Resend API key. Supply from the environment — never a literal. */
  readonly apiKey: string | undefined;
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  /**
   * Frontend origin for the RFC 2369 List-Unsubscribe header (BUG-A9 in
   * Legacy, set at the Mailer level on EVERY send). No trailing slash.
   * Defaults to the Legacy default origin when unset.
   */
  readonly appOrigin?: string;
}

export class ResendMailProvider implements MailPort {
  readonly name = "resend";

  private readonly apiKey: string | undefined;
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly appOrigin: string;

  constructor(options: ResendMailProviderOptions) {
    const key = options.apiKey?.trim();
    this.apiKey = key === undefined || key === "" ? undefined : key;
    this.transport =
      options.transport ??
      ((url, init) =>
        fetch(url, init).then((r) => ({ status: r.status, text: () => r.text() })));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Legacy listUnsubscribeValue(): FRONTEND_URL env, default veloratrade.ir.
    this.appOrigin = (options.appOrigin ?? "https://veloratrade.ir").replace(/\/+$/, "");
  }

  /** True when an API key is present. Never reveals the key itself. */
  get configured(): boolean {
    return this.apiKey !== undefined;
  }

  async send(message: MailMessage): Promise<MailResult> {
    if (this.apiKey === undefined) {
      // Fail closed: no key → no send, no fallback transport.
      return { ok: false, reason: "not-configured" };
    }

    const payload: Record<string, unknown> = {
      from: MAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      // Legacy Mailer::sendResend set both of these on EVERY request:
      reply_to: MAIL_REPLY_TO,
      // BUG-A9 (Legacy): RFC 2369 one-click unsubscribe/manage-preferences.
      headers: {
        "List-Unsubscribe":
          `<mailto:support@veloratrade.ir?subject=unsubscribe>, ` +
          `<${this.appOrigin}/profile?focus=email-preferences>`,
      },
    };
    if (message.html !== undefined) payload["html"] = message.html;
    if (message.inlineImages !== undefined && message.inlineImages.length > 0) {
      // Legacy: attachments[] with base64 content + content_id; the HTML
      // references cid:<content_id>. Over-length CIDs are truncated to 127
      // exactly like Legacy (mb_substr).
      payload["attachments"] = message.inlineImages.map((img) => ({
        filename: img.filename,
        content: img.contentBase64,
        content_id: img.cid.slice(0, 127),
      }));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.transport(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          // The only place the key is used. Never logged, never returned.
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (res.status >= 200 && res.status < 300) {
        let id: string | null = null;
        try {
          const parsed: unknown = JSON.parse(await res.text());
          if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
            const raw = (parsed as { id: unknown }).id;
            if (typeof raw === "string") id = raw;
          }
        } catch {
          id = null; // a 2xx with an unparsable body is still a successful send
        }
        return { ok: true, id };
      }
      // Provider error bodies can echo request material — never surface them.
      return { ok: false, reason: "rejected" };
    } catch {
      return { ok: false, reason: "transport-error" };
    } finally {
      clearTimeout(timer);
    }
  }
}
