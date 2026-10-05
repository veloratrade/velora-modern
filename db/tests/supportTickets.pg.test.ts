// Real-PostgreSQL battery for 0026_support_tickets — the support capability's
// persistence and derivation rules.
//
// WHAT ONLY A REAL ENGINE CAN PROVE HERE. The support ticket is DERIVED STATE:
// its status, its `waiting_for` axis, both unread counters and the first-reply
// sentinel are consequences of the message that was appended, never values a
// client supplies. The guarantees therefore live in the DATABASE, not in a
// service-level convention:
//
//   1. the derivation functions move the ticket EXACTLY as the event says — a
//      user message hands it to the admin, an admin text reply hands it to the
//      user, and an INTERNAL NOTE MOVES NOTHING (the Legacy defect this
//      migration deliberately does not reproduce);
//   2. `require_live` refuses a message into a closed/archived ticket WITHOUT
//      inserting anything — the kind of check-then-insert an application cannot
//      make atomic;
//   3. the transition function is COMPARE-AND-SET: a stale `from` returns no row,
//      which the API maps to 409 instead of silently overwriting a concurrent
//      change;
//   4. two concurrent replies cannot lose a counter increment (single statement,
//      single row lock);
//   5. the CHECK constraints refuse the states Legacy's schema could store
//      (waiting_for inconsistent with status, a system message with an author,
//      an authorless admin reply).
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL). Without it every test is SKIPPED, never silently
// passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgSupportStore, SupportService } from "../../apps/api/src/support/supportService.ts";
import type { QueryFn } from "../../apps/api/src/persistence/pg.ts";

const PG_URL = process.env.DATABASE_URL;
const SKIP =
  PG_URL === undefined ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)" : false;

interface Seed {
  readonly userId: string;
  readonly adminId: string;
}

async function seedUsers(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, opts: { admin?: boolean } = {}): Promise<Seed> {
  const user = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id", [
    `support-${process.pid}-${process.hrtime.bigint()}@velora.test`,
  ]);
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,'x',$2) RETURNING id`,
    [`support-admin-${process.pid}-${process.hrtime.bigint()}@velora.test`, opts.admin === false ? "user" : "admin"],
  );
  return { userId: String(user.rows[0]!.id), adminId: String(admin.rows[0]!.id) };
}

const q = (pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): QueryFn =>
  (async (sql: string, params?: unknown[]) => (await pool.query(sql, params as unknown[] | undefined)).rows) as unknown as QueryFn;

/** Run a statement that must be REFUSED by a named constraint. */
async function rejected(fn: () => Promise<unknown>, constraint: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.equal((err as { code?: string }).code, "23514", `expected a CHECK violation, got ${String(err)}`);
    assert.match(String(err), new RegExp(constraint), `expected ${constraint} to be the reason`);
    return;
  }
  assert.fail(`the database ACCEPTED a row that must be refused by ${constraint}`);
}

// ── The migration itself ────────────────────────────────────────────────────

test("0026 — the support tables, functions, indexes and constraints exist after migration", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const tables = await db.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'support_%' ORDER BY table_name",
    );
    assert.deepEqual(tables.rows.map((r) => r.table_name), ["support_messages", "support_tickets"]);

    const fns = await db.pool.query(
      "SELECT proname FROM pg_proc WHERE proname LIKE 'velora_support_%' ORDER BY proname",
    );
    assert.deepEqual(fns.rows.map((r) => r.proname), [
      "velora_support_append_message",
      "velora_support_create_ticket",
      "velora_support_transition",
    ]);

    const idx = await db.pool.query("SELECT indexname FROM pg_indexes WHERE tablename LIKE 'support_%' ORDER BY indexname");
    assert.ok(idx.rows.some((r) => r.indexname === "support_tickets_user_idx"));
    assert.ok(idx.rows.some((r) => r.indexname === "support_tickets_queue_idx"));
    assert.ok(idx.rows.some((r) => r.indexname === "support_messages_ticket_idx"));

    // There is NO translation table: phase 7 owns the AI surfaces, and storage
    // for an unbuilt feature would be speculative infrastructure.
    const translations = await db.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name LIKE '%translation%'");
    assert.equal(translations.rows[0]!.n, 0);
  } finally {
    await db.close();
  }
});

test("0026 — the migration is idempotent: re-running it leaves the schema intact and the data alone", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId } = await seedUsers(db.pool);
    await db.pool.query("SELECT velora_support_create_ticket($1,'موضوع','پیام')", [userId]);
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(join(import.meta.dirname, "..", "migrations", "0026_support_tickets.sql"), "utf8");
    await db.pool.query(sql);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM support_tickets");
    assert.equal(n.rows[0]!.n, 1, "the re-run must not duplicate or drop data");
  } finally {
    await db.close();
  }
});

// ── create: the opening state ───────────────────────────────────────────────

test("create — a ticket opens for the admin, with one unread message for them and nothing unread for the user", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId } = await seedUsers(db.pool);
    const created = await db.pool.query("SELECT ticket_id FROM velora_support_create_ticket($1,'شارژ حساب','سلام')", [userId]);
    const id = String(created.rows[0]!.ticket_id);
    const row = await db.pool.query(
      "SELECT status, waiting_for, unread_admin_count, unread_user_count, first_reply_at, last_message_at FROM support_tickets WHERE id=$1",
      [id],
    );
    assert.deepEqual(
      {
        status: row.rows[0]!.status,
        waitingFor: row.rows[0]!.waiting_for,
        unreadAdmin: row.rows[0]!.unread_admin_count,
        unreadUser: row.rows[0]!.unread_user_count,
        firstReplyAt: row.rows[0]!.first_reply_at,
      },
      { status: "open", waitingFor: "admin", unreadAdmin: 1, unreadUser: 0, firstReplyAt: null },
    );
    const msgs = await db.pool.query("SELECT sender_type, sender_user_id, body, message_type FROM support_messages WHERE ticket_id=$1", [id]);
    assert.equal(msgs.rows.length, 1);
    assert.equal(msgs.rows[0]!.sender_type, "user");
    assert.equal(String(msgs.rows[0]!.sender_user_id), userId);

    // Subject and body bounds are the DB's, not just the service's.
    await rejected(() => db.pool.query("SELECT velora_support_create_ticket($1,'','x')", [userId]), "support_tickets_subject_len");
    await rejected(() => db.pool.query("SELECT velora_support_create_ticket($1,$2,'x')", [userId, "ا".repeat(201)]), "support_tickets_subject_len");
    await rejected(() => db.pool.query("SELECT velora_support_create_ticket($1,'s','')", [userId]), "support_messages_body_len");
    await rejected(() => db.pool.query("SELECT velora_support_create_ticket($1,'s',$2)", [userId, "x".repeat(5001)]), "support_messages_body_len");
  } finally {
    await db.close();
  }
});

// ── the derivation function ─────────────────────────────────────────────────

test("append — a user message hands the ticket to the admin and raises ONLY the admin's counter", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId, adminId } = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const { id } = await service.createTicket(userId, { subject: "s", message: "first" });

    // an admin reply first, so both counters have a history to be derived from
    await service.supportReply(adminId, id, "پاسخ اول");
    await service.supportReply(adminId, id, "پاسخ دوم");
    const afterReplies = await service.supportTicket(id, { markRead: false });
    assert.deepEqual(
      { status: afterReplies.conversation.status, waitingFor: afterReplies.conversation.waitingFor, unreadUser: afterReplies.conversation.unreadUserCount, unreadAdmin: afterReplies.conversation.unreadAdminCount },
      { status: "pending", waitingFor: "user", unreadUser: 2, unreadAdmin: 0 },
    );
    assert.notEqual(afterReplies.conversation.firstReplyAt, null);

    const reply = await service.userReply(userId, id, "ممنون");
    assert.deepEqual(
      { status: reply.status, waitingFor: reply.waitingFor },
      { status: "open", waitingFor: "admin" },
      "a user message hands the ticket back to the admin",
    );
    const afterReply = (await service.supportTicket(id, { markRead: false })).conversation;
    assert.deepEqual(
      { unreadUser: afterReply.unreadUserCount, unreadAdmin: afterReply.unreadAdminCount, firstReplyAt: afterReply.firstReplyAt },
      { unreadUser: 0, unreadAdmin: 1, firstReplyAt: afterReplies.conversation.firstReplyAt },
      "writing clears the writer's badge, and the sentinel is not touched",
    );
  } finally {
    await db.close();
  }
});

test("append — the first-reply sentinel is stamped ONCE, by the first admin TEXT reply only", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId, adminId } = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const { id } = await service.createTicket(userId, { subject: "s", message: "m" });

    const note = await service.supportReply(adminId, id, "یادداشت داخلی", true);
    assert.equal(note.firstReply, false, "an internal note is not an answer the user can see");
    const before = await service.supportTicket(id, { markRead: false });
    assert.equal(before.conversation.firstReplyAt, null);

    const first = await service.supportReply(adminId, id, "پاسخ");
    assert.equal(first.firstReply, true);
    const stamped = (await service.supportTicket(id, { markRead: false })).conversation.firstReplyAt;
    assert.notEqual(stamped, null);
    const second = await service.supportReply(adminId, id, "پاسخ دیگر");
    assert.equal(second.firstReply, false);
    assert.equal((await service.supportTicket(id, { markRead: false })).conversation.firstReplyAt, stamped, "the sentinel must not move");
  } finally {
    await db.close();
  }
});

test("append — AN INTERNAL NOTE MOVES NOTHING: not status, not waiting_for, not a counter, not the sentinel", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId, adminId } = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const { id } = await service.createTicket(userId, { subject: "s", message: "m" });
    const before = (await service.supportTicket(id, { markRead: false })).conversation;
    const at = (await db.pool.query("SELECT last_message_at FROM support_tickets WHERE id=$1", [id])).rows[0]!.last_message_at;

    await service.supportReply(adminId, id, "بررسی شود", true);

    const after = (await service.supportTicket(id, { markRead: false })).conversation;
    assert.deepEqual(
      {
        status: after.status,
        waitingFor: after.waitingFor,
        unreadAdmin: after.unreadAdminCount,
        unreadUser: after.unreadUserCount,
        firstReplyAt: after.firstReplyAt,
      },
      {
        status: before.status,
        waitingFor: before.waitingFor,
        unreadAdmin: before.unreadAdminCount,
        unreadUser: before.unreadUserCount,
        firstReplyAt: before.firstReplyAt,
      },
    );
    const row = await db.pool.query("SELECT message_type, sender_type, sender_user_id FROM support_messages WHERE ticket_id=$1 ORDER BY id DESC LIMIT 1", [id]);
    assert.equal(row.rows[0]!.message_type, "system_note", "the note IS stored — support reads it");
    assert.equal(row.rows[0]!.sender_type, "admin");
    // `last_message_at` is a property of the CONVERSATION as the USER sees it
    // (its ordering key), so a note must not reorder the user's list either.
    assert.deepEqual((await db.pool.query("SELECT last_message_at FROM support_tickets WHERE id=$1", [id])).rows[0]!.last_message_at, at);
  } finally {
    await db.close();
  }
});

test("append — a closed or archived ticket refuses the message and inserts NOTHING (require_live)", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId } = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const { id } = await service.createTicket(userId, { subject: "s", message: "m" });
    await service.supportSetStatus("1", id, "close");

    await assert.rejects(() => service.userReply(userId, id, "سلام؟"), /closed/i);
    const n = await db.pool.query("SELECT count(*)::int AS n FROM support_messages WHERE ticket_id=$1", [id]);
    assert.equal(n.rows[0]!.n, 1, "the refused reply must not leave an orphan message row");

    // The database is the last line of defence, not just the service: even a
    // direct call cannot force a message into a closed ticket.
    const direct = await db.pool.query("SELECT * FROM velora_support_append_message($1,'user',$2,'x','text',true)", [id, userId]);
    assert.equal(direct.rows.length, 0, "require_live=true must yield no row");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM support_messages WHERE ticket_id=$1", [id])).rows[0]!.n, 1);

    // …and the same call WITHOUT the guard (an admin close/archive note) still works
    // only where the service allows it, which is why `requireLive` is a parameter
    // the caller states rather than a hidden default.
    const forced = await db.pool.query("SELECT * FROM velora_support_append_message($1,'admin',$2,'note','system_note',false)", [id, userId]);
    assert.equal(forced.rows.length, 1);
  } finally {
    await db.close();
  }
});

// ── transitions ─────────────────────────────────────────────────────────────

test("transition — compare-and-set: a stale `from` returns no row instead of overwriting", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId } = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const { id } = await service.createTicket(userId, { subject: "s", message: "m" });

    const won = await db.pool.query("SELECT * FROM velora_support_transition($1, ARRAY['open','pending'],'closed','none')", [id]);
    assert.equal(won.rows.length, 1);
    const lost = await db.pool.query("SELECT * FROM velora_support_transition($1, ARRAY['open','pending'],'archived','none')", [id]);
    assert.equal(lost.rows.length, 0, "the second caller's view of the row is stale — it must lose");
    assert.equal((await db.pool.query("SELECT status, waiting_for FROM support_tickets WHERE id=$1", [id])).rows[0]!.status, "closed");

    const archived = await db.pool.query("SELECT * FROM velora_support_transition($1, ARRAY['closed'],'archived','none')", [id]);
    assert.equal(archived.rows.length, 1);
    assert.equal((await db.pool.query("SELECT status, waiting_for FROM support_tickets WHERE id=$1", [id])).rows[0]!.waiting_for, "none");
  } finally {
    await db.close();
  }
});

test("transition — the API turns a lost compare-and-set into a 409, never a silent success", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId } = await seedUsers(db.pool);
    const store = new PgSupportStore(q(db.pool));
    const service = new SupportService({ store });
    const { id } = await service.createTicket(userId, { subject: "s", message: "m" });

    // Deterministic arm: the ticket has already left the states a close may start
    // from, so the CAS cannot match and the caller must be told.
    await store.transition(id, ["open", "pending"], { status: "closed", waitingFor: "none" });
    await assert.rejects(
      () => service.supportSetStatus("1", id, "close"),
      (err: unknown) => (err as { status?: number; code?: string }).status === 409 && (err as { code?: string }).code === "SUPPORT_STATE_CONFLICT",
    );

    // Racing arm: two concurrent closes — exactly one may win.
    const other = await service.createTicket(userId, { subject: "s2", message: "m" });
    const results = await Promise.allSettled([
      service.supportSetStatus("1", other.id, "close"),
      service.supportSetStatus("2", other.id, "close"),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(won.length, 1, "one close claims the transition");
    assert.equal(lost.length, 1, "the other must lose");
    assert.equal((lost[0]!.reason as { status?: number }).status, 409);
    assert.equal((await store.conversation(other.id))!.status, "closed");
  } finally {
    await db.close();
  }
});

// ── concurrency ─────────────────────────────────────────────────────────────

test("CONCURRENCY — two simultaneous user replies both count: no lost increment, no torn state", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId } = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const { id } = await service.createTicket(userId, { subject: "s", message: "m" });
    await service.supportTicket(id, { markRead: false });

    const results = await Promise.allSettled([
      service.userReply(userId, id, "اولی"),
      service.userReply(userId, id, "دومی"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, "both replies are legitimate and must be stored");
    const row = await db.pool.query("SELECT unread_admin_count, status, waiting_for FROM support_tickets WHERE id=$1", [id]);
    assert.equal(row.rows[0]!.unread_admin_count, 3, "the opening message plus BOTH replies — a lost update would show 2");
    assert.equal(row.rows[0]!.status, "open");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM support_messages WHERE ticket_id=$1", [id])).rows[0]!.n, 3);
  } finally {
    await db.close();
  }
});

test("CONCURRENCY — a reply racing a close cannot land in a closed ticket", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId } = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const { id } = await service.createTicket(userId, { subject: "s", message: "m" });

    const [reply, close] = await Promise.allSettled([
      service.userReply(userId, id, "رقابتی"),
      service.supportSetStatus("1", id, "close"),
    ]);
    assert.equal(close.status, "fulfilled");
    const state = await db.pool.query("SELECT status, waiting_for, unread_admin_count FROM support_tickets WHERE id=$1", [id]);
    const messages = (await db.pool.query("SELECT count(*)::int AS n FROM support_messages WHERE ticket_id=$1", [id])).rows[0]!.n;
    // Exactly one of the two orders is possible, and BOTH are consistent: either
    // the reply landed first (so the ticket re-opened and the close then won), or
    // the close won and the reply was refused. What must never happen is a closed
    // ticket holding a message that its own derivation says opened it.
    if (reply.status === "fulfilled") {
      assert.equal(state.rows[0]!.status, "closed", "the close is the later event");
      assert.equal(messages, 2);
    } else {
      assert.equal(state.rows[0]!.status, "closed");
      assert.equal(messages, 1, "the refused reply left nothing behind");
      assert.match(String((reply as PromiseRejectedResult).reason), /closed/i);
    }
    assert.equal(state.rows[0]!.waiting_for, "none");
  } finally {
    await db.close();
  }
});

// ── constraints ─────────────────────────────────────────────────────────────

test("CONSTRAINTS — the two axes cannot disagree, and a message must have a coherent author", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const { userId, adminId } = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const { id } = await service.createTicket(userId, { subject: "s", message: "m" });

    // status/waiting_for consistency (the invariant the two axes share)
    await rejected(
      () => db.pool.query("UPDATE support_tickets SET status='closed', waiting_for='user' WHERE id=$1", [id]),
      "support_tickets_waiting_consistent",
    );
    await rejected(
      () => db.pool.query("UPDATE support_tickets SET status='archived', waiting_for='admin' WHERE id=$1", [id]),
      "support_tickets_waiting_consistent",
    );
    await rejected(() => db.pool.query("UPDATE support_tickets SET status='banana' WHERE id=$1", [id]), "support_tickets_status_check");
    // A ghost axis value violates whichever of the two dependent constraints the
    // planner checks first — both encode "these values are the whole vocabulary".
    await assert.rejects(() => db.pool.query("UPDATE support_tickets SET waiting_for='ghost' WHERE id=$1", [id]), (err: unknown) => {
      assert.equal((err as { code?: string }).code, "23514");
      assert.match(String(err), /support_tickets_waiting_(for_check|consistent)/);
      return true;
    });

    // sender identity: a SYSTEM note is never attributed to a person. (The
    // reverse — an authorless user/admin row — is ALLOWED on purpose: it is the
    // residue of `ON DELETE SET NULL` when the author's account is deleted, and a
    // stricter CHECK made account deletion itself fail. Test 13 pins both halves.)
    await rejected(
      () => db.pool.query("INSERT INTO support_messages (ticket_id, sender_type, sender_user_id, body, message_type) VALUES ($1,'system',$2,'x','text')", [id, adminId]),
      "support_messages_sender_identity",
    );
    await db.pool.query("INSERT INTO support_messages (ticket_id, sender_type, sender_user_id, body, message_type) VALUES ($1,'admin',NULL,'x','text')", [id]);
    await rejected(
      () => db.pool.query("INSERT INTO support_messages (ticket_id, sender_type, sender_user_id, body, message_type) VALUES ($1,'bot',$2,'x','text')", [id, adminId]),
      "support_messages_sender_type_check",
    );
    // unread counters are counts, never negative
    await rejected(() => db.pool.query("UPDATE support_tickets SET unread_user_count = -1 WHERE id=$1", [id]), "unread_user_count_check");
    // …and a valid system note IS allowed (the constraint is about coherence, not prohibition)
    await db.pool.query("INSERT INTO support_messages (ticket_id, sender_type, sender_user_id, body, message_type) VALUES ($1,'system',NULL,'سیستمی','system_note')", [id]);
  } finally {
    await db.close();
  }
});

test("INTEGRITY — deleting a user takes their tickets; a deleted ADMIN's replies survive, unattributed", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const alice = await seedUsers(db.pool);
    const bob = await seedUsers(db.pool);
    const service = new SupportService({ store: new PgSupportStore(q(db.pool)) });
    const a = await service.createTicket(alice.userId, { subject: "ب", message: "m" });
    const b = await service.createTicket(bob.userId, { subject: "الف", message: "m" });
    await service.supportReply(alice.adminId, b.id, "پاسخ پشتیبانی");

    // The admin answers alice's ticket too, then the admin's account is deleted.
    await service.supportReply(alice.adminId, a.id, "پاسخ دیگر");
    await db.pool.query("DELETE FROM users WHERE id=$1", [alice.adminId]);
    const survived = await db.pool.query("SELECT sender_type, sender_user_id, body FROM support_messages WHERE ticket_id=$1 AND sender_type='admin'", [a.id]);
    assert.equal(survived.rows.length, 1, "an admin's reply must NOT be deleted out of a user's ticket");
    assert.equal(survived.rows[0]!.sender_user_id, null, "…it keeps the words and loses the attribution (ON DELETE SET NULL)");

    // Now the ticket OWNER goes: the ticket and its messages go with them, and
    // nothing of anyone else's is touched.
    await db.pool.query("DELETE FROM users WHERE id=$1", [alice.userId]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM support_tickets")).rows[0]!.n, 1);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM support_messages")).rows[0]!.n, 2, "bob's opening message and the admin's reply on it");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM support_tickets WHERE id=$1", [b.id])).rows[0]!.n, 1);

    // …and the identity rule that DOES hold: a system note is never attributed.
    await rejected(
      () => db.pool.query("INSERT INTO support_messages (ticket_id, sender_type, sender_user_id, body, message_type) VALUES ($1,'system',$2,'x','system_note')", [b.id, bob.adminId]),
      "support_messages_sender_identity",
    );
  } finally {
    await db.close();
  }
});

// ── the adapter the API actually uses ───────────────────────────────────────

test("PgSupportStore — the adapter's own queries behave: scoping, ILIKE escaping, counters, read markers", { skip: SKIP }, async () => {
  const db = await prepareDatabase(PG_URL as string);
  try {
    const alice = await seedUsers(db.pool);
    const bob = await seedUsers(db.pool);
    const store = new PgSupportStore(q(db.pool));
    const service = new SupportService({ store });
    const one = await service.createTicket(alice.userId, { subject: "شارژ 100% حساب", message: "m" });
    await service.createTicket(bob.userId, { subject: "دیگر", message: "m" });

    // scoping: a foreign ticket is invisible at the SQL layer too
    assert.equal(await store.conversationForUser(bob.userId, one.id), null);
    assert.equal((await store.listUserTickets(bob.userId, { offset: 0, limit: 20 })).total, 1);

    // a `%` in the search term is a character, not a wildcard (the adapter escapes it)
    assert.equal((await store.adminList({ q: "100%", offset: 0, limit: 20 })).total, 1);
    assert.equal((await store.adminList({ q: "10_%", offset: 0, limit: 20 })).total, 0, "an underscore must not match a digit");
    assert.equal((await store.adminList({ status: "open", offset: 0, limit: 20 })).total, 2);
    assert.equal((await store.adminList({ unread: "admin", offset: 0, limit: 20 })).total, 2);

    // counters are derived from the rows, not from a cached column
    const counters = (await store.adminList({ offset: 0, limit: 20 })).counters;
    assert.deepEqual(counters, { open: 2, pending: 0, unread: 2 });

    // read markers are scoped: the user's marker cannot be applied to a foreign row
    assert.equal(await store.markUserRead(bob.userId, one.id), false);
    assert.equal(await store.markUserRead(alice.userId, one.id), true);
    assert.equal(await store.markAdminRead(one.id), true);
    assert.equal((await store.conversation(one.id))!.unreadAdminCount, 0);
    assert.equal(await store.unreadForUser(alice.userId), 0);

    // ordering is the SQL's own key (last_message_at DESC, id DESC) and it follows
    // the last VISIBLE message only — an internal note must not reorder the list.
    const older = await service.createTicket(alice.userId, { subject: "قدیمی", message: "m" });
    const newer = await service.createTicket(alice.userId, { subject: "جدید", message: "m" });
    assert.deepEqual(
      (await store.listUserTickets(alice.userId, { offset: 0, limit: 20 })).tickets.map((t) => t.id),
      [newer.id, older.id, one.id],
    );
    await service.supportReply(alice.adminId, one.id, "پاسخ");
    assert.deepEqual(
      (await store.listUserTickets(alice.userId, { offset: 0, limit: 20 })).tickets.map((t) => t.id),
      [one.id, newer.id, older.id],
      "a visible reply moves the ticket to the top",
    );
    await service.supportReply(alice.adminId, older.id, "یادداشت", true);
    assert.deepEqual(
      (await store.listUserTickets(alice.userId, { offset: 0, limit: 20 })).tickets.map((t) => t.id),
      [one.id, newer.id, older.id],
      "an internal note moves nothing — not even the order",
    );
    // the queue badges describe the QUEUE, never the current filter
    const narrowed = await store.adminList({ status: "pending", offset: 0, limit: 20 });
    assert.equal(narrowed.total, 1);
    // bob's ticket counts too: the badge is the whole queue, not the filter and
    // not the caller's own rows.
    assert.deepEqual(narrowed.counters, { open: 3, pending: 1, unread: 3 });

    const page = await store.listUserTickets(alice.userId, { offset: 0, limit: 20 });
    assert.equal(page.tickets.length, 3);
    assert.equal(await store.assign(one.id, alice.adminId), true);
    assert.equal(await store.assign("99999999", alice.adminId), false, "assigning a ticket that does not exist is a false, not an error");
  } finally {
    await db.close();
  }
});
