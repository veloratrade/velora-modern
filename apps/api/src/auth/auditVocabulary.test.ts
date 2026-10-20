// The audit vocabulary, compared with the constraint that enforces it.
//
// WHY THIS FILE EXISTS. `audit_log_action_check` is REPLACED by every migration that needs a new action,
// because PostgreSQL cannot extend a CHECK. In 0036 that rewrite dropped two names 0027 had added —
// `USER_SESSIONS_REVOKED` and `USER_EMAIL_VERIFIED` — while `AuditAction` in this package kept them. The
// result was a type that permitted an insert the database refused, discovered only when an admin actually
// revoked a session. The unit suite never wrote those rows, so nothing was red.
//
// A real-PostgreSQL test of the same shape exists (`db/tests/migrations.test.ts`), but it runs only on the
// PGlite battery and it asserts what the SQL DOES, not what the TYPES SAY. This file closes the loop in the
// cheap direction: the enumerable `AUDIT_ACTIONS` array must equal the last CHECK in the migration
// directory, name for name. Add an action to the type without a migration, or rewrite a migration's list
// and forget one, and this fails in seconds on any machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { AUDIT_ACTIONS } from "./auditStore.js";

/** The LAST definition of `audit_log_action_check` in the migration directory, as written. */
function latestActionCheck(): { readonly file: string; readonly values: readonly string[] } {
  // `db/migrations` from the repo root: this file is apps/api/src/auth, and the workspace root is the
  // only place the migrations live. Resolved from import.meta.url rather than process.cwd() so the test
  // passes no matter which directory the runner was started in.
  const dir = new URL("../../../../db/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let last: { file: string; values: string[] } | null = null;
  for (const file of files) {
    const raw = readFileSync(new URL(file, dir), "utf8");
    // Comments first: 0027 documents its own rollback example inside a comment, and a scanner that reads
    // it as DDL invents a constraint change that never happened. (It did exactly that in review.)
    const sql = raw.split("\n").map((line) => line.replace(/--.*$/u, "")).join("\n");
    const re = /ADD CONSTRAINT\s+audit_log_action_check\s*\n?\s*CHECK\s*\(([^]*?)\)\s*;/giu;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql)) !== null) {
      const body = match[1] ?? "";
      const values = [...body.matchAll(/'([^']+)'/gu)].map((v) => v[1] ?? "").filter((v) => v !== "");
      if (values.length > 0) last = { file, values };
    }
  }
  assert.ok(last !== null, "no definition of audit_log_action_check was found in db/migrations");
  return last as { file: string; values: readonly string[] };
}

test("the audit actions the code may emit are exactly the ones the last migration allows", () => {
  const latest = latestActionCheck();
  const inSql = new Set(latest.values);
  const inCode = new Set<string>(AUDIT_ACTIONS);

  const missingFromSql = [...inCode].filter((a) => !inSql.has(a));
  const missingFromCode = [...inSql].filter((a) => !inCode.has(a));
  assert.deepEqual(
    missingFromSql,
    [],
    `${latest.file} does not allow ${JSON.stringify(missingFromSql)} — the code would emit rows the database refuses`,
  );
  assert.deepEqual(
    missingFromCode,
    [],
    `${latest.file} allows ${JSON.stringify(missingFromCode)}, which no code may emit — an action that can be written directly to SQL but never by the platform is unexplained`,
  );
});

test("the history's one narrowing is 0036's, and nothing from 0040 on repeats it", () => {
  // The 0036 defect, expressed as a permanent expectation rather than edited out of memory: walking the
  // files in order, the ONLY rewrite that lost a name is 0036's, and 0040 restored exactly what it lost.
  // Asserting the exception is what makes the rule meaningful — a test that quietly permits "monotonic from
  // 0040 onward" without naming why would let the next narrowing hide behind the same tolerance.
  const dir = new URL("../../../../db/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Set<string>();
  const narrowings: { readonly file: string; readonly lost: readonly string[] }[] = [];
  for (const file of files) {
    const raw = readFileSync(new URL(file, dir), "utf8");
    const sql = raw.split("\n").map((line) => line.replace(/--.*$/u, "")).join("\n");
    const re = /ADD CONSTRAINT\s+audit_log_action_check\s*\n?\s*CHECK\s*\(([^]*?)\)\s*;/giu;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql)) !== null) {
      const values = new Set([...(match[1] ?? "").matchAll(/'([^']+)'/gu)].map((v) => v[1] ?? ""));
      const lost = [...seen].filter((a) => !values.has(a)).sort();
      if (lost.length > 0) narrowings.push({ file, lost });
      for (const value of values) seen.add(value);
    }
  }
  assert.deepEqual(narrowings, [
    {
      file: "0036_journal_daily_checklist.sql",
      lost: ["USER_EMAIL_VERIFIED", "USER_SESSIONS_REVOKED"],
    },
  ], "exactly one narrowing is on the record — 0036's, fixed by 0040; a second one is a bug");
  assert.ok(
    seen.has("USER_SESSIONS_REVOKED") && seen.has("USER_EMAIL_VERIFIED"),
    "the restored pair must still be in the final vocabulary",
  );
});

test("the list is a set: no duplicate name, no empty name, no name that could not be a SQL literal", () => {
  // Cheap, and it is the kind of thing a merge conflict does: two entries for one action make the
  // `deepEqual` above pass while the counts in a report disagree.
  const list = AUDIT_ACTIONS as readonly string[];
  assert.equal(new Set(list).size, list.length, "AUDIT_ACTIONS has a duplicate");
  for (const action of list) {
    assert.match(action, /^[A-Z][A-Z0-9_]{2,63}$/u, `${action} is not a well-formed action name`);
  }
});
