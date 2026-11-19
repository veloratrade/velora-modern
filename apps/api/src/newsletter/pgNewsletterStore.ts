// Newsletter store — Phase 3 feature (GAP-NL).
//
// Backed by `newsletter_subscriptions` (migration 0045). Fail-closed: driver
// errors propagate to the route layer, which maps them to RouteResult; the
// store never degrades to a silent success.
import type { QueryFn } from "../persistence/pg.js";

export interface NewsletterStore {
  /** Idempotent subscribe: insert or re-activate an email, return its id. */
  subscribe(email: string): Promise<{ id: string }>;
  subscribed(email: string): Promise<boolean>;
}

export class PgNewsletterStore implements NewsletterStore {
  constructor(private readonly q: QueryFn) {}

  async subscribe(email: string): Promise<{ id: string }> {
    const rows = await this.q(
      `INSERT INTO newsletter_subscriptions (email, status, source, subscribed_at, created_at)
       VALUES ($1, 'subscribed', 'web', now(), now())
       ON CONFLICT (email) DO UPDATE
         SET status = 'subscribed', subscribed_at = now()
       RETURNING id`,
      [email],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("newsletter subscribe returned no row");
    return { id: String(row.id) };
  }

  async subscribed(email: string): Promise<boolean> {
    const rows = await this.q(
      `SELECT 1 FROM newsletter_subscriptions WHERE email = $1 LIMIT 1`,
      [email],
    );
    return rows.length > 0;
  }
}
