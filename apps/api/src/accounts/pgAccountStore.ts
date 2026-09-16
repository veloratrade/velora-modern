// PgAccountStore — Phase D D2: the real-PostgreSQL AccountStore adapter
// (direct pg). SQL contract is the PGlite-evidenced implementation from
// db/tests/accountPersistence.test.ts (behavioral guidance per the D2 rule),
// with one PostgreSQL-specific divergence: deleteForUser returns a real
// boolean from the DELETE's rowCount (pg exposes it reliably) instead of the
// PGlite test adapter's always-true placeholder — the port contract says
// Promise<boolean>. D3 adds createWithQuotaGuard: the transactional quota
// guard (users-row FOR UPDATE + count + insert in ONE transaction) — the
// Remote production mechanism, implemented on direct pg.
//
// EVIDENCE: adapter battery = db/tests/pgAccountStore.pg.test.ts, executed
// only against a real disposable PostgreSQL (postgres-evidence workflow).
// Ownership isolation stays SQL-level: every read/write is keyed by
// (id, user_id) — a miss is indistinguishable from "not yours" (non-disclosing
// 404 mapping happens in AccountService).
import type { Pool } from "pg";
import { poolQuery, withTransaction, iso, isUniqueViolation, type QueryFn } from "../persistence/pg.js";
import type {
  AccountStore, AccountRecord, AccountCreatePayload,
  AccountProvider, AccountStatus, SyncStatus,
} from "./accountStore.js";
import { AccountQuotaExceededError, AccountBindingConflictError } from "./accountStore.js";

/**
 * A row exactly as the driver hands it back (AUD-04).
 *
 * `QueryFn` yields `Record<string, unknown>`, so the mapper takes that shape
 * directly and narrows each column itself. This deliberately avoids the
 * `as unknown as <RowInterface>` idiom: a double cast asserts a shape nothing
 * checks, which is precisely how a schema/mapper drift survives typechecking.
 * Same approach as `pgProvisioningStore.mapOperation`.
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
 * Narrow a NOT NULL timestamptz. node-postgres returns a `Date` by default but
 * a string when date parsing is overridden, so both are accepted and anything
 * else is a real defect rather than something to coerce silently.
 */
function ts(v: unknown): Date | string {
  if (v instanceof Date || typeof v === "string") return v;
  throw new Error("trading_accounts timestamp column is neither Date nor string");
}

/**
 * Validate a value against a closed vocabulary that the database already
 * enforces with a CHECK constraint. Validated rather than asserted: if a future
 * migration widens the constraint without updating the union here, the failure
 * surfaces as a loud, precise error instead of an invalid value flowing
 * silently into the domain. Carries no row data into the message.
 */
function oneOf<T extends string>(v: unknown, allowed: readonly T[], column: string): T {
  const s = str(v);
  const found = allowed.find((k) => k === s);
  if (found === undefined) {
    throw new Error(`trading_accounts.${column} has an unknown value: ${s}`);
  }
  return found;
}

const PROVIDERS: readonly AccountProvider[] = ["MT4", "MT5", "MANUAL"];
const STATUSES: readonly AccountStatus[] = ["connected", "error", "disconnected"];
const SYNC_STATUSES: readonly SyncStatus[] = [
  "DISCONNECTED", "CONNECTING", "SYNCING", "CONNECTED", "ERROR",
];

function mapAccount(r: Row): AccountRecord {
  return {
    id: str(r.id),
    userId: str(r.user_id),
    provider: oneOf(r.provider, PROVIDERS, "provider"),
    platform: str(r.platform),
    label: str(r.label),
    accountNumber: str(r.account_number_masked),
    currency: str(r.currency),
    leverage: str(r.leverage),
    timezone: strOrNull(r.timezone),
    timezoneSource: str(r.timezone_source),
    status: oneOf(r.status, STATUSES, "status"),
    syncStatus: oneOf(r.sync_status, SYNC_STATUSES, "sync_status"),
    balance: Number(r.balance).toFixed(2),
    equity: Number(r.equity).toFixed(2),
    createdAt: iso(ts(r.created_at)),
    updatedAt: iso(ts(r.updated_at)),
  };
}

export class PgAccountStore implements AccountStore {
  private readonly q: QueryFn;

  constructor(private readonly pool: Pool) {
    this.q = poolQuery(pool);
  }

  async listByUser(userId: string): Promise<AccountRecord[]> {
    const rows = await this.q(
      "SELECT * FROM trading_accounts WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map((r) => mapAccount(r));
  }

  async findByIdForUser(id: string, userId: string): Promise<AccountRecord | null> {
    const rows = await this.q("SELECT * FROM trading_accounts WHERE id = $1 AND user_id = $2", [
      id,
      userId,
    ]);
    return rows.length === 0 ? null : mapAccount(rows[0]!);
  }

  async countByUser(userId: string): Promise<number> {
    const rows = await this.q(
      "SELECT COUNT(*)::int AS n FROM trading_accounts WHERE user_id = $1",
      [userId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async create(
    userId: string,
    input: {
      provider: AccountRecord["provider"];
      platform: string;
      label: string;
      accountNumber: string;
      currency: string;
      leverage: string;
      timezone: string | null;
      timezoneSource: string;
      status: AccountRecord["status"];
    },
    now: Date,
  ): Promise<AccountRecord> {
    const rows = await this.q(
      `INSERT INTO trading_accounts
         (user_id, provider, platform, label, account_number_masked, currency, leverage, timezone, timezone_source, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
      [
        userId,
        input.provider,
        input.platform,
        input.label,
        input.accountNumber,
        input.currency,
        input.leverage,
        input.timezone,
        input.timezoneSource,
        input.status,
        now,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("create: INSERT returned no row");
    return mapAccount(row);
  }

  async createWithQuotaGuard(
    userId: string,
    input: AccountCreatePayload,
    now: Date,
    maxTradingAccounts: number,
  ): Promise<AccountRecord> {
    return withTransaction(this.pool, async (q) => {
      // D3: the users-row lock IS the per-user quota mutex — concurrent creators
      // for the same user serialize here (cross-process correct; FOR UPDATE
      // blocking on real PG proven by postgres-evidence smoke S7). A missing
      // user surfaces through the INSERT's FK (23503), identical to create().
      await q("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const countRows = await q(
        "SELECT COUNT(*)::int AS n FROM trading_accounts WHERE user_id = $1",
        [userId],
      );
      const count = Number(countRows[0]?.n ?? 0);
      if (count >= maxTradingAccounts) {
        // withTransaction rolls back — nothing mutated, lock released.
        throw new AccountQuotaExceededError(count);
      }
      const rows = await q(
        `INSERT INTO trading_accounts
           (user_id, provider, platform, label, account_number_masked, currency, leverage, timezone, timezone_source, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [
          userId,
          input.provider,
          input.platform,
          input.label,
          input.accountNumber,
          input.currency,
          input.leverage,
          input.timezone,
          input.timezoneSource,
          input.status,
          now,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error("createWithQuotaGuard: INSERT returned no row");
      return mapAccount(row);
    });
  }

  async updateTimezone(
    id: string,
    userId: string,
    timezone: string | null,
    timezoneSource: string,
    now: Date,
  ): Promise<AccountRecord | null> {
    const rows = await this.q(
      `UPDATE trading_accounts SET timezone = $1, timezone_source = $2, updated_at = $3
       WHERE id = $4 AND user_id = $5 RETURNING *`,
      [timezone, timezoneSource, now, id, userId],
    );
    return rows.length === 0 ? null : mapAccount(rows[0]!);
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    // PostgreSQL-specific: rowCount is the reliable deleted/not-deleted signal.
    const res = await this.pool.query(
      "DELETE FROM trading_accounts WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * OD-MP-1: bind a provider account id to an OWNED Velora account.
   *
   * The `metaapi_account_id IS NULL` predicate (when expectUnbound) is the
   * compare-and-set: two concurrent binders both pass application checks, but
   * only one satisfies the WHERE clause, and the loser updates zero rows. The
   * global partial UNIQUE index is the second, independent guarantee — it
   * fires as 23505 even for two DIFFERENT accounts racing for one provider id.
   */
  async bindMetaApiAccount(
    id: string,
    userId: string,
    binding: string,
    now: Date,
    expectUnbound: boolean,
    tx?: QueryFn,
  ): Promise<AccountRecord | null> {
    const run = tx ?? this.q;
    const guard = expectUnbound
      ? "AND metaapi_account_id IS NULL"
      : // Reconciliation may re-assert the SAME id; it may never silently
        // replace a different one.
        "AND (metaapi_account_id IS NULL OR metaapi_account_id = $3)";
    try {
      const rows = await run(
        `UPDATE trading_accounts
            SET metaapi_account_id = $3, updated_at = $4
          WHERE id = $1 AND user_id = $2 ${guard}
        RETURNING *`,
        [id, userId, binding, now],
      );
      return rows.length === 0 ? null : mapAccount(rows[0]!);
    } catch (err) {
      // The UNIQUE index is global by design (OD-MP-1 / migration 0013): one
      // MetaAPI account can back exactly one Velora account, across all users.
      if (isUniqueViolation(err, "trading_accounts_metaapi_unique")) {
        throw new AccountBindingConflictError();
      }
      throw err;
    }
  }

  /**
   * OD-MP-3 A: clear the binding. Returns the PREVIOUS value for the audit
   * trail. No trade, trade event, P/L value or timestamp is touched — this
   * statement's entire footprint is two columns on one row.
   */
  async unbindMetaApiAccount(
    id: string,
    userId: string,
    now: Date,
    tx?: QueryFn,
  ): Promise<string | null> {
    const run = tx ?? this.q;
    // A CTE captures the PRIOR value explicitly. `RETURNING` alone would give
    // the new (NULL) value, and a subquery in RETURNING would depend on
    // snapshot subtleties; `FOR UPDATE` also serializes two concurrent
    // unbinders so only one observes a non-NULL previous binding.
    const rows = await run(
      `WITH prev AS (
         SELECT id, metaapi_account_id
           FROM trading_accounts
          WHERE id = $1 AND user_id = $2 AND metaapi_account_id IS NOT NULL
          FOR UPDATE
       )
       UPDATE trading_accounts t
          SET metaapi_account_id = NULL, updated_at = $3
         FROM prev
        WHERE t.id = prev.id
       RETURNING prev.metaapi_account_id AS previous`,
      [id, userId, now],
    );
    const row = rows[0] as { previous?: string | null } | undefined;
    return row?.previous ?? null;
  }

  async getMetaApiBinding(id: string, userId: string): Promise<string | null> {
    const rows = await this.q(
      "SELECT metaapi_account_id FROM trading_accounts WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    const row = rows[0] as { metaapi_account_id?: string | null } | undefined;
    return row?.metaapi_account_id ?? null;
  }
}
