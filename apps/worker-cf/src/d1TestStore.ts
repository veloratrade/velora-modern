/**
 * D1 (SQLite) storage for PRIVATE TEST MODE — the minimum the owner asked for, and nothing else:
 *
 *   1. record that an update was delivered,  2. decide atomically whether it is a redelivery,
 *   3. mark its terminal outcome,             4. read the test message back.
 *
 * Why this file exists instead of a port of `PgTelegramStore`: that store (507 lines in
 * `apps/api/src/telegram/pgTelegramStore.ts`) issues 86 `::` casts, 5 `jsonb` payloads, 15
 * `RETURNING` clauses and 99 `$n` placeholders across seven tables, and `PgTradeStore` (552
 * lines) adds three `FOR UPDATE` row locks inside the ledger's optimistic-version transaction.
 * None of that is a translation away — it is the shape of a relational ledger. D1 is SQLite, so
 * the honest options were "rewrite the whole data layer for a second dialect" or "give the test
 * mode its own small store". The second is what private testing needs, and the first would put
 * untested SQL in the path of real trade data.
 *
 * What is deliberately NOT here: no `trades`, no `trade_events`, no `audit_log`, no
 * `telegram_journal_drafts`, no `ai_coaching_logs`. The tables do not exist, so nothing can write
 * trade data into D1, and D1 cannot be mistaken for Velora's database. Trading, journaling,
 * linking and AI stay on PostgreSQL (`DB_MODE=hyperdrive`), and `index.ts` refuses to serve them
 * while this store is the active one — see `storageMode`.
 */

/** The part of `D1Database` this module uses. Kept structural so a test can drive it for real. */
export interface D1Prepared {
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
  all(): Promise<{ results: unknown[] }>;
}
export interface D1Like {
  prepare(query: string): { bind: (...values: unknown[]) => D1Prepared };
}

/** What one `claim()` call decided, including which attempt this is (see `CLAIM_SQL`). */
export interface ClaimResult {
  readonly claimed: boolean;
  readonly attempt: number;
}

export type TestUpdateKind = "message" | "callback_query" | "edited_message";

export interface TestUpdateRecord {
  updateId: number;
  senderId: number;
  chatId: number | null;
  kind: TestUpdateKind;
  /** Truncated, and only ever the owner's own text: this is a private store, not a logger. */
  textExcerpt: string | null;
  /** Optional: the caller may pass raw text and let the store flatten and cap it. */
}

/** SQLite has no `now()` returning a timestamptz; this is the dialect's own clock expression. */
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** Cap the stored text: enough to prove retrieval, never a transcript of a whole conversation. */
export const MAX_EXCERPT = 400;

export const excerptOf = (text: string | null | undefined): string | null => {
  if (text === null || text === undefined) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT)}…` : flat;
};

/**
 * The claim, in one statement, with three outcomes and no read-modify-write in between:
 *
 *   fresh `update_id`      → the insert wins, `RETURNING` yields the row, `attempt = 1`
 *   redelivery of a row that is `claimed` or `handled` → the `WHERE` rejects the update, so the
 *                            result set is empty: "already somebody else's work", answer duplicate
 *   redelivery of a row that is `failed` → re-claimed, `attempt + 1`, error fields cleared
 *
 * The third branch is the reason `attempt` (migration 0002) exists. With a bare
 * `ON CONFLICT DO NOTHING`, a row that ended `failed` was indistinguishable from a row that ended
 * `handled` to the next delivery: the retry got `duplicate`, the answer was 200, Telegram stopped
 * redelivering — and the update was lost permanently while the store still said "processed". That
 * is the failure mode this file's own comment claims to avoid, and it was real until measured:
 * 5xx-after-claim is exactly what Telegram retries.
 *
 * Measured on the live remote D1 (`attempt` column, 2026-10-18): winner `changes:1` + one returned
 * row; redelivery while `claimed` → `rows:0, changes:0, rows_written:0`; re-claim of a `failed`
 * row → `attempt:2` with `error_code`/`processed_at` reset; and **6 concurrent** retries of one
 * `failed` row → exactly **1** winner and `attempt = 2`, not 7, because the losing statements no
 * longer match `outcome = 'failed'` once the winner has flipped it to `claimed`. Same guarantee the
 * primary key gave for fresh deliveries, now without the permanent-loss trap.
 */
export const CLAIM_SQL =
  `INSERT INTO telegram_updates (update_id, sender_id, chat_id, update_kind, text_excerpt, received_at, outcome, attempt) ` +
  `VALUES (?, ?, ?, ?, ?, ${NOW}, 'claimed', 1) ` +
  `ON CONFLICT (update_id) DO UPDATE SET outcome = 'claimed', error_code = NULL, processed_at = NULL, ` +
  `text_excerpt = excluded.text_excerpt, attempt = telegram_updates.attempt + 1 ` +
  `WHERE telegram_updates.outcome = 'failed' RETURNING update_id, attempt`;

/**
 * The mark. The `outcome = 'claimed'` guard is not decoration: it makes the transition a
 * one-way door, so a stale retry cannot move an already-`handled` row back to `failed` and the
 * second caller sees `changes = 0` and knows it lost.
 */
export const MARK_SQL =
  `UPDATE telegram_updates SET outcome = ?, error_code = ?, processed_at = ${NOW} ` +
  `WHERE update_id = ? AND outcome = 'claimed'`;

export const RETRIEVE_SQL =
  `SELECT update_id, sender_id, chat_id, update_kind, text_excerpt, received_at, processed_at, outcome, error_code, attempt ` +
  `FROM telegram_updates WHERE sender_id = ? ORDER BY update_id DESC LIMIT ?`;

/**
 * One query, three numbers that matter plus the retry total. `retries` is the only way the store
 * itself shows that a delivery had to be attempted twice, which is what "error and retry are
 * distinguishable" means in a build with no scheduler: `sum(attempt) - count(*)`.
 */
export const COUNTS_SQL =
  `SELECT outcome, count(*) AS rows, COALESCE(sum(attempt), 0) AS attempts ` +
  `FROM telegram_updates GROUP BY outcome ORDER BY outcome`;

/**
 * The count shape a store that answered nothing would report. Only ever used so a reply that does
 * not display counts cannot accidentally display ones it never read — see `handleTestUpdate`.
 */
export const zeroCounts = (): StoreCounts => ({ rows: 0, handled: 0, failed: 0, claimed: 0, retries: 0 });

export interface StoreCounts {
  readonly rows: number;
  readonly handled: number;
  readonly failed: number;
  readonly claimed: number;
  /** Attempts beyond the first, summed over every row — a number, not a claim. */
  readonly retries: number;
}

export const TABLE_PROBE_SQL = `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_updates'`;

/**
 * The retry column, checked as part of readiness. Without this, a store that has the table but not
 * migration 0002 answers `/ready` with `database:"ok"` and then fails every claim with a SQL error
 * — the worst combination, because the ingress would look healthy while being unable to record.
 */
export const COLUMN_PROBE_SQL = `PRAGMA table_info(telegram_updates)`;

export interface StoredRow {
  updateId: number;
  senderId: number;
  chatId: number | null;
  kind: TestUpdateKind;
  textExcerpt: string | null;
  receivedAt: string;
  processedAt: string | null;
  outcome: "claimed" | "handled" | "failed";
  errorCode: string | null;
  /** How many deliveries have worked on this row. 1 = first time, >1 = it was retried. */
  attempt: number;
}

const asNumber = (v: unknown): number => (typeof v === "bigint" ? Number(v) : Number(v));
const asString = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const rowOf = (raw: Record<string, unknown>): StoredRow => ({
  updateId: asNumber(raw["update_id"]),
  senderId: asNumber(raw["sender_id"]),
  chatId: raw["chat_id"] === null || raw["chat_id"] === undefined ? null : asNumber(raw["chat_id"]),
  kind: (asString(raw["update_kind"]) ?? "message") as TestUpdateKind,
  textExcerpt: asString(raw["text_excerpt"]),
  receivedAt: String(raw["received_at"] ?? ""),
  processedAt: asString(raw["processed_at"]),
  outcome: (asString(raw["outcome"]) ?? "claimed") as StoredRow["outcome"],
  errorCode: asString(raw["error_code"]),
  attempt: asNumber(raw["attempt"] ?? 1),
});

export class D1TestStore {
  private readonly db: D1Like;
  /** Every statement this store issues, for the ordering proof in the tests. */
  readonly issued: string[] = [];

  constructor(db: D1Like) {
    this.db = db;
  }

  /**
   * Is the schema applied *and* current? Table plus the `attempt` column, because a store that can
   * be opened but cannot claim is not ready, and `D1_SCHEMA_MISSING` is the operator-facing name
   * for exactly that half-provisioned state.
   */
  async hasSchema(): Promise<boolean> {
    this.issued.push(TABLE_PROBE_SQL);
    const table = await this.db.prepare(TABLE_PROBE_SQL).bind().all();
    if (!Array.isArray(table.results) || table.results.length !== 1) return false;
    this.issued.push(COLUMN_PROBE_SQL);
    try {
      const cols = await this.db.prepare(COLUMN_PROBE_SQL).bind().all();
      return Array.isArray(cols.results)
        && cols.results.some((raw) => (raw as Record<string, unknown>)["name"] === "attempt");
    } catch {
      // A binding that has no PRAGMA support is a store we must not describe as healthy.
      return false;
    }
  }

  /**
   * @returns `claimed: true` when THIS delivery may do the work, with the attempt number the
   *          statement assigned; `claimed: false` when the row is already claimed or finished.
   * A thrown D1 error is deliberately not caught here — the caller has to answer 5xx so the
   * delivery is retried, and swallowing it would turn a storage failure into a silent success.
   */
  async claim(update: TestUpdateRecord): Promise<ClaimResult> {
    this.issued.push(CLAIM_SQL);
    const res = await this.db
      .prepare(CLAIM_SQL)
      .bind(
        update.updateId,
        update.senderId,
        update.chatId,
        update.kind,
        // Re-excerpted here so a caller cannot bypass the cap: `excerptOf` is idempotent.
        excerptOf(update.textExcerpt),
      )
      .all();
    const row = Array.isArray(res.results) ? res.results[0] as Record<string, unknown> | undefined : undefined;
    if (row === undefined) return { claimed: false, attempt: 0 };
    return { claimed: true, attempt: asNumber(row["attempt"] ?? 1) };
  }

  /** @returns false when the row was no longer `claimed` (someone else finished it). */
  async mark(updateId: number, outcome: "handled" | "failed", errorCode: string | null = null): Promise<boolean> {
    this.issued.push(MARK_SQL);
    const res = await this.db.prepare(MARK_SQL).bind(outcome, errorCode, updateId).run();
    return Number(res.meta?.changes ?? 0) > 0;
  }

  async recentForSender(senderId: number, limit = 5): Promise<StoredRow[]> {
    this.issued.push(RETRIEVE_SQL);
    const res = await this.db.prepare(RETRIEVE_SQL).bind(senderId, Math.max(1, Math.min(limit, 20))).all();
    return (res.results as Record<string, unknown>[]).map(rowOf);
  }

  async counts(): Promise<StoreCounts> {
    this.issued.push(COUNTS_SQL);
    const res = await this.db.prepare(COUNTS_SQL).bind().all();
    const rows = res.results as Record<string, unknown>[];
    const pick = (outcome: "handled" | "failed" | "claimed"): number =>
      rows.reduce((sum, raw) => (String(raw["outcome"]) === outcome ? sum + asNumber(raw["rows"]) : sum), 0);
    const total = rows.reduce((sum, raw) => sum + asNumber(raw["rows"]), 0);
    const attempts = rows.reduce((sum, raw) => sum + asNumber(raw["attempts"] ?? 0), 0);
    return {
      rows: total,
      handled: pick("handled"),
      failed: pick("failed"),
      claimed: pick("claimed"),
      retries: Math.max(0, attempts - total),
    };
  }
}
