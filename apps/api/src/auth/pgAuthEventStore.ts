// PgAuthEventStore — the real-PostgreSQL AuthEventStore adapter (SEC-03).
//
// Append-only by construction: this adapter issues INSERT and SELECT only. It
// contains no UPDATE, no DELETE and no TRUNCATE statement, and db/roles.sql
// REVOKEs those privileges from the runtime roles as an independent second
// layer.
//
// WRITE POLICY (fail open, by contract): `record()` catches its own failure and
// reports it through `lastWriteError()` instead of throwing. Authentication has
// already been decided when the recorder is called; a history write must never
// turn a valid login into an error, and must never turn an invalid login into
// something else either. Legacy stated the same policy in AuthEventRepository.
import type { Pool } from "pg";
import { poolQuery } from "../persistence/pg.js";
import {
  clampPagination,
  normalizeAuthEvent,
  type AuthEventInput,
  type AuthEventPage,
  type AuthEventRecord,
  type AuthEventResult,
  type AuthEventStore,
} from "./authEventStore.js";

interface AuthEventRow {
  id: string | number;
  occurred_at: Date | string;
  user_id: string | number | null;
  event_type: string;
  result: string;
  reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

/** timestamptz → ISO-8601 UTC string. Mirrors the house `iso()` helper. */
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapEvent(r: AuthEventRow): AuthEventRecord {
  return {
    id: String(r.id),
    occurredAt: iso(r.occurred_at),
    userId: r.user_id === null ? null : String(r.user_id),
    eventType: r.event_type as AuthEventRecord["eventType"],
    result: r.result as AuthEventResult,
    reason: r.reason,
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
  };
}

export class PgAuthEventStore implements AuthEventStore {
  private readonly q: ReturnType<typeof poolQuery>;
  private writeError: unknown = null;

  constructor(pool: Pool) {
    this.q = poolQuery(pool);
  }

  async record(input: AuthEventInput): Promise<void> {
    const e = normalizeAuthEvent(input);
    try {
      const columns = ["user_id", "event_type", "result", "reason", "ip_address", "user_agent"];
      const params: unknown[] = [e.userId, e.eventType, e.result, e.reason, e.ipAddress, e.userAgent];
      // occurred_at is set by the DATABASE default unless a clock was injected
      // (tests pin it; nothing else does), so the column list stays explicit.
      if (input.occurredAt !== undefined) {
        columns.push("occurred_at");
        params.push(input.occurredAt);
      }
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      await this.q(
        `INSERT INTO auth_events (${columns.join(", ")}) VALUES (${placeholders})`,
        params,
      );
    } catch (err) {
      // Fail open — see the header. The error is kept for observability/tests,
      // never rethrown into an authentication path.
      this.writeError = err;
      console.error(
        JSON.stringify({
          level: "error",
          service: "api",
          event: "auth_event_write_failed",
          // The code only: never the statement, the parameters or the address.
          message: err instanceof Error ? err.message : "unknown error",
        }),
      );
    }
  }

  async listForUser(
    userId: string,
    opts?: { readonly page?: number; readonly perPage?: number; readonly result?: AuthEventResult },
  ): Promise<AuthEventPage> {
    const { page, perPage } = clampPagination(opts);
    const resultFilter = opts?.result;

    const totalRows = await this.q(
      resultFilter === undefined
        ? `SELECT COUNT(*)::text AS n FROM auth_events WHERE user_id = $1`
        : `SELECT COUNT(*)::text AS n FROM auth_events WHERE user_id = $1 AND result = $2`,
      resultFilter === undefined ? [userId] : [userId, resultFilter],
    );
    const total = Number(totalRows[0]?.n ?? "0");

    const rows = await this.q(
      resultFilter === undefined
        ? `SELECT id, occurred_at, user_id, event_type, result, reason, ip_address, user_agent
             FROM auth_events WHERE user_id = $1
            ORDER BY occurred_at DESC, id DESC
            LIMIT $2 OFFSET $3`
        : `SELECT id, occurred_at, user_id, event_type, result, reason, ip_address, user_agent
             FROM auth_events WHERE user_id = $1 AND result = $2
            ORDER BY occurred_at DESC, id DESC
            LIMIT $3 OFFSET $4`,
      resultFilter === undefined
        ? [userId, perPage, (page - 1) * perPage]
        : [userId, resultFilter, perPage, (page - 1) * perPage],
    );

    return { events: rows.map((r) => mapEvent(r as unknown as AuthEventRow)), total, page, perPage };
  }

  lastWriteError(): unknown {
    return this.writeError;
  }
}
