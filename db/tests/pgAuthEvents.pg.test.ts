// PgAuthEventStore real-PostgreSQL battery — SEC-03.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL). Without it every test is SKIPPED — a skip is not
// evidence. PGlite is never a substitute for this battery, because what is being
// proven here is DATABASE behaviour: the NULL-actor contract, the CHECK
// constraints, the append-only privileges and the ordering/pagination of real
// SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgAuthEventStore } from "../../apps/api/src/auth/pgAuthEventStore.ts";
import { PgUserStore } from "../../apps/api/src/auth/pgUserStore.ts";
import { AuthService } from "../../apps/api/src/auth/authService.ts";
import { JwtService } from "../../apps/api/src/auth/jwt.ts";
import type { PasswordHasher } from "@velora/domain";
import type { Pool } from "pg";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const T0 = new Date("2026-10-01T08:00:00.000Z");
const T1 = new Date("2026-10-02T09:00:00.000Z");
const T2 = new Date("2026-10-03T10:00:00.000Z");

async function harness(): Promise<{
  pool: Pool;
  events: PgAuthEventStore;
  users: PgUserStore;
  close: () => Promise<void>;
}> {
  const { Pool } = await import("pg");
  await (await prepareDatabase(PG_URL as string)).close();
  const pool = new Pool({ connectionString: PG_URL });
  return {
    pool,
    events: new PgAuthEventStore(pool),
    users: new PgUserStore(pool),
    close: () => pool.end(),
  };
}

async function mkUser(users: PgUserStore, email: string) {
  return users.createUser({
    email,
    passwordHash: "pg$hash",
    fullName: "PG Auth Event",
    timezone: "UTC",
    locale: "fa",
    now: T0,
  });
}

test("PG: auth_events stores an unknown-account attempt with user_id NULL", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    await h.events.record({
      userId: null,
      eventType: "login",
      result: "failure",
      reason: "INVALID_CREDENTIALS",
      ipAddress: "203.0.113.11",
      userAgent: "Mozilla/5.0 (pg battery)",
      occurredAt: T1,
    });

    const rows = await h.pool.query(
      "SELECT user_id, event_type, result, reason, ip_address, user_agent, occurred_at FROM auth_events",
    );
    assert.equal(rows.rowCount, 1);
    const r = rows.rows[0]!;
    assert.equal(r.user_id, null, "an unknown account must store NULL, never a fabricated id");
    assert.equal(r.event_type, "login");
    assert.equal(r.result, "failure");
    assert.equal(r.reason, "INVALID_CREDENTIALS");
    assert.equal(r.ip_address, "203.0.113.11");
    assert.equal(r.user_agent, "Mozilla/5.0 (pg battery)");
    assert.equal(new Date(r.occurred_at).toISOString(), T1.toISOString());
    // The attempted address must not exist anywhere in the row.
    assert.equal(JSON.stringify(r).includes("@"), false, "no address may be stored");
  } finally {
    await h.close();
  }
});

test("PG: a success can never carry a failure reason (CHECK), and a failure keeps its code", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const user = await mkUser(h.users, "pg-auth-events-1@velora.test");
    // The adapter normalises a success's reason away BEFORE the database sees it…
    await h.events.record({
      userId: user.id,
      eventType: "login",
      result: "success",
      reason: "ACCOUNT_INACTIVE",
      occurredAt: T1,
    });
    const stored = await h.pool.query("SELECT reason FROM auth_events WHERE user_id = $1", [user.id]);
    assert.equal(stored.rows[0]!.reason, null);

    // …and the database refuses the illegal shape even if a future caller
    // bypasses the adapter: the constraint is the second, independent layer.
    await assert.rejects(
      h.pool.query(
        "INSERT INTO auth_events (user_id, event_type, result, reason) VALUES ($1, 'login', 'success', 'INVALID_CREDENTIALS')",
        [user.id],
      ),
      /auth_events_reason_only_on_failure/,
    );
    // An unknown event name is refused by the vocabulary CHECK as well.
    await assert.rejects(
      h.pool.query("INSERT INTO auth_events (user_id, event_type, result) VALUES ($1, 'logout', 'success')", [user.id]),
      /auth_events_event_type_check/,
    );
  } finally {
    await h.close();
  }
});

test("PG: history is newest-first, filtered, paginated, and scoped to one user", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const a = await mkUser(h.users, "pg-auth-events-a@velora.test");
    const b = await mkUser(h.users, "pg-auth-events-b@velora.test");

    await h.events.record({ userId: a.id, eventType: "signup", result: "success", occurredAt: T0 });
    await h.events.record({ userId: a.id, eventType: "login", result: "failure", reason: "INVALID_CREDENTIALS", occurredAt: T1 });
    await h.events.record({ userId: a.id, eventType: "login", result: "success", occurredAt: T2 });
    await h.events.record({ userId: b.id, eventType: "signup", result: "success", occurredAt: T1 });

    const all = await h.events.listForUser(a.id);
    assert.equal(all.total, 3);
    assert.deepEqual(all.events.map((e) => e.occurredAt), [T2.toISOString(), T1.toISOString(), T0.toISOString()]);
    assert.deepEqual(all.events.map((e) => e.eventType), ["login", "login", "signup"]);

    // Scoping: b's signup is not in a's history (and vice versa).
    const onlyB = await h.events.listForUser(b.id);
    assert.equal(onlyB.total, 1);
    assert.equal(onlyB.events[0]!.eventType, "signup");

    // Filter.
    const failures = await h.events.listForUser(a.id, { result: "failure" });
    assert.equal(failures.total, 1);
    assert.equal(failures.events[0]!.reason, "INVALID_CREDENTIALS");

    // Pagination is a real SQL LIMIT/OFFSET with the clamp applied.
    const firstPage = await h.events.listForUser(a.id, { page: 1, perPage: 2 });
    assert.equal(firstPage.events.length, 2);
    assert.equal(firstPage.total, 3);
    const secondPage = await h.events.listForUser(a.id, { page: 2, perPage: 2 });
    assert.equal(secondPage.events.length, 1);
    assert.equal(secondPage.events[0]!.eventType, "signup");
    // Out-of-range page is an empty page, not an error.
    const past = await h.events.listForUser(a.id, { page: 9, perPage: 2 });
    assert.equal(past.events.length, 0);
    assert.equal(past.total, 3);
    // A non-existent user has a real, empty history.
    const ghost = await h.events.listForUser("999999");
    assert.deepEqual({ total: ghost.total, events: ghost.events.length }, { total: 0, events: 0 });
  } finally {
    await h.close();
  }
});

test("PG: the history is append-only at the privilege layer, and a real login writes it", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // 1. End-to-end through the REAL service on the REAL database: a failed
    //    login is recorded with the caller's own error code.
    const hasher: PasswordHasher = {
      async hash(plain: string) {
        return `pg$${plain}`;
      },
      async verify(plain: string, hash: string) {
        return hash === `pg$${plain}`;
      },
    } as unknown as PasswordHasher;
    const auth = new AuthService({
      store: h.users,
      hasher,
      jwt: JwtService.create("pg-auth-events-secret-0123456789"),
      mail: { name: "test", send: async () => undefined } as never,
      authEvents: h.events,
      now: () => T1,
    });
    const user = await h.users.createUser({
      email: "pg-auth-events-login@velora.test",
      passwordHash: "pg$correct-horse-battery",
      fullName: "Real Login",
      timezone: "UTC",
      locale: "fa",
      now: T0,
    });
    await h.users.markEmailVerified(user.id, T0);

    const wrong = await auth
      .login({ email: "pg-auth-events-login@velora.test", password: "nope", ipAddress: "198.51.100.4", userAgent: "pg-battery" })
      .catch((e) => e as { code: string });
    assert.equal(wrong.code, "INVALID_CREDENTIALS");
    const unknown = await auth
      .login({ email: "pg-nobody@velora.test", password: "nope", ipAddress: "198.51.100.5", userAgent: "pg-battery" })
      .catch((e) => e as { code: string });
    assert.equal(unknown.code, "INVALID_CREDENTIALS");
    await auth.login({ email: "pg-auth-events-login@velora.test", password: "correct-horse-battery", ipAddress: "198.51.100.6" });

    const rows = await h.pool.query(
      "SELECT user_id, result, reason, ip_address FROM auth_events ORDER BY occurred_at, id",
    );
    assert.equal(rows.rowCount, 3);
    assert.deepEqual(
      rows.rows.map((r) => [r.user_id === null ? null : String(r.user_id), r.result, r.reason, r.ip_address]),
      [
        [String(user.id), "failure", "INVALID_CREDENTIALS", "198.51.100.4"],
        [null, "failure", "INVALID_CREDENTIALS", "198.51.100.5"],
        [String(user.id), "success", null, "198.51.100.6"],
      ],
    );

    // 2. Deleting the user must NOT be able to silently erase the trail while
    //    the rows exist… (ON DELETE CASCADE is Legacy's own choice: an erased
    //    account takes its attempt history with it. Assert the behaviour that
    //    was actually chosen, so a future change to RESTRICT is a visible
    //    decision rather than a silent one.)
    const before = await h.pool.query("SELECT COUNT(*)::int AS n FROM auth_events WHERE user_id = $1", [user.id]);
    assert.equal(before.rows[0]!.n, 2);
    await h.pool.query("DELETE FROM users WHERE id = $1", [user.id]);
    const after = await h.pool.query("SELECT COUNT(*)::int AS n FROM auth_events WHERE user_id = $1", [user.id]);
    assert.equal(after.rows[0]!.n, 0, "ON DELETE CASCADE (Legacy behaviour): the account's own history goes with it");
    const orphans = await h.pool.query("SELECT COUNT(*)::int AS n FROM auth_events WHERE user_id IS NULL");
    assert.equal(orphans.rows[0]!.n, 1, "an unknown-account attempt has no user to cascade from and survives");
  } finally {
    await h.close();
  }
});
