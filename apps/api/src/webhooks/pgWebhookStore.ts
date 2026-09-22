// PgWebhookEventStore — real-PostgreSQL adapter for webhook ingestion.
//
// Deduplication is resolved by the DATABASE, not by the application:
//   INSERT … ON CONFLICT (source, event_id) DO NOTHING RETURNING *
// and, when nothing was returned, a follow-up SELECT of the winning row. A
// concurrent duplicate therefore loses the insert race and reads the winner —
// exactly one row and exactly one projection, with no advisory lock and no
// read-then-write window.
//
// EVIDENCE: `db/tests/webhookEvents.pg.test.ts` (real disposable PostgreSQL via
// the postgres-evidence workflow; the battery is skipped locally when
// DATABASE_URL is absent, per the repository's D2/D3 convention).
import type { Pool } from "pg";
import { poolQuery, type QueryFn } from "../persistence/pg.js";
import type { WebhookEventRecord, WebhookEventStore, WebhookEventInsert } from "./webhookStore.js";

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}

/** jsonb comes back already parsed (pg driver default; D1 smoke S2). */
function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function mapRow(row: Row): WebhookEventRecord {
  return {
    id: str(row["id"]),
    source: str(row["source"]),
    eventId: str(row["event_id"]),
    payload: obj(row["payload"]),
    receivedAt: row["received_at"] instanceof Date ? (row["received_at"] as Date).toISOString() : str(row["received_at"]),
    processedAt:
      row["processed_at"] === null || row["processed_at"] === undefined
        ? null
        : row["processed_at"] instanceof Date
          ? (row["processed_at"] as Date).toISOString()
          : str(row["processed_at"]),
    signatureVerified: row["signature_verified"] === true,
    signatureAlgorithm: strOrNull(row["signature_algorithm"]),
  };
}

const COLUMNS =
  "id, source, event_id, payload, received_at, processed_at, signature_verified, signature_algorithm";

export class PgWebhookEventStore implements WebhookEventStore {
  private readonly q: QueryFn;

  constructor(pool: Pool) {
    this.q = poolQuery(pool);
  }

  async record(input: WebhookEventInsert): Promise<{ inserted: boolean; record: WebhookEventRecord }> {
    const inserted = await this.q(
      `INSERT INTO webhook_events (source, event_id, payload, signature_verified, signature_algorithm, signature_verified_at)
       VALUES ($1, $2, $3::jsonb, true, $4, $5)
       ON CONFLICT (source, event_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [input.source, input.eventId, JSON.stringify(input.payload), input.signatureAlgorithm, input.signatureVerifiedAt],
    );
    if (inserted.length > 0 && inserted[0] !== undefined) {
      return { inserted: true, record: mapRow(inserted[0]) };
    }
    const existing = await this.q(
      `SELECT ${COLUMNS} FROM webhook_events WHERE source = $1 AND event_id = $2`,
      [input.source, input.eventId],
    );
    const row = existing[0];
    if (row === undefined) {
      // Unreachable in practice: the conflict proves a row exists. Fail loudly
      // rather than fabricate a record.
      throw new Error("webhook event conflict without an existing row");
    }
    return { inserted: false, record: mapRow(row) };
  }

  async markProcessed(id: string): Promise<void> {
    await this.q("UPDATE webhook_events SET processed_at = now() WHERE id = $1 AND processed_at IS NULL", [id]);
  }

  async findById(id: string): Promise<WebhookEventRecord | null> {
    const rows = await this.q(`SELECT ${COLUMNS} FROM webhook_events WHERE id = $1`, [id]);
    const row = rows[0];
    return row === undefined ? null : mapRow(row);
  }
}
