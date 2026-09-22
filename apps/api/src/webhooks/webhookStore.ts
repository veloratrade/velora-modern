// WebhookEventStore — the persistence port for webhook ingestion.
//
// THE TABLE ALREADY EXISTS. `webhook_events` is in the frozen foundation
// (0001, extended by 0022): `source`, `event_id`, `payload` (jsonb),
// `received_at`, `processed_at`, `signature_verified`, `signature_algorithm`,
// `signature_verified_at`, a UNIQUE (source, event_id) constraint and a CHECK
// that verified rows carry a verification timestamp. No migration is needed and
// none is proposed: the ingestion capability maps onto the existing model.
//
// That UNIQUE constraint is the replay defence. Legacy implemented it in
// application code (`eventKey = sha256(metaapiId \0 eventType \0 material)` +
// a claim token). Here the DATABASE is the arbiter — one row per
// (source, event_id), enforced even across concurrent workers — which is
// strictly stronger and removes the claim/lease dance entirely.
export interface WebhookEventRecord {
  readonly id: string;
  readonly source: string;
  readonly eventId: string;
  readonly payload: Record<string, unknown>;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly signatureVerified: boolean;
  readonly signatureAlgorithm: string | null;
}

export interface WebhookEventInsert {
  readonly source: string;
  readonly eventId: string;
  readonly payload: Record<string, unknown>;
  readonly signatureAlgorithm: string;
  /** ISO-8601 instant the signature was verified (satisfies the 0022 CHECK). */
  readonly signatureVerifiedAt: string;
}

export interface WebhookEventStore {
  /**
   * Insert the event, deduplicating on (source, event_id).
   *
   * `inserted: false` means the event was already recorded — a replay. The
   * existing row is returned so the caller can answer without re-processing.
   * Implementations MUST be safe under concurrency: the decision belongs to the
   * UNIQUE constraint, never to a read-then-write in application code.
   */
  record(input: WebhookEventInsert): Promise<{ inserted: boolean; record: WebhookEventRecord }>;
  /** Mark the event as projected. Idempotent. */
  markProcessed(id: string): Promise<void>;
  findById(id: string): Promise<WebhookEventRecord | null>;
}
