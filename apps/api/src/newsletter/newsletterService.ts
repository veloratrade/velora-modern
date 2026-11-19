// Newsletter service — Phase 3 feature (GAP-NL).
//
// Public subscribe: validate the email, then an idempotent insert. No real
// provider is wired yet — Resend is name-only in infra/env/.env.example, so
// live sends are fail-closed (capability absent → 503) rather than silently
// succeeding. A follow-up wires the provider behind the same store.
import type { NewsletterStore } from "./pgNewsletterStore.js";

export class NewsletterError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "NewsletterError";
  }
}

export interface SubscribeInput {
  email: string;
}

export class NewsletterService {
  constructor(readonly store: NewsletterStore) {}

  async subscribe(input: SubscribeInput): Promise<{ id: string }> {
    const email = String(input.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new NewsletterError(400, "VALIDATION_FAILED", "A valid email is required.");
    }
    return this.store.subscribe(email);
  }
}
