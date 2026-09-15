// PgAuditStore — the real-PostgreSQL AuditStore adapter (C-34).
//
// Append-only by construction: this adapter issues INSERT and SELECT only. It
// has no UPDATE and no DELETE statement anywhere, and db/roles.sql REVOKEs
// those privileges from the runtime roles as a second, independent layer.
//
// The adapter accepts an optional QueryFn so a caller can enlist the append in
// an EXISTING transaction (the pgTradeStore mutation+event convention). When no
// QueryFn is supplied it runs on the pool and autocommits.
import type { Pool } from "pg";
import { poolQuery, iso, type QueryFn } from "../persistence/pg.js";
import type {
  AuditAction,
  AuditEntry,
  AuditOutcome,
  AuditProvider,
  AuditRecord,
  AuditStore,
  AuditTx,
} from "./auditStore.js";

interface AuditRow {
  id: string | number;
  action: string;
  actor_user_id: string | number;
  target_user_id: string | number | null;
  before_state: string | null;
  after_state: string | null;
  outcome: string;
  request_id: string | null;
  occurred_at: Date | string;
  credential_id: string | number | null;
  provider: string | null;
}

function mapAudit(r: AuditRow): AuditRecord {
  return {
    id: String(r.id),
    action: r.action as AuditAction,
    actorUserId: String(r.actor_user_id),
    targetUserId: r.target_user_id === null ? null : String(r.target_user_id),
    beforeState: r.before_state,
    afterState: r.after_state,
    outcome: r.outcome as AuditOutcome,
    requestId: r.request_id,
    occurredAt: iso(r.occurred_at),
    credentialId: r.credential_id === null ? null : String(r.credential_id),
    provider: r.provider === null ? null : (r.provider as AuditProvider),
  };
}

const INSERT_SQL = `INSERT INTO audit_log
    (action, actor_user_id, target_user_id, before_state, after_state, request_id, occurred_at,
     outcome, credential_id, provider)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  RETURNING *`;

export class PgAuditStore implements AuditStore {
  private readonly q: QueryFn;

  constructor(pool: Pool) {
    this.q = poolQuery(pool);
  }

  /**
   * Append. Pass `q` to enlist in an existing transaction so the audit row and
   * the business mutation commit or roll back together; omit it to autocommit.
   * Errors propagate — never swallowed.
   */
  async append(entry: AuditEntry, tx?: AuditTx): Promise<AuditRecord> {
    const run = tx ?? this.q;
    const rows = await run(INSERT_SQL, [
      entry.action,
      entry.actorUserId,
      entry.targetUserId,
      entry.beforeState,
      entry.afterState,
      entry.requestId,
      entry.occurredAt,
      // Defaults keep every pre-B-2 call site byte-identical in behaviour:
      // an omitted outcome is a success, and non-credential events carry no
      // credential metadata.
      entry.outcome ?? "success",
      entry.credentialId ?? null,
      entry.provider ?? null,
    ]);
    const row = rows[0];
    if (row === undefined) throw new Error("audit append: INSERT returned no row");
    return mapAudit(row as unknown as AuditRow);
  }

  async list(): Promise<readonly AuditRecord[]> {
    const rows = await this.q("SELECT * FROM audit_log ORDER BY occurred_at DESC, id DESC", []);
    return rows.map((r) => mapAudit(r as unknown as AuditRow));
  }
}
