/**
 * Unit battery for the D1 private-test store and for the ordering the owner asked for:
 * the access gate must be decided BEFORE the database is touched.
 *
 * Two kinds of evidence, kept apart on purpose:
 *  - what is measured here: which statements the code issues, in what order, and how it reads
 *    the answers (a fake D1 that mirrors the responses recorded from the real database: one
 *    row from `… ON CONFLICT DO NOTHING RETURNING` means first delivery, an empty set means
 *    redelivery; `meta.changes > 0` means the row was still `claimed`);
 *  - what is measured against the real D1: that those statements parse and behave that way in
 *    SQLite (see `scripts/d1Live.mjs`, and the migration in `d1/migrations/`).
 * A fake that only echoes itself would prove nothing, so the fake's rules were written after the
 * live probe, not before it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  COLUMN_PROBE_SQL,
  CLAIM_SQL,
  COUNTS_SQL,
  D1TestStore,
  MARK_SQL,
  MAX_EXCERPT,
  RETRIEVE_SQL,
  TABLE_PROBE_SQL,
  excerptOf,
} from "./d1TestStore.js";
import { D1_DISABLED_FEATURES, handleTestUpdate, storageMode } from "./runtime.js";

interface FakeRow {
  update_id: number;
  sender_id: number;
  chat_id: number | null;
  update_kind: string;
  text_excerpt: string | null;
  received_at: string;
  processed_at: string | null;
  outcome: string;
  error_code: string | null;
  attempt: number;
}

/** An in-memory stand-in whose answers match what real D1 returned under the same statements. */
const makeFakeD1 = (rows: FakeRow[] = [], opts: { missingSchema?: boolean; missingMigration?: boolean } = {}) => {
  const table = rows;
  const log: { sql: string; values: unknown[] }[] = [];
  const prepare = (sql: string) => ({
    bind: (...values: unknown[]) => ({
      async all() {
        log.push({ sql, values });
        if (sql === TABLE_PROBE_SQL) return { results: opts.missingSchema ? [] : [{ name: "telegram_updates" }] };
        // `PRAGMA table_info` is how `hasSchema()` proves migration 0002 landed, so the fake answers
        // it with a column list, and `missingMigration` reproduces a table that exists without `attempt`.
        if (sql === COLUMN_PROBE_SQL) {
          const names = ["update_id", "sender_id", "chat_id", "update_kind", "text_excerpt", "received_at", "processed_at", "outcome", "error_code"];
          if (opts.missingMigration !== true) names.push("attempt");
          return { results: names.map((name) => ({ name })) };
        }
        if (sql === CLAIM_SQL) {
          const [updateId, senderId, chatId, kind, excerpt] = values as [number, number, number | null, string, string | null];
          const row = table.find((r) => r.update_id === updateId);
          if (row !== undefined) {
            // `DO UPDATE … WHERE outcome = 'failed'`: only a failed row can be re-claimed, and the
            // winner flips it to `claimed`, so every concurrent retry after it matches nothing.
            if (row.outcome !== "failed") return { results: [] }; // changes 0, rows_written 0
            row.outcome = "claimed";
            row.attempt += 1;
            row.error_code = null;
            row.processed_at = null;
            row.text_excerpt = excerpt;
            return { results: [{ update_id: updateId, attempt: row.attempt }] };
          }
          table.push({
            update_id: updateId,
            sender_id: senderId,
            chat_id: chatId,
            update_kind: kind,
            text_excerpt: excerpt,
            received_at: "2026-10-18T00:00:00.000Z",
            processed_at: null,
            outcome: "claimed",
            error_code: null,
            attempt: 1,
          });
          return { results: [{ update_id: updateId, attempt: 1 }] };
        }
        if (sql === RETRIEVE_SQL) {
          const [senderId, limit] = values as [number, number];
          return {
            results: table
              .filter((r) => r.sender_id === senderId)
              .sort((a, b) => b.update_id - a.update_id)
              .slice(0, limit),
          };
        }
        if (sql === COUNTS_SQL) {
          const by = new Map<string, { rows: number; attempts: number }>();
          for (const r of table) {
            const hit = by.get(r.outcome) ?? { rows: 0, attempts: 0 };
            by.set(r.outcome, { rows: hit.rows + 1, attempts: hit.attempts + (r.attempt ?? 1) });
          }
          return { results: [...by.entries()].sort().map(([outcome, v]) => ({ outcome, rows: v.rows, attempts: v.attempts })) };
        }
        throw new Error(`unexpected .all() statement: ${sql.slice(0, 48)}`);
      },
      async run() {
        log.push({ sql, values });
        if (sql === MARK_SQL) {
          const [outcome, errorCode, updateId] = values as ["handled" | "failed", string | null, number];
          const row = table.find((r) => r.update_id === updateId && r.outcome === "claimed");
          if (row === undefined) return { meta: { changes: 0 } }; // the guard: already terminal
          row.outcome = outcome;
          row.error_code = errorCode;
          row.processed_at = "2026-10-18T00:00:01.000Z";
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected .run() statement: ${sql.slice(0, 48)}`);
      },
    }),
  });
  return { db: { prepare } as never, table, log };
};

test("storageMode: PostgreSQL always wins when it is bound", () => {
  const bound = { HYPERDRIVE: { connectionString: "postgres://x" }, VELORA_TEST_DB: {} };
  assert.equal(storageMode(bound as never), "postgres");
  assert.equal(storageMode({ VELORA_TEST_DB: {} } as never), "d1-test");
  assert.equal(storageMode({} as never), "none");
  // an empty connection string is not a binding, and must not look like one
  assert.equal(storageMode({ HYPERDRIVE: { connectionString: "" }, VELORA_TEST_DB: {} } as never), "d1-test");
});

test("excerptOf: capped, flattened, and never stores an empty message as text", () => {
  assert.equal(excerptOf(null), null);
  assert.equal(excerptOf("   "), null);
  assert.equal(excerptOf("a\n  b\t c"), "a b c");
  assert.equal(excerptOf("x".repeat(MAX_EXCERPT))?.length, MAX_EXCERPT);
  const long = excerptOf("y".repeat(MAX_EXCERPT + 200));
  assert.equal(long?.length, MAX_EXCERPT + 1);
  assert.ok(long?.endsWith("…"));
});

test("the shipped SQL is SQLite, not Postgres in disguise", () => {
  for (const sql of [CLAIM_SQL, MARK_SQL, RETRIEVE_SQL, COUNTS_SQL, TABLE_PROBE_SQL]) {
    assert.equal(/\$\d/.test(sql), false, `no $n placeholders: ${sql.slice(0, 40)}`);
    assert.equal(/jsonb|::|ILIKE|FOR UPDATE|now\(\)|interval '/i.test(sql), false, sql.slice(0, 40));
    assert.equal(/select \*/i.test(sql), false, "no SELECT *");
  }
  assert.equal((CLAIM_SQL.match(/\?/g) ?? []).length, 5);
  assert.equal((MARK_SQL.match(/\?/g) ?? []).length, 3);
  assert.ok(
    /on conflict \(update_id\) do update set .* where telegram_updates\.outcome = 'failed' returning update_id, attempt$/i.test(CLAIM_SQL),
    "the claim must be insert-or-retry-a-failed-row, in one statement",
  );
  assert.ok(/attempt = telegram_updates\.attempt \+ 1/i.test(CLAIM_SQL), "the retry counter is incremented by the statement, never read-then-written");
  assert.ok(/sum\(attempt\)/i.test(COUNTS_SQL), "/stats reads the retry total out of the same GROUP BY");
  assert.ok(/and outcome = 'claimed'/i.test(MARK_SQL), "the one-way-door guard must stay in the statement");
});

test("claim: one row back means first delivery, an empty set means redelivery", async () => {
  const { db, table } = makeFakeD1();
  const store = new D1TestStore(db);
  const first = await store.claim({ updateId: 7, senderId: 11, chatId: 11, kind: "message", textExcerpt: "hello" });
  const second = await store.claim({ updateId: 7, senderId: 11, chatId: 11, kind: "message", textExcerpt: "hello" });
  assert.deepEqual(first, { claimed: true, attempt: 1 });
  assert.deepEqual(second, { claimed: false, attempt: 0 });
  assert.equal(table.length, 1, "a redelivery must not create a second row");
  assert.equal(table[0].text_excerpt, "hello");

  // …and the retry half, which is what `attempt` exists for: a `failed` row is work left undone, and
  // before migration 0002 it was indistinguishable from a finished one for the next delivery.
  await store.mark(7, "failed", "NETWORK");
  const retry = await store.claim({ updateId: 7, senderId: 11, chatId: 11, kind: "message", textExcerpt: "hello again" });
  assert.deepEqual(retry, { claimed: true, attempt: 2 }, "a failed row is re-claimable and the attempt number comes from the statement");
  assert.equal(table.length, 1, "re-claiming updates the row, it never adds one");
  assert.equal(table[0].error_code, null, "re-claiming clears the previous failure");
  assert.equal(table[0].text_excerpt, "hello again");
});

test("mark: handled once, and a stale retry is refused by the guard", async () => {
  const { db, table } = makeFakeD1();
  const store = new D1TestStore(db);
  await store.claim({ updateId: 8, senderId: 11, chatId: 11, kind: "message", textExcerpt: "t" });
  assert.equal(await store.mark(8, "handled"), true);
  assert.equal(await store.mark(8, "failed", "LATE"), false, "an already-terminal row must not move");
  assert.equal(table[0].outcome, "handled");
  assert.equal(table[0].processed_at, "2026-10-18T00:00:01.000Z");
});

test("hasSchema: a table without `attempt` is not ready either — half-migrated must not look healthy", async () => {
  const ok = makeFakeD1();
  assert.equal(await new D1TestStore(ok.db).hasSchema(), true);
  const bare = makeFakeD1([], { missingSchema: true });
  assert.equal(await new D1TestStore(bare.db).hasSchema(), false);
  // 0001 applied and 0002 not: every claim would then die on a SQL error, while a table-only probe
  // would still have answered `database:"ok"` — the operator would look in exactly the wrong place.
  const halfMigrated = makeFakeD1([], { missingMigration: true });
  assert.equal(await new D1TestStore(halfMigrated.db).hasSchema(), false);
  // a binding that cannot answer PRAGMA at all counts as not ready, never as ready-and-about-to-fail
  const noPragma = {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => {
          if (sql === COLUMN_PROBE_SQL) throw new Error("no pragma support");
          return { results: [{ name: "telegram_updates" }] };
        },
        run: async () => ({ meta: {} }),
      }),
    }),
  };
  assert.equal(await new D1TestStore(noPragma as never).hasSchema(), false);
});

test("recentForSender retrieves the test message, newest first and bounded", async () => {
  const { db, log } = makeFakeD1();
  const store = new D1TestStore(db);
  for (const id of [1, 2, 3]) await store.claim({ updateId: id, senderId: 21, chatId: 21, kind: "message", textExcerpt: `msg ${id}` });
  const got = await store.recentForSender(21, 2);
  assert.equal(got.length, 2);
  assert.equal(got[0].updateId, 3);
  assert.equal(got[0].textExcerpt, "msg 3");
  assert.deepEqual(await store.counts(), { rows: 3, handled: 0, failed: 0, claimed: 3, retries: 0 });
  // the LIMIT is a bind parameter and is clamped, so no call can ask for the whole table
  await store.recentForSender(21, 10_000);
  assert.deepEqual(log.at(-1)?.values, [21, 20]);
  assert.equal((log.at(-1)?.sql.match(/LIMIT \?/) ?? []).length, 1);
});

test("handleTestUpdate: claim, answer, close — and a duplicate never re-answers", async () => {
  const { db, table } = makeFakeD1();
  const store = new D1TestStore(db);
  const sent: { chat: string; text: string }[] = [];
  const answered: string[] = [];
  const api = {
    sendMessage: async (chatId: string, text: string) => {
      sent.push({ chat: chatId, text });
      return { message_id: 1 };
    },
    answerCallbackQuery: async (id: string) => void answered.push(id),
  } as never;
  const log: Record<string, unknown>[] = [];
  const update = { update_id: 31, message: { chat: { id: 11 }, from: { id: 11 }, text: "خرید EURUSD 1.5" } } as never;

  const r1 = await handleTestUpdate({ store, api }, update, "req-1", (e) => log.push(e));
  assert.equal(r1.status, 200);
  const body1 = await r1.json(); // read once: a Response body is a stream, not a value
  assert.equal(body1.status, "success");
  assert.deepEqual(body1.data, { accepted: true, storage: "d1-test", command: "record", attempt: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, "11");
  assert.match(sent[0].text, /✓ ثبت شد \(حالت تست خصوصی D1\)/, "the record ack is in the product's primary locale");
  assert.match(sent[0].text, /PostgreSQL نیاز دارند/, "and it still states, in the same message, what this build cannot do");
  assert.equal(table[0].outcome, "handled");
  assert.equal(log.some((e) => e["event"] === "telegram.test_update_handled"), true);

  const r2 = await handleTestUpdate({ store, api }, update, "req-2", (e) => log.push(e));
  assert.equal(r2.status, 200);
  assert.equal((await r2.json() as { data: { duplicate?: boolean } }).data.duplicate, true);
  assert.equal(sent.length, 1, "a redelivery must not answer twice");

  // the trade-looking sentence is stored as text only: no journal service exists to act on it
  assert.equal((await store.counts()).handled, 1);
});

test("handleTestUpdate: /stats reads the store; a callback keeps its data out of the record", async () => {
  const { db, table } = makeFakeD1();
  const store = new D1TestStore(db);
  await store.claim({ updateId: 40, senderId: 31, chatId: 31, kind: "message", textExcerpt: "first" });
  const sent: string[] = [];
  const api = {
    sendMessage: async (_c: string, text: string) => {
      sent.push(text);
      return { message_id: 1 };
    },
    answerCallbackQuery: async () => undefined,
  } as never;
  await handleTestUpdate({ store, api }, { update_id: 41, message: { chat: { id: 31 }, from: { id: 31 }, text: "/stats" } } as never, "r", () => undefined);
  // 2, not 1: the /stats delivery itself is claimed before the count is read, and the
  // earlier row is still `claimed`. The reply must reflect the store, not flatter it.
  assert.match(sent[0] ?? "", /claimed=2/);

  const cb = await handleTestUpdate(
    { store, api },
    { update_id: 42, callback_query: { id: "cb-9", from: { id: 31 }, data: "confirm:999", message: { chat: { id: 31 } } } } as never,
    "r",
    () => undefined,
  );
  assert.equal(cb.status, 200);
  const row = table.find((r) => r.update_id === 42);
  assert.equal(row?.text_excerpt, null, "callback data is untrusted input and is not stored as text");
  assert.equal(row?.update_kind, "callback_query");
});

test("handleTestUpdate: a Bot API failure marks the row failed and answers 502, never silently ok", async () => {
  const { db, table } = makeFakeD1();
  const store = new D1TestStore(db);
  const api = {
    sendMessage: async () => {
      throw new Error("429TooManyRequests");
    },
    answerCallbackQuery: async () => undefined,
  } as never;
  const log: Record<string, unknown>[] = [];
  const res = await handleTestUpdate({ store, api }, { update_id: 51, message: { chat: { id: 1 }, from: { id: 1 }, text: "hi" } } as never, "r", (e) => log.push(e));
  assert.equal(res.status, 502);
  assert.equal(table[0].outcome, "failed");
  // The stored code is the provider's own, not a catch-all label, so the row and the log agree.
  assert.equal(table[0].error_code, "unknown");
  assert.equal(log.some((e) => e["event"] === "telegram.test_update_failed"), true);
  assert.ok(!JSON.stringify(log).includes("429TooManyRequests"), "the provider message is not echoed to logs");
  const failure = log.find((e) => e["event"] === "telegram.test_update_failed") as Record<string, unknown>;
  assert.equal(failure["code"], "unknown", "an error without a Telegram code is recorded as unknown, not swallowed");

  // and a TelegramApiError-shaped failure carries its code, which is what an operator needs
  const { db: db2, table: table2 } = makeFakeD1();
  const api2 = {
    sendMessage: async () => {
      throw Object.assign(new Error("request to https://bot.example/bot1234:secret/sendMessage failed"), { code: "NETWORK" });
    },
    answerCallbackQuery: async () => undefined,
  } as never;
  const log2: Record<string, unknown>[] = [];
  await handleTestUpdate({ store: new D1TestStore(db2), api: api2 }, { update_id: 52, message: { chat: { id: 1 }, from: { id: 1 }, text: "hi" } } as never, "r2", (e) => log2.push(e));
  assert.equal((log2.find((e) => e["event"] === "telegram.test_update_failed") ?? {})["code"], "NETWORK");
  assert.ok(!JSON.stringify(log2).includes("bot1234:secret"), "the URL, and so the token, never reaches the log");
  assert.equal(table2[0].outcome, "failed");
});

test("handleTestUpdate: an update with no attested sender is dropped before any write", async () => {
  const { db, table, log } = makeFakeD1();
  const store = new D1TestStore(db);
  const api = { sendMessage: async () => ({}), answerCallbackQuery: async () => undefined } as never;
  const res = await handleTestUpdate({ store, api }, { update_id: 61, message: { chat: { id: 1 } } } as never, "r", () => undefined);
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { data: { reason?: string } }).data.reason, "SENDER_UNVERIFIED");
  assert.equal(table.length, 0);
  assert.equal(log.length, 0, "nothing is written, so nothing is issued");
});

test("D1_DISABLED_FEATURES names exactly what the test surface cannot do", () => {
  assert.deepEqual([...D1_DISABLED_FEATURES].sort(), ["ai", "audit", "journal", "linking", "trades"]);
});
test("handleTestUpdate: a failed reply is retried by the next delivery, and /stats reports the retry", async () => {
  const { db, table } = makeFakeD1();
  const store = new D1TestStore(db);
  let broken = true;
  const api = {
    sendMessage: async (_chat: string, _text: string) => {
      if (broken) throw Object.assign(new Error("connection reset"), { code: "NETWORK" });
      return { message_id: 7 };
    },
    answerCallbackQuery: async () => undefined,
  } as never;
  const update = { update_id: 61, message: { chat: { id: 11 }, from: { id: 11 }, text: "/start" } } as never;
  const log: Record<string, unknown>[] = [];

  const first = await handleTestUpdate({ store, api }, update, "req-a", (e) => log.push(e));
  assert.equal(first.status, 502, "a reply that could not be sent is not a success");
  assert.equal(table[0].outcome, "failed");
  assert.equal(table[0].attempt, 1);
  assert.equal(((await first.json()) as { error: { details?: Record<string, unknown> } }).error.details?.["attempt"], 1);

  broken = false;
  const retry = await handleTestUpdate({ store, api }, update, "req-b", (e) => log.push(e));
  assert.equal(retry.status, 200, "the redelivery does the work the first delivery could not");
  const body = (await retry.json()) as { data: { accepted: boolean; duplicate?: boolean; attempt: number } };
  assert.equal(body.data.accepted, true);
  assert.equal(body.data.duplicate, undefined, "a retry of a failed row is not reported as a duplicate");
  assert.equal(body.data.attempt, 2);
  assert.equal(table.length, 1, "and it is still exactly one row for one update_id");
  assert.equal(table[0].outcome, "handled");
  assert.deepEqual(await store.counts(), { rows: 1, handled: 1, failed: 0, claimed: 0, retries: 1 });
  assert.ok(log.some((e) => e["event"] === "telegram.test_update_failed" && e["code"] === "NETWORK"));
  assert.ok(log.some((e) => e["event"] === "telegram.test_update_handled" && e["attempt"] === 2));

  // a third delivery of the same update is now a duplicate again: success is terminal
  const third = await handleTestUpdate({ store, api }, update, "req-c", () => undefined);
  assert.equal((await third.json() as { data: { duplicate?: boolean } }).data.duplicate, true);
  assert.equal(table[0].attempt, 2, "a duplicate does not bump the attempt counter");
});

test("handleTestUpdate: a store that cannot write answers 503 and never claims success", async () => {
  // The other half of "a DB error must not become a false success": if the *claim* fails there is
  // no row at all, so the answer has to be an error status — a 200 here tells Telegram to stop
  // redelivering an update that was never recorded, and the message vanishes with no trace.
  const store = {
    claim: async () => {
      throw new Error("D1_OVER_CAPACITY");
    },
    mark: async () => {
      throw new Error("must not be reached");
    },
    counts: async () => {
      throw new Error("must not be reached");
    },
    recentForSender: async () => [],
  } as never;
  const sent: string[] = [];
  const api = {
    sendMessage: async (_c: string, text: string) => {
      sent.push(text);
      return { message_id: 1 };
    },
    answerCallbackQuery: async () => undefined,
  } as never;
  const log: Record<string, unknown>[] = [];
  const res = await handleTestUpdate(
    { store, api },
    { update_id: 71, message: { chat: { id: 11 }, from: { id: 11 }, text: "یک پیام متنی" } } as never,
    "req-x",
    (e) => log.push(e),
  );
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: { code: string; details?: Record<string, unknown> } };
  assert.equal(body.error.code, "D1_UNAVAILABLE");
  assert.equal(sent.length, 0, "nothing is answered when nothing was recorded");
  assert.ok(log.some((e) => e["event"] === "telegram.test_update_claim_failed"), "the failure is logged as its own event");
  assert.ok(!JSON.stringify(log).includes("یک پیام متنی"), "the message text is never logged");
});
