// Phase D D2 — shared direct-PostgreSQL infrastructure (direct `pg`, no ORM;
// owner decision 2026-09-13, D1 commit 9f2df9d / evidence run 34731411400).
//
// Deliberately thin: the D1 decision (docs/reconciliation/PHASE-D-D1-ORM-SPIKE.md)
// chose the raw driver precisely so that the SQL under test is the SQL written
// in the adapter. This module adds only the three things every adapter needs:
//
//   1. QueryFn        — a minimal rows-returning executor over a pg Pool
//   2. withTransaction — BEGIN/COMMIT/ROLLBACK on a checked-out client
//                        (rollback-on-error; the client is always released)
//   3. isUniqueViolation — PostgreSQL error-code mapping (23505) so adapters
//                        translate driver errors to domain errors at the
//                        boundary instead of matching message text alone.
//
// Driver value shapes at this boundary (VERIFIED — real PostgreSQL 16.15,
// GHA run 34731411400, tools/pg-smoke.ts S2–S4): NUMERIC → exact
// scale-padded string (ADR-001 law), BIGINT/int8 → string, COUNT(*)::int →
// number, TIMESTAMPTZ → Date, JSONB → parsed object. Adapters normalize via
// their row mappers; no global setTypeParser overrides exist (D1 R4 rule).
import type { Pool } from "pg";

/** Rows-returning query executor (mirrors the MigrationEngine.query shape). */
export type QueryFn = (
  sql: string,
  params?: readonly unknown[],
) => Promise<ReadonlyArray<Record<string, unknown>>>;

/** Executor over a pg Pool (single statements — autocommit semantics). */
export function poolQuery(pool: Pool): QueryFn {
  // Spread: @types/pg expects a mutable array for the values parameter.
  return async (sql, params) => (await pool.query(sql, params === undefined ? [] : [...params])).rows;
}

/**
 * Serialized, rollback-on-error multi-statement unit on one checked-out
 * client. On error the transaction is rolled back and the error re-thrown
 * unchanged (adapters classify it); the client is released in all paths.
 */
export async function withTransaction<T>(pool: Pool, fn: (q: QueryFn) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(async (sql, params) => (await client.query(sql, params === undefined ? [] : [...params])).rows);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection already unusable — the original error is the meaningful one.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * PostgreSQL unique_violation (SQLSTATE 23505) detector with optional
 * constraint-name check. pg errors carry `code` + `constraint`; the message
 * regex is a defensive fallback (PGlite-parity) for drivers that only give
 * text. Adapters map this to their domain errors (e.g. UserEmailExistsError).
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string | undefined; constraint?: string | undefined; message?: string | undefined };
  if (e?.code !== "23505") return false;
  if (constraint === undefined) return true;
  return e.constraint === constraint || e.message?.includes(constraint) === true;
}

/** PostgreSQL check_violation (SQLSTATE 23514) detector (constraint surfacing). */
export function isCheckViolation(err: unknown): boolean {
  return (err as { code?: string | undefined })?.code === "23514";
}

/** Defensive ISO normalization: pg gives Date for timestamptz; strings tolerated. */
export function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

/** Defensive ISO-or-null normalization for nullable timestamptz columns. */
export function isoOrNull(v: Date | string | null): string | null {
  return v === null ? null : iso(v);
}
