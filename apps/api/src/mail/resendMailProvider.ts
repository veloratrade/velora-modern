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

import { MAIL_FROM, type MailMessage, type MailPort, type MailResult } from "./mailPort.js";

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
}

export class ResendMailProvider implements MailPort {
  readonly name = "resend";

  private readonly apiKey: string | undefined;
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;

  constructor(options: ResendMailProviderOptions) {
    const key = options.apiKey?.trim();
    this.apiKey = key === undefined || key === "" ? undefined : key;
    this.transport =
      options.transport ??
      ((url, init) =>
        fetch(url, init).then((r) => ({ status: r.status, text: () => r.text() })));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    };
    if (message.html !== undefined) payload["html"] = message.html;

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
