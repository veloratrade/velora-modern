// In-memory AuditStore (tests and local development).
//
// Mirrors the database contract: append-only, newest-first reads, and no way to
// mutate an existing record. `list()` returns copies so a caller cannot reach
// back into stored state and edit it — the array is frozen per record, which is
// the in-memory equivalent of the REVOKE UPDATE/DELETE grid in db/roles.sql.
import type { AuditEntry, AuditRecord, AuditStore, AuditTx } from "./auditStore.js";

export class MemoryAuditStore implements AuditStore {
  private readonly records: AuditRecord[] = [];
  private seq = 0;

  // `tx` is accepted for port compatibility and ignored: there is no database
  // to enlist in. MemoryUserStore performs the mutation and this append inside
  // the same synchronous block, which is the in-memory equivalent of atomicity.
  async append(entry: AuditEntry, _tx?: AuditTx): Promise<AuditRecord> {
    this.seq += 1;
    const record: AuditRecord = Object.freeze({
      id: String(this.seq),
      action: entry.action,
      actorUserId: entry.actorUserId,
      targetUserId: entry.targetUserId,
      beforeState: entry.beforeState,
      afterState: entry.afterState,
      // Same defaulting as the PG adapter, so the two cannot drift: an omitted
      // outcome is a success and non-credential events carry no metadata.
      outcome: entry.outcome ?? "success",
      requestId: entry.requestId,
      occurredAt: entry.occurredAt.toISOString(),
      credentialId: entry.credentialId ?? null,
      provider: entry.provider ?? null,
      // OD-MP-2: same defaulting as the PG adapter so the two cannot drift.
      tradingAccountId: entry.tradingAccountId ?? null,
    });
    this.records.push(record);
    return record;
  }

  async list(): Promise<readonly AuditRecord[]> {
    // Newest-first, matching the PG adapter's ORDER BY.
    return [...this.records].reverse();
  }
}
