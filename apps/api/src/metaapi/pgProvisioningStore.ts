// PgProvisioningStore — the real-PostgreSQL ProvisioningStore adapter (OD-MP-1).
//
// CONCURRENCY IS ENFORCED BY THE DATABASE, NOT BY APPLICATION CHECKS.
// `reserve` is a single INSERT ... ON CONFLICT DO NOTHING followed by a read,
// so two simultaneous requests for the same operation key converge on one row
// across processes. A "SELECT then INSERT if absent" in application code
// cannot make that guarantee.
import type { Pool } from "pg";
import { isUniqueViolation, poolQuery, iso, type QueryFn } from "../persistence/pg.js";
import type {
  ProvisioningOperation,
  ProvisioningReserveInput,
  ProvisioningStatus,
  ProvisioningStore,
} from "./provisioningStore.js";

/**
 * A row exactly as the driver hands it back. `QueryFn` yields
 * `Record<string, unknown>`, so the mapper takes that shape directly and
 * narrows each column itself. This deliberately avoids the
 * `as unknown as <RowInterface>` idiom: a double cast asserts a shape nothing
 * checks, which is precisely how a schema/mapper drift survives typechecking.
 * Here every field passes through an explicit conversion instead.
 */
type Row = Record<string, unknown>;

/** Narrow a NOT NULL text column. */
function str(v: unknown): string {
  return typeof v === "string" ? v : String(v);
}

/** Narrow a nullable text column, preserving SQL NULL as `null`. */
function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}

/**
 * Narrow a NOT NULL timestamptz. node-postgres returns a `Date` by default,
 * but a string when date parsing is overridden, so both are accepted and
 * anything else is a real defect rather than something to coerce silently.
 */
function ts(v: unknown): Date | string {
  if (v instanceof Date || typeof v === "string") return v;
  throw new Error("provisioning_operations timestamp column is neither Date nor string");
}

/**
 * `status` is a closed vocabulary enforced by the 0014 CHECK constraint. It is
 * validated rather than asserted: if a future migration widens the constraint
 * without updating this union, the failure surfaces here as a loud, precise
 * error instead of an invalid value flowing silently into the domain.
 */
const STATUSES: readonly ProvisioningStatus[] = [
  "PENDING", "ACCEPTED", "COMPLETED", "AMBIGUOUS", "FAILED",
];

function toStatus(v: unknown): ProvisioningStatus {
  const s = str(v);
  const found = STATUSES.find((k) => k === s);
  if (found === undefined) {
    // No provider data and no secret can reach this message: `status` is a
    // Velora-internal enum written only by this store.
    throw new Error(`provisioning_operations.status has an unknown value: ${s}`);
  }
  return found;
}

function mapOperation(r: Row): ProvisioningOperation {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    accountId: str(r.account_id),
    operationKey: str(r.operation_key),
    providerMarker: str(r.provider_marker),
    transactionId: strOrNull(r.transaction_id),
    status: toStatus(r.status),
    providerAccountId: strOrNull(r.provider_account_id),
    lastErrorCode: strOrNull(r.last_error_code),
    attempts: Number(r.attempts),
    createdAt: iso(ts(r.created_at)),
    updatedAt: iso(ts(r.updated_at)),
  };
}

export class PgProvisioningStore implements ProvisioningStore {
  private readonly q: QueryFn;

  constructor(pool: Pool) {
    this.q = poolQuery(pool);
  }

  async reserve(
    input: ProvisioningReserveInput,
  ): Promise<{ operation: ProvisioningOperation; created: boolean }> {
    // ON CONFLICT DO NOTHING returns zero rows when the operation already
    // exists — that is the signal that this caller is a duplicate, and it is
    // produced by the UNIQUE index rather than by a racy pre-check.
    //
    // WHY THE try/catch IS REQUIRED (defect found by the pass-2 evidence sweep).
    // `provisioning_operations` carries TWO unique indexes: (user_id,
    // operation_key) — the arbiter named below — and `provider_marker`. An
    // `ON CONFLICT` clause only absorbs a violation of the index it names; a
    // violation of any OTHER unique index aborts the statement with 23505. Two
    // concurrent reserves that carry the same operation AND the same marker (the
    // normal case: a retried request) can therefore race into a 23505 on
    // `provider_marker` instead of converging — and whether that happens depends
    // on which index the insertion path reports first, i.e. it is TIMING
    // DEPENDENT. It surfaced as an intermittent failure of the D-"concurrency:
    // two simultaneous reserves converge on ONE operation" battery: green on
    // three consecutive isolated runs, red in two full-suite sweeps.
    //
    // The recovery is the SAME one the zero-row case already uses (read the row
    // back and report created=false) — never an invented value. A 23505 that is
    // NOT accompanied by a readable existing row is rethrown, so a genuine
    // duplicate cannot be silently swallowed here.
    let inserted;
    try {
      inserted = await this.q(
        `INSERT INTO provisioning_operations
           (user_id, account_id, operation_key, provider_marker, transaction_id,
            status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$6)
         ON CONFLICT (user_id, operation_key) DO NOTHING
         RETURNING *`,
        [
          input.userId,
          input.accountId,
          input.operationKey,
          input.providerMarker,
          input.transactionId,
          input.now,
        ],
      );
    } catch (err) {
      if (!isUniqueViolation(err, "provisioning_operations")) throw err;
      const raced = await this.findByKey(input.userId, input.operationKey);
      if (raced === null) throw err;
      return { operation: raced, created: false };
    }
    const row = inserted[0];
    if (row !== undefined) {
      return { operation: mapOperation(row), created: true };
    }

    const existing = await this.findByKey(input.userId, input.operationKey);
    if (existing === null) {
      // The row conflicted a moment ago and is not readable now. Do not invent
      // a recovery: another transaction owns this operation.
      throw new Error("reserve: operation conflicted but could not be read");
    }
    return { operation: existing, created: false };
  }

  async findByKey(userId: string, operationKey: string): Promise<ProvisioningOperation | null> {
    const rows = await this.q(
      `SELECT * FROM provisioning_operations WHERE user_id = $1 AND operation_key = $2`,
      [userId, operationKey],
    );
    const row = rows[0];
    return row === undefined ? null : mapOperation(row);
  }

  async markStatus(
    id: string,
    status: ProvisioningStatus,
    now: Date,
    fields: {
      providerAccountId?: string | undefined;
      lastErrorCode?: string | undefined;
      incrementAttempts?: boolean | undefined;
    } = {},
    tx?: QueryFn,
  ): Promise<void> {
    const run = tx ?? this.q;
    // COALESCE keeps a previously recorded provider account id and error code:
    // evidence of what the provider did is never erased by a later attempt.
    await run(
      `UPDATE provisioning_operations
          SET status = $1,
              provider_account_id = COALESCE($2, provider_account_id),
              last_error_code     = COALESCE($3, last_error_code),
              attempts            = attempts + $4,
              updated_at          = $5
        WHERE id = $6`,
      [
        status,
        fields.providerAccountId ?? null,
        fields.lastErrorCode ?? null,
        fields.incrementAttempts === true ? 1 : 0,
        now,
        id,
      ],
    );
  }
}
