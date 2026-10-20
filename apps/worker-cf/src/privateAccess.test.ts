// Private test mode: who may use this bot, and what a refusal is allowed to touch.
//
// The properties under test are the ones the owner asked for, stated as code:
//   * authority comes from `from.id` of a schema-validated update and from nothing else;
//   * the check runs before the runtime is composed, so a refused sender cannot reach
//     the pool, the claim or a query;
//   * a broken gate fails closed for everyone rather than degrading into a public bot;
//   * no response body and no log line carries a Telegram user id.
//
// The handler tests deliberately use an env with no HYPERDRIVE binding. That is what makes
// the ordering observable: the pipeline's own answer for a DB-less deployment is
// 503 TELEGRAM_NOT_CONFIGURED, so a 200 can only have come from the gate — which means no
// database call happened, without needing a database to prove it.
import assert from "node:assert/strict";
import { test } from "node:test";

import worker from "./index.js";
import { accessState, decideAccess, senderOf, TEST_USER_ID_KEY } from "./privateAccess.js";

const OWNER = "8795186017";
const STRANGER = "111111111";

const msgUpdate = (fromId: number | null, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  update_id: 4242,
  message: {
    message_id: 7,
    date: 1_790_000_000,
    chat: { id: fromId ?? 1, type: "private" },
    ...(fromId === null ? {} : { from: { id: fromId, is_bot: false, first_name: "someone" } }),
    ...extra,
  },
});

const ctx = { waitUntil: (_p: Promise<unknown>): void => {} };

const post = async (body: string, env: Record<string, string>, secret = "test-webhook-secret-0123456789-ab") => {
  const res = await worker.fetch(
    new Request("https://bot.test/api/v1/webhooks/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body,
    }),
    { TELEGRAM_UPDATE_MODE: "webhook", APP_ENV: "development", TELEGRAM_WEBHOOK_SECRET: secret, ...env } as never,
    ctx as never,
  );
  const text = await res.text();
  return { status: res.status, text };
};

const baseEnv = (gate: string | undefined): Record<string, string> => {
  const env: Record<string, string> = { TELEGRAM_BOT_TOKEN: "123456:AA_fake_fake_fake_fake_fake_fake_fake1" };
  if (gate !== undefined) env[TEST_USER_ID_KEY] = gate;
  return env;
};

const captureLogs = async <T>(fn: () => Promise<T>): Promise<{ out: T; logs: string[] }> => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.map(String).join(" "));
  };
  try {
    return { out: await fn(), logs };
  } finally {
    console.log = original;
  }
};

// ── the gate's own configuration ─────────────────────────────────────────────

test("an unset gate is not an open gate: it refuses everything", () => {
  for (const raw of [undefined, "", "   ", "\n"]) {
    const s = accessState({ [TEST_USER_ID_KEY]: raw } as never);
    assert.equal(s.valid, false, `raw=${JSON.stringify(raw)} must not be valid`);
    assert.equal(s.configured, false);
    const d = decideAccess(s, null);
    assert.equal(d.allow, false);
    assert.equal(d.status, 503);
    if (!d.allow) assert.equal(d.code, "ACCESS_GATE_UNCONFIGURED");
  }
});

test("a malformed gate is rejected, not coerced", () => {
  const bad = [
    "not-a-number",
    "-5",
    "0",
    "007", // leading zero: not how Telegram ids are written
    "1e10",
    "12.5",
    "1,234",
    "12 34",
    "8795186017; DROP TABLE trades", // injection attempts are just invalid ids
    "8795186017,111111111", // a list is not an id
    "9007199254740993", // beyond exact integer representation
    "x".repeat(300),
  ];
  for (const raw of bad) {
    const s = accessState({ [TEST_USER_ID_KEY]: raw } as never);
    assert.equal(s.valid, false, `must reject ${JSON.stringify(raw.slice(0, 24))}`);
    assert.equal(s.configured, true, "it IS set, it is just not usable");
    const d = decideAccess(s, null);
    assert.equal(d.allow, false);
    if (!d.allow) assert.equal(d.code, "ACCESS_GATE_INVALID", `raw=${raw.slice(0, 16)}`);
  }
});

test("surrounding whitespace is tolerated, because secrets get pasted", () => {
  assert.equal(accessState({ [TEST_USER_ID_KEY]: `  ${OWNER}\n` } as never).valid, true);
});

test("the state object never carries the id anywhere but userId", () => {
  const s = accessState({ [TEST_USER_ID_KEY]: OWNER } as never);
  assert.deepEqual(Object.keys(s).sort(), ["configured", "note", "userId", "valid"]);
  assert.equal(s.userId, OWNER);
});

// ── who the update is from ───────────────────────────────────────────────────

test("senderOf reads the fields Telegram attests, in priority order", () => {
  assert.equal(senderOf(msgUpdate(7) as never), 7);
  assert.equal(senderOf({ update_id: 1, edited_message: { message_id: 1, date: 1, chat: { id: 7, type: "private" }, from: { id: 7 } } } as never), 7);
  assert.equal(
    senderOf({ update_id: 1, callback_query: { id: "c", from: { id: 9 }, data: "confirm:1" } } as never),
    9,
  );
  assert.equal(senderOf({ update_id: 1 } as never), null, "no message at all → no sender");
});

test("a message with no `from` is refused, not treated as the owner", () => {
  const s = accessState({ [TEST_USER_ID_KEY]: OWNER } as never);
  const d = decideAccess(s, msgUpdate(null) as never);
  assert.equal(d.allow, false);
  if (!d.allow) {
    assert.equal(d.code, "SENDER_UNVERIFIED");
    assert.equal(d.status, 200, "a refusal answers 200 so Telegram stops redelivering");
  }
});

test("an unsafe sender id is refused instead of mis-compared", () => {
  const s = accessState({ [TEST_USER_ID_KEY]: "9007199254740992" } as never);
  assert.equal(s.valid, false, "the gate itself refuses to be that large");
  // And a gate that is fine cannot be matched by an unrepresentable sender either.
  const g = accessState({ [TEST_USER_ID_KEY]: OWNER } as never);
  const d = decideAccess(g, msgUpdate(9007199254740992) as never);
  assert.equal(d.allow, false);
  if (!d.allow) assert.ok(["SENDER_ID_UNSAFE", "UNAUTHORIZED_SENDER"].includes(d.code), d.code);
});

test("the owner's id matches; any other id does not", () => {
  const s = accessState({ [TEST_USER_ID_KEY]: OWNER } as never);
  assert.equal(decideAccess(s, msgUpdate(Number(OWNER)) as never).allow, true);
  const d = decideAccess(s, msgUpdate(Number(STRANGER)) as never);
  assert.equal(d.allow, false);
  if (!d.allow) assert.equal(d.code, "UNAUTHORIZED_SENDER");
});

test("authority is not in the message text", () => {
  const s = accessState({ [TEST_USER_ID_KEY]: OWNER } as never);
  // A stranger typing the owner's id — in text, in caption, in callback data, in a
  // forged chat id — must still be a stranger.
  const attempts = [
    msgUpdate(Number(STRANGER), { text: `/start ${OWNER}` }),
    msgUpdate(Number(STRANGER), { text: `from.id: ${OWNER}` }),
    msgUpdate(Number(STRANGER), { caption: OWNER }),
    { update_id: 1, callback_query: { id: "c", from: { id: Number(STRANGER) }, data: `confirm:${OWNER}` } },
    { update_id: 1, message: { message_id: 1, date: 1, from: { id: Number(OWNER) }, chat: { id: Number(OWNER), type: "private" }, forward_from: { id: Number(OWNER) } } },
  ];
  // Only the last one IS the owner (its `from.id` is), everything else is a stranger.
  attempts.slice(0, 4).forEach((u, i) => {
    const d = decideAccess(s, u as never);
    assert.equal(d.allow, false, `attempt ${i} must be refused`);
  });
  assert.equal(decideAccess(s, attempts[4] as never).allow, true);
});

// ── the handler, which is where ordering is real ────────────────────────────

test("unauthorized sender: 200, dropped, and never reaching the pipeline", async () => {
  const { out, logs } = await captureLogs(() => post(JSON.stringify(msgUpdate(Number(STRANGER), { text: "/start" })), baseEnv(OWNER)));
  assert.equal(out.status, 200, `gate must answer before the DB-less pipeline: ${out.text}`);
  assert.match(out.text, /"dropped":true/);
  assert.match(out.text, /UNAUTHORIZED_SENDER/);
  assert.doesNotMatch(out.text, /TELEGRAM_NOT_CONFIGURED/, "a refusal must not look like a deployment fault");
  assert.equal(logs.filter((l) => l.includes("telegram.access_denied")).length, 1);
  assert.ok(!logs.some((l) => l.includes(STRANGER) || l.includes(OWNER)), "no user id in any log line");
});

test("authorized sender with no database: reaches the pipeline and fails closed", async () => {
  const out = await post(JSON.stringify(msgUpdate(Number(OWNER), { text: "/start" })), baseEnv(OWNER));
  assert.equal(out.status, 503);
  assert.match(out.text, /TELEGRAM_NOT_CONFIGURED/, "proof the gate let it through to the pipeline");
});

test("broken gate: every sender is refused with 503, even the owner", async () => {
  for (const gate of [undefined, "abc", "1,2"]) {
    const { out, logs } = await captureLogs(() => post(JSON.stringify(msgUpdate(Number(OWNER))), baseEnv(gate)));
    assert.equal(out.status, 503, `gate=${String(gate)}`);
    assert.match(out.text, /ACCESS_GATE_(UNCONFIGURED|INVALID)/);
    assert.equal(logs.filter((l) => l.includes("telegram.access_gate_refused")).length, 1);
  }
});

test("the gate answers before parsing costs anything: malformed body still refused", async () => {
  // Gate invalid → the body is not even parsed, so garbage gets the gate's 503 rather
  // than the pipeline's malformed handling.
  const out = await post("{not json", baseEnv(undefined));
  assert.equal(out.status, 503);
  assert.match(out.text, /ACCESS_GATE_UNCONFIGURED/);
});

test("a schema-valid but semantically empty update is dropped, not processed", async () => {
  const out = await post(JSON.stringify({ update_id: 99 }), baseEnv(OWNER));
  assert.equal(out.status, 200);
  assert.match(out.text, /SENDER_UNVERIFIED/);
});

test("health and ready disclose the mode without disclosing the id", async () => {
  const armed = await worker.fetch(
    new Request("https://bot.test/health"),
    baseEnv(OWNER) as never,
    ctx as never,
  );
  const armedBody = await armed.text();
  assert.equal(armed.status, 200, "liveness does not depend on the gate");
  assert.match(armedBody, /"mode":"private-test"/);
  assert.match(armedBody, /"access":"armed"/);
  assert.ok(!armedBody.includes(OWNER), "the id must not appear in /health");

  const readyArmed = await worker.fetch(new Request("https://bot.test/ready"), baseEnv(OWNER) as never, ctx as never);
  assert.equal(readyArmed.status, 503, "no database, so not ready — for either mode");
  const readyBody = await readyArmed.text();
  assert.match(readyBody, /"note":"ok"/);
  assert.ok(!readyBody.includes(OWNER));

  const readyBare = await worker.fetch(new Request("https://bot.test/ready"), baseEnv(undefined) as never, ctx as never);
  assert.equal(readyBare.status, 503);
  assert.match(await readyBare.text(), /"configured":false/);
});

test("an unarmed gate cannot be read as ready: the reason names the blocker", async () => {
  // The status alone was not enough. On the platform the database answers fine, and
  // `checks.reason` used to say "ok" while every sender — the owner included — was
  // refused. Anything grepping that string would have called the deployment ready.
  // So: with a working D1 and a closed gate, the reason must name the gate.
  const armed = [];
  const closed = await worker.fetch(
    new Request("https://bot.test/ready"),
    { ...baseEnv(undefined), VELORA_TEST_DB: recordingD1(armed) } as never,
    ctx as never,
  );
  assert.equal(closed.status, 503, "unarmed => not ready");
  const body = await closed.text();
  assert.match(body, /"storage":"d1-test"/, `the store has to be the working one for this to mean anything: ${body.slice(0, 160)}`);
  assert.match(body, /"database":"ok"/);
  assert.match(body, /"reason":"ACCESS_GATE_UNCONFIGURED"/);
  assert.ok(!/"reason":"ok"/.test(body), `no field may still claim ok: ${body.slice(0, 160)}`);
  // Readiness probes the schema and nothing else: the table probe plus the migration-0002 column
  // probe, two reads, and no write. (Before `attempt` existed this was a single statement.)
  assert.equal(armed.length, 2, `two read-only probes, got ${JSON.stringify(armed)}`);
  assert.match(armed[0], /sqlite_master/, "the table probe is the first check");
  assert.match(armed[1], /^PRAGMA table_info/i, "and the column probe is what proves the schema is current");
  for (const sql of armed) assert.ok(!/^(INSERT|UPDATE|DELETE|CREATE|DROP)/i.test(sql), "readiness writes nothing");

  // A malformed secret is a different fault and must read differently.
  const bad = await worker.fetch(
    new Request("https://bot.test/ready"),
    { ...baseEnv("777001, 777002"), VELORA_TEST_DB: recordingD1([]) } as never,
    ctx as never,
  );
  assert.equal(bad.status, 503);
  assert.match(await bad.text(), /"reason":"ACCESS_GATE_INVALID"/);

  // With no database at all, the database stays the named fault — the gate does not
  // overwrite a more specific problem — but "ok" is still absent from the body.
  const bare = await worker.fetch(new Request("https://bot.test/ready"), baseEnv(undefined) as never, ctx as never);
  assert.equal(bare.status, 503);
  const bareBody = await bare.text();
  assert.match(bareBody, /"reason":"NO_DATABASE_BINDING"/);
  assert.ok(!/"reason":"ok"/.test(bareBody));
});

test("diagnostics reports the gate shape, never its value", async () => {
  const admin = "admin-token-0123456789-abcdefghij";
  const res = await worker.fetch(
    new Request("https://bot.test/api/v1/telegram/diagnostics", { headers: { authorization: `Bearer ${admin}` } }),
    { ...baseEnv(OWNER), WORKER_ADMIN_TOKEN: admin } as never,
    ctx as never,
  );
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /"mode":"private-test"/);
  assert.match(body, /"valid":true/);
  assert.ok(!body.includes(OWNER), "diagnostics must not echo the allowed id");
});
// ── the same ordering, proven against a database-shaped binding ─────────────
// The tests above show the gate answers before the pipeline. These show something narrower and
// harder: with the D1 test store bound, a refused sender issues **zero statements**, and the
// statements the owner's delivery does issue are only the two the test surface owns — never a
// trade, journal or audit table, because nothing in this path names one.
const recordingD1 = (log: string[]) => {
  const answer = (sql: string): unknown[] => {
    if (sql.includes("sqlite_master")) return [{ name: "telegram_updates" }];
    // `hasSchema()` also proves migration 0002 (the `attempt` column), so a fake that stands for a
    // provisioned database has to answer the column probe too — otherwise a case that means to
    // exercise the gate is silently exercising `D1_SCHEMA_MISSING` instead.
    if (sql.startsWith("PRAGMA")) {
      return ["update_id", "sender_id", "chat_id", "update_kind", "text_excerpt", "received_at",
        "processed_at", "outcome", "error_code", "attempt"].map((name) => ({ name }));
    }
    if (sql.startsWith("INSERT INTO telegram_updates")) return [{ update_id: 4242, outcome: "claimed" }];
    if (sql.includes("count(*)")) return [{ outcome: "handled", rows: 1 }];
    if (sql.startsWith("SELECT")) return [{ update_id: 4242, outcome: "handled" }];
    return [];
  };
  return {
    prepare: (sql: string) => ({
      bind: (..._v: unknown[]) => ({
        all: async () => {
          log.push(sql);
          return { results: answer(sql) };
        },
        run: async () => {
          log.push(sql);
          return { meta: { changes: 1 } };
        },
      }),
    }),
  } as never;
};

const withStubBotApi = async <T>(fn: (base: string, sends: Record<string, unknown>[]) => Promise<T>): Promise<T> => {
  const { createServer } = await import("node:http");
  const sends: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        sends.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        sends.push({});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: 1, chat_id: Number(OWNER), date: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  try {
    return await fn(base, sends);
  } finally {
    server.close();
  }
};

test("D1 binding, refused sender: zero statements reach the database", async () => {
  await withStubBotApi(async (base) => {
    for (const [label, env2, body] of [
      ["unauthorized sender", baseEnv(OWNER), JSON.stringify(msgUpdate(Number(STRANGER), { text: "/start" }))],
      ["gate unset", baseEnv(undefined), JSON.stringify(msgUpdate(Number(OWNER), { text: "/start" }))],
      ["gate malformed", baseEnv("1,2"), JSON.stringify(msgUpdate(Number(OWNER), { text: "/start" }))],
      ["no attested sender", baseEnv(OWNER), JSON.stringify(msgUpdate(null))],
      ["unparseable body", baseEnv(OWNER), "{not json"],
    ] as [string, Record<string, string>, string][]) {
      const log: string[] = [];
      const { out } = await captureLogs(() => post(body, { ...env2, TELEGRAM_API_BASE: base, VELORA_TEST_DB: recordingD1(log) } as never as Record<string, string>));
      assert.ok([200, 400, 503].includes(out.status), `${label}: status ${out.status}`);
      assert.equal(log.length, 0, `${label} must not touch D1, issued: ${JSON.stringify(log)}`);
      if (label === "unparseable body") assert.match(out.text, /VALIDATION_FAILED/, "the d1 path keeps the pipeline's malformed contract");
    }
  });
});

test("D1 binding, the owner's delivery: claim then mark, and no trade table anywhere", async () => {
  await withStubBotApi(async (base, sends) => {
    const log: string[] = [];
    // a plain message, so this exercises the ack path; the /stats read-only path is covered in
    // d1TestStore.test.ts, where its count is asserted against the store
    const { out, logs } = await captureLogs(() => post(JSON.stringify(msgUpdate(Number(OWNER), { text: "سلام test" })), { ...baseEnv(OWNER), TELEGRAM_API_BASE: base, VELORA_TEST_DB: recordingD1(log) } as never as Record<string, string>));
    assert.match(out.text, /"accepted":true/, out.text.slice(0, 120));
    assert.equal(log[0]?.startsWith("INSERT INTO telegram_updates"), true, "the claim is the first thing the store is asked to do");
    assert.ok(log.some((s) => /UPDATE telegram_updates SET outcome/.test(s)), "and the row is closed out");
    assert.equal(log.filter((s) => /^INSERT|^UPDATE|^DELETE|^CREATE|^DROP/i.test(s)).length, 2, `exactly one write + one mark: ${JSON.stringify(log.map((s) => s.slice(0, 24)))}`);
    assert.ok(!log.some((s) => /trades|trade_events|audit_log|journal|users/i.test(s)), "the D1 path never names a business table");
    assert.equal(sends.length, 1, "one reply, to one chat");
    const text = String((sends[0] as { text?: string }).text ?? "");
    assert.match(text, /✓ ثبت شد \(حالت تست خصوصی D1\)/, "the ack says what happened, in the product's primary locale");
    assert.match(text, /PostgreSQL/, "and states what this storage cannot do");
    // The reply text must not carry the id. The outbound request itself DOES name the chat —
    // chat_id is how Telegram addresses a message, so asserting otherwise would be nonsense;
    // what matters is that it goes to the Bot API and no further (no log, no response body).
    assert.ok(!text.includes(OWNER), "the reply text never echoes the user id");
    assert.ok(!logs.some((l) => l.includes(OWNER)), "no log line carries the id");
    assert.ok(!out.text.includes(OWNER), "the response never echoes the user id");
  });
});
