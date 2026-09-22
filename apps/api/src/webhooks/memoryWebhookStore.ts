// In-memory WebhookEventStore — the deterministic test double.
//
// It mirrors the PostgreSQL adapter's CONTRACT (dedupe on (source, event_id),
// idempotent markProcessed, non-disclosing null on a miss) so a route/service
// test exercises the same decisions the database adapter makes. It is NOT
// evidence of database behaviour: the UNIQUE-constraint race is proven by
// `db/tests/webhookEvents.pg.test.ts` against a real server, per the
// repository's D2/D3 rule that a memory double never stands in for the engine.
import type { WebhookEventRecord, WebhookEventStore, WebhookEventInsert } from "./webhookStore.js";

export class MemoryWebhookEventStore implements WebhookEventStore {
  readonly #rows = new Map<string, WebhookEventRecord>();
  #seq = 0;
  private readonly now: () => Date;

  constructor(now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  private key(source: string, eventId: string): string {
    return `${source}\u0000${eventId}`;
  }

  async record(input: WebhookEventInsert): Promise<{ inserted: boolean; record: WebhookEventRecord }> {
    const key = this.key(input.source, input.eventId);
    const existing = this.#rows.get(key);
    if (existing !== undefined) return { inserted: false, record: existing };
    this.#seq += 1;
    const record: WebhookEventRecord = {
      id: String(this.#seq),
      source: input.source,
      eventId: input.eventId,
      payload: input.payload,
      receivedAt: this.now().toISOString(),
      processedAt: null,
      signatureVerified: true,
      signatureAlgorithm: input.signatureAlgorithm,
    };
    this.#rows.set(key, record);
    return { inserted: true, record };
  }

  async markProcessed(id: string): Promise<void> {
    for (const [key, row] of this.#rows) {
      if (row.id === id && row.processedAt === null) {
        this.#rows.set(key, { ...row, processedAt: this.now().toISOString() });
        return;
      }
    }
  }

  async findById(id: string): Promise<WebhookEventRecord | null> {
    for (const row of this.#rows.values()) if (row.id === id) return row;
    return null;
  }

  /** Test helper: number of distinct events recorded. */
  get size(): number {
    return this.#rows.size;
  }
}
