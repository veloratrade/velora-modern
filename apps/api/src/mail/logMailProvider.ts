// LogMailProvider — deterministic, offline MailPort adapter (Phase 3B-1).
//
// Purpose: development and isolated tests only. It records messages in memory
// so tests can assert on delivery WITHOUT a network call, a real key, or a
// live send. The boot gate (kernel/boot.ts) restricts memory-backed adapters
// to development; this provider is never the production path.
//
// SECURITY: it deliberately does NOT write message bodies to stdout. Reset and
// verification links are bearer-equivalent secrets — §7 forbids exposing reset
// tokens in logs. Tests read them from the in-memory outbox instead.

import type { MailMessage, MailPort, MailResult } from "./mailPort.js";

export class LogMailProvider implements MailPort {
  readonly name = "log";

  private readonly messages: MailMessage[] = [];

  async send(message: MailMessage): Promise<MailResult> {
    this.messages.push(message);
    return { ok: true, id: null };
  }

  /** All messages captured so far (test inspection). */
  get outbox(): readonly MailMessage[] {
    return this.messages;
  }

  /** Most recent message sent to `to`, or null. */
  lastTo(to: string): MailMessage | null {
    const normalized = to.trim().toLowerCase();
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m !== undefined && m.to.trim().toLowerCase() === normalized) return m;
    }
    return null;
  }

  clear(): void {
    this.messages.length = 0;
  }
}
