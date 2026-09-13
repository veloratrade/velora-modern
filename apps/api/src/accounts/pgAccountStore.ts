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
import { poolQuery, withTransaction, iso, type QueryFn } from "../persistence/pg.js";
import type { AccountStore, AccountRecord, AccountCreatePayload } from "./accountStore.js";
import { AccountQuotaExceededError } from "./accountStore.js";

interface AccountRow {
  id: string;
  user_id: string;
  provider: string;
  platform: string;
  label: string;
  account_number_masked: string;
  currency: string;
  leverage: string;
  timezone: string | null;
  timezone_source: string;
  status: string;
  sync_status: string;
  balance: string;
  equity: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapAccount(r: AccountRow): AccountRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    provider: r.provider as AccountRecord["provider"],
    platform: r.platform,
    label: r.label,
    accountNumber: r.account_number_masked,
    currency: r.currency,
    leverage: r.leverage,
    timezone: r.timezone,
    timezoneSource: r.timezone_source,
    status: r.status as AccountRecord["status"],
    syncStatus: r.sync_status as AccountRecord["syncStatus"],
    balance: Number(r.balance).toFixed(2),
    equity: Number(r.equity).toFixed(2),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
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
    return rows.map((r) => mapAccount(r as unknown as AccountRow));
  }

  async findByIdForUser(id: string, userId: string): Promise<AccountRecord | null> {
    const rows = await this.q("SELECT * FROM trading_accounts WHERE id = $1 AND user_id = $2", [
      id,
      userId,
    ]);
    return rows.length === 0 ? null : mapAccount(rows[0] as unknown as AccountRow);
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
    return mapAccount(row as unknown as AccountRow);
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
      return mapAccount(row as unknown as AccountRow);
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
    return rows.length === 0 ? null : mapAccount(rows[0] as unknown as AccountRow);
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    // PostgreSQL-specific: rowCount is the reliable deleted/not-deleted signal.
    const res = await this.pool.query(
      "DELETE FROM trading_accounts WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
