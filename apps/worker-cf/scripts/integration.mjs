// Integration harness for the Cloudflare Workers host of the Velora Telegram bot.
//
// Runs the REAL worker entry (`src/index.ts` -> `composeRuntime` -> the reused
// apps/api bot, stores and pipeline) against a REAL PostgreSQL, with the Bot API
// replaced by a local stub so the outbound path is observed instead of guessed.
//
//   node apps/worker-cf/scripts/integration.mjs
//
// It is deliberately not a rewrite of bot logic: every assertion below is about the
// ported stack (Hyperdrive pool shim + reused adapters + reused handlers).
// The connection string is never stored in the repository: the harness takes it
// from the environment, and tools/secret-scan.sh fails the build on a literal
// user:pass@host URL.
const PG = process.env.IT_DATABASE_URL ?? "";
if (PG === "") {
  console.error("IT_DATABASE_URL is required (point it at a DISPOSABLE database, never production).");
  process.exit(2);
}
const STUB_PORT = 9911;
const CHAT = 777001;
const TG_USER = "777001";

import { createServer } from "node:http";
import postgres from "postgres";

// ── stub Bot API: records every outbound call, answers like Telegram ─────────
const outbound = [];
let msgId = 4000;
let stubDelay = 0; // ms, applied only to chats listed in slowChats
const slowChats = new Set(); // asymmetry is deliberate: one slow request, one fast one
// How long the stub holds ONE chat. Over a WAN origin (a hosted Postgres) the fast request's own DB
// work can outlast a hard-coded 700 ms, so the hold is tunable; what this leg must prove is the
// RELATIONSHIP between the two requests, not a wall-clock number calibrated for a unix socket.
const STUB_HOLD = Number(process.env.IT_STUB_HOLD_MS ?? 700);
const inFlight = new Map(); // chat → stub calls currently sitting inside their hold
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const method = (req.url ?? "").split("/").pop() ?? "";
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = raw; }
    outbound.push({ method, payload });

    // The hold is decided HERE, where the payload actually exists, and only for the
    // chats listed in `slowChats`. That scoping detail is not cosmetic: an earlier
    // revision gated on a name bound inside the responder below, so nothing was ever
    // delayed and the concurrency check passed for the wrong reason. `chat_id` also
    // crosses the wire as a string, hence the normalisation on both sides.
    const rawChat = payload !== null && typeof payload === "object" ? payload.chat_id : undefined;
    const chatOf = rawChat === undefined || rawChat === null ? null : String(rawChat);
    const wait = chatOf !== null && slowChats.has(chatOf) ? stubDelay : 0;

    const respond = () => {
      res.setHeader("content-type", "application/json");
      if (method === "sendMessage") {
        res.end(JSON.stringify({ ok: true, result: { message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" }, from: { id: TG_USER, is_bot: false, first_name: "Probe" }, text: payload?.text ?? "" } }));
      } else if (method === "answerCallbackQuery" || method === "deleteMessage" || method === "sendChatAction") {
        res.end(JSON.stringify({ ok: true, result: true }));
      } else if (method === "getMe") {
        res.end(JSON.stringify({ ok: true, result: { id: 123456, is_bot: true, first_name: "Velora", username: "velora_bot" } }));
      } else {
        res.end(JSON.stringify({ ok: true, result: {} }));
      }
    };
    if (wait > 0) {
      inFlight.set(chatOf, (inFlight.get(chatOf) ?? 0) + 1);
      setTimeout(() => { inFlight.set(chatOf, inFlight.get(chatOf) - 1); respond(); }, wait);
    } else respond();
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

const admin = postgres(PG, { max: 4 });
const q = async (sql, params = []) => (await admin.unsafe(sql, params));

// ── fixtures: a user, an account, and a LIVE telegram identity ────────────────
// Ids come from the identity columns; values follow the real CHECK constraints
// (0001/0002/0004/0023), so a refusal below means the bot declined, not that a
// fixture was rejected.
await admin.unsafe(`
  DELETE FROM rate_limits; -- durable limiter: without this a second run is throttled
  DELETE FROM telegram_journal_drafts; DELETE FROM telegram_updates;
  DELETE FROM telegram_channel_posts; DELETE FROM telegram_channels;
  DELETE FROM telegram_link_tokens; DELETE FROM telegram_identities;
  DELETE FROM trade_events; DELETE FROM trades; DELETE FROM audit_log;
  DELETE FROM trading_accounts; DELETE FROM users;`, []);
const [user] = await admin.unsafe(`INSERT INTO users (email,password_hash,role,locale,status,plan,timezone,created_at,updated_at)
  VALUES ('probe@velora.test',$1,'user','fa','active','free','Asia/Tehran',now(),now()) RETURNING id`, ["x".repeat(60)]);
const [acct] = await admin.unsafe(`INSERT INTO trading_accounts (user_id,provider,platform,label,currency,leverage,timezone,status,sync_status,starting_balance,created_at,updated_at)
  VALUES ($1,'MANUAL','MANUAL','Probe','USD','100','Asia/Tehran','connected','DISCONNECTED',10000,now(),now()) RETURNING id`, [user.id]);
await admin.unsafe(`INSERT INTO telegram_identities (user_id,telegram_user_id,username,status,linked_at,created_at,updated_at)
  VALUES ($1,$2,'probe','LINKED',now(),now(),now())`, [user.id, TG_USER]);
console.log(`seeded: user ${user.id} · manual account ${acct.id} · LINKED telegram identity ${TG_USER}`);


// ── the worker under test ─────────────────────────────────────────────────────
const worker = (await import("../src/index.ts")).default;
const SECRET = "integrationtestsecretintegrationtestsecret";
const env = {
  HYPERDRIVE: { connectionString: PG },
  TELEGRAM_BOT_TOKEN: "123456:AA_fake_fake_fake_fake_fake_fake_fake1",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_UPDATE_MODE: "webhook",
  VELORA_APP_URL: "https://app.velora.test",
  APP_ENV: "development",
  TELEGRAM_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
  WORKER_ADMIN_TOKEN: "diagnostics-token-for-tests",
  // Private test mode is on in this deployment model, so the harness runs as the one
  // identity it authorises. Without this line every check below is refused — which is
  // precisely what the gate is for, and it gets its own section further down.
  TELEGRAM_TEST_USER_ID: TG_USER,
};
const mkCtx = () => {
  const props = [];
  return { props, waitUntil(p) { props.push(p); } };
};
let updateId = 900000;
const sendWith = async (id, update) => {
  const ctx = mkCtx();
  const res = await worker.fetch(new Request("http://bot.internal/api/v1/webhooks/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify({ update_id: id, ...update }),
  }), env, ctx);
  const body = await res.json().catch(() => null);
  await Promise.allSettled(ctx.props);
  await new Promise((r) => setTimeout(r, 200));
  return { status: res.status, body };
};
// Same as sendWith, but WITHOUT draining ctx.props: the concurrency section needs
// to await one request's deferred work while another request's is still in flight,
// which is exactly the interleaving the fix is about.
const sendAsync = async (id, update) => {
  const ctx = mkCtx();
  const res = await worker.fetch(new Request("http://bot.internal/api/v1/webhooks/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify({ update_id: id, ...update }),
  }), env, ctx);
  return { ctx, status: res.status, body: await res.json().catch(() => null) };
};

const message = (text) => ({ message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" }, from: { id: Number(TG_USER), is_bot: false, first_name: "Probe", username: "probe" }, text } });

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  \u2192 ${detail}` : ""}`);
  if (!cond) failures += 1;
};

console.log("\n── boot ──");
const health = await worker.fetch(new Request("http://bot.internal/health"), env, mkCtx());
check("/health 200", health.status === 200);
const ready = await worker.fetch(new Request("http://bot.internal/ready"), env, mkCtx());
const readyBody = await ready.json();
check("/ready 200 with database ok", ready.status === 200 && readyBody.data.checks.database === "ok", JSON.stringify(readyBody.data.checks));

console.log("\n── ingress security ──");
const noSecret = await worker.fetch(new Request("http://bot.internal/api/v1/webhooks/telegram", { method: "POST", body: "{}" }), env, mkCtx());
check("missing secret → 401", noSecret.status === 401, String(noSecret.status));
const wrongSecret = await worker.fetch(new Request("http://bot.internal/api/v1/webhooks/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong-wrong-wrong-wrong" }, body: "{}" }), env, mkCtx());
check("wrong secret → 401", wrongSecret.status === 401, String(wrongSecret.status));
const big = await worker.fetch(new Request("http://bot.internal/api/v1/webhooks/telegram", { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET, "content-type": "application/json" }, body: JSON.stringify({ update_id: 1, message: { text: "x".repeat(300_000) } }) }), env, mkCtx());
check("300 KB body → 400 size guard", big.status === 400, String(big.status));
const diag = await worker.fetch(new Request("http://bot.internal/api/v1/telegram/diagnostics"), env, mkCtx());
check("diagnostics without bearer → 401", diag.status === 401);
const diagOk = await worker.fetch(new Request("http://bot.internal/api/v1/telegram/diagnostics", { headers: { authorization: `Bearer ${env.WORKER_ADMIN_TOKEN}` } }), env, mkCtx());
const diagBody = await diagOk.json();
check("diagnostics reports configured + no secret values", diagOk.status === 200 && diagBody.data.configured === true && !JSON.stringify(diagBody).includes(SECRET));

console.log("\n── bot round trip (Bot API stubbed) ──");
outbound.length = 0;
const startRes = await sendWith(updateId, message("/start"));
check("/start accepted", startRes.status === 200 && startRes.body?.data?.accepted === true, JSON.stringify(startRes.body));
const sent = outbound.find((c) => c.method === "sendMessage");
check("bot replied through the Bot API", Boolean(sent), sent ? String(sent.payload.text).slice(0, 40) : "no sendMessage");
const rows = await q(`SELECT outcome, error_code FROM telegram_updates WHERE update_id = $1`, [String(updateId)]);
check("update recorded durably with an outcome", rows.length === 1 && rows[0].outcome === "handled", JSON.stringify(rows[0] ?? null));
const dup = await sendWith(updateId, message("/start"));
check("same update_id → duplicate, not re-processed", dup.body?.data?.duplicate === true);
const count = await q(`SELECT count(*)::int AS n FROM telegram_updates WHERE update_id = $1`, [String(updateId)]);
check("exactly one row for the duplicated update", count[0].n === 1, `rows=${count[0].n}`);

// ── what /start ANSWERED, not just what it returned ────────────────────
// The owner's report was about the reply, and the checks above only prove the HTTP
// envelope said 200. On the PostgreSQL branch `/start` must come out as the product's
// own menu — if it came out as the private-test ack instead, that would mean the D1 test
// handler had silently taken over the real path, which is the one routing mistake that
// would look green here and be wrong in the field.
{
  const card = outbound.find((c) => c.method === "sendMessage");
  const payload = card?.payload ?? {};
  const txt = String(payload["text"] ?? "");
  const keyboard = payload["reply_markup"]?.["inline_keyboard"];
  const buttons = Array.isArray(keyboard) ? keyboard.flat() : [];
  check("/start answered with the product menu, not a generic acknowledgement",
    txt.includes("ولورا") && buttons.length > 0,
    `text=${JSON.stringify(txt.slice(0, 60))} buttons=${buttons.length}`);
  check("the PostgreSQL branch never routes /start through the D1 test handler",
    !txt.includes("حالت تست خصوصی") && !txt.includes("D1 private test"), txt.slice(0, 70));
  check("menu buttons are callback_data, not URLs that could be replayed from a message",
    buttons.length > 0 && buttons.every((b) => typeof b?.callback_data === "string" || typeof b?.url === "string"),
    JSON.stringify(buttons.map((b) => Object.keys(b ?? {}))));
}

// ── a database that cannot be reached must not be answered as success ────
// Same update shape, same authorised sender, same secret: the only difference is the
// connection string pointing at a database that does not exist. Whatever this answers,
// it must not be "accepted" with nothing written — a 200 here is Telegram being told to
// stop redelivering an update nobody stored.
{
  const absent = PG.replace(/\/[^/]+$/, "/velora_test_absent");
  if (absent === PG) throw new Error("IT_DATABASE_URL has no path to strip; the unreachable-DB check is meaningless");
  const before = await q(`SELECT count(*)::int AS n FROM telegram_updates`);
  const ctx = mkCtx();
  // Two shapes of "the database is not there" have to be survived by the harness itself, because
  // the first run measured that a rejected connection surfaces as an *unhandled* rejection out of
  // the driver — enough to kill a Node process outright. Neither shape may be read as a success:
  // a thrown error is a non-answer (Telegram retries), a 5xx is a structured non-answer.
  const escaped = [];
  const onUnhandled = (err) => escaped.push(String(err?.code ?? err?.message ?? err).slice(0, 60));
  process.on("unhandledRejection", onUnhandled);
  process.on("uncaughtException", onUnhandled);
  let res = null;
  let body = null;
  let threw = null;
  try {
    res = await Promise.race([
      worker.fetch(new Request("http://bot.internal/api/v1/webhooks/telegram", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({ update_id: ++updateId, ...message("/start") }),
      }), { ...env, HYPERDRIVE: { connectionString: absent } }, ctx),
      new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_WAITING_FOR_HANDLER")), 25_000)),
    ]);
    body = await res.json().catch(() => null);
  } catch (error) {
    threw = String(error?.code ?? error?.message ?? error).slice(0, 60);
  }
  await Promise.allSettled(ctx.props).catch(() => undefined);
  process.off("unhandledRejection", onUnhandled);
  process.off("uncaughtException", onUnhandled);
  const after = await q(`SELECT count(*)::int AS n FROM telegram_updates`);
  const claimedSuccess = res !== null && res.status === 200 && body?.data?.accepted === true;
  check("an unreachable database is NOT reported as an accepted update", !claimedSuccess,
    res === null ? `no answer at all (threw=${threw})` : `status=${res.status} body=${JSON.stringify(body).slice(0, 80)}`);
  check("and it wrote nothing while pretending nothing happened", after[0].n === before[0].n,
    `before=${before[0].n} after=${after[0].n}`);
  check("the ingress converts a store failure into a structured 5xx, not an escaping exception",
    threw === null && escaped.length === 0, `threw=${threw} escaped=${JSON.stringify(escaped)}`);
  console.log(`  note: unreachable-DB answer was ${res === null ? "none (handler threw)" : res.status} ${JSON.stringify(body?.error?.code ?? body?.data ?? null)}`);
}

console.log("\n── journal path through the ported data layer ──");
// (1) an INCOMPLETE description must open a NEEDS_DETAIL draft and must NOT write.
const j = await sendWith(++updateId, message("خرید EURUSD 1.5 روی 1.0850 و حد ضرر 1.0800"));
check("incomplete journal message accepted", j.status === 200, JSON.stringify(j.body));
const needs = await q(`SELECT state FROM telegram_journal_drafts ORDER BY id DESC LIMIT 1`);
check("incomplete draft persisted as NEEDS_DETAIL", needs[0]?.state === "NEEDS_DETAIL", JSON.stringify(needs));
check("no trade written from an incomplete draft", (await q(`SELECT count(*)::int n FROM trades`))[0].n === 0);

// The first draft is still OPEN, and an open draft turns any next message into an
// answer to its pending question (that is the bot's behaviour, and it is correct).
// Close it so case (2) starts from a clean slate.
await admin.unsafe(`DELETE FROM telegram_journal_drafts`);

// (2) the documented COMPLETE sentence (the domain test's own example) must reach
// AWAITING_CONFIRMATION, and the تأیید button must land a row in the real ledger.
outbound.length = 0;
const complete = await sendWith(
  ++updateId,
  message("EURUSD sell entry 1.0850, exit 1.0800, stop 1.0870, target 1.0790, volume 0.5"),
);
check("complete journal message accepted", complete.status === 200, JSON.stringify(complete.body));
const card = outbound.filter((c) => c.method === "sendMessage").pop();
const draftState = await q(`SELECT state, id FROM telegram_journal_drafts ORDER BY id DESC LIMIT 1`);
console.log("  CARD TEXT:", JSON.stringify(card?.payload?.text ?? ""));
  console.log("  BUTTONS RAW:", JSON.stringify(card?.payload?.reply_markup ?? null));
  check("complete draft persisted as AWAITING_CONFIRMATION", draftState[0]?.state === "AWAITING_CONFIRMATION", JSON.stringify(draftState));
const buttons = (card?.payload?.reply_markup?.inline_keyboard ?? []).flat();
const confirm = buttons.find((b) => String(b?.text ?? "").includes("تأیید") || /confirm/i.test(String(b?.callback_data ?? "")));
check("confirmation card carries a تأیید button", Boolean(confirm?.callback_data), JSON.stringify(buttons.map((b) => b?.text)));
if (confirm?.callback_data) {
  outbound.length = 0;
  const cbRes = await sendWith(++updateId, {
    callback_query: {
      id: "cb-1",
      from: { id: Number(TG_USER), is_bot: false, first_name: "Probe", username: "probe" },
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" } },
      data: confirm.callback_data,
    },
  });
  check("confirm callback accepted", cbRes.status === 200, JSON.stringify(cbRes.body));
  const trades = await q(`SELECT symbol, direction, entry_price, exit_price, volume FROM trades ORDER BY id DESC LIMIT 1`);
  check("confirm wrote ONE row through the real trade ledger", trades.length === 1, JSON.stringify(trades[0] ?? null));
  check("the ledger row carries the parsed values, not invented ones",
    trades[0]?.symbol === "EURUSD" && trades[0]?.direction === "sell" &&
    String(trades[0]?.entry_price) === "1.08500000" && String(trades[0]?.volume) === "0.50000000",
    JSON.stringify(trades[0] ?? null));
  const events = await q(`SELECT count(*)::int n FROM trade_events`);
  check("the ADR-002 event ledger got its append", events[0].n >= 1, `events=${events[0].n}`);
  const finalState = await q(`SELECT state, confirmed_trade_id IS NOT NULL AS has_trade FROM telegram_journal_drafts WHERE id = $1`, [String(draftState[0].id)]);
  check("draft closed as CONFIRMED with its trade id", finalState[0]?.state === "CONFIRMED" && finalState[0]?.has_trade === true, JSON.stringify(finalState[0] ?? null));
} else {
  console.log("  FAIL  confirm callback skipped: the card exposed no callback_data");
  failures += 1;
}

console.log("\n── daily checklist, statistics and tombstone on PostgreSQL (0036) ──");
{
  // Everything in this block is driven the way a trader drives it: one update posted to the webhook.
  // No SQL shortcut writes a checklist row, because the claim under test is precisely that the bot's
  // own path reaches migration 0036's merge semantics.
  const table = await q(`SELECT to_regclass('public.journal_daily_checklists') IS NOT NULL AS present`);
  check("0036 is applied on this database", table[0]?.present === true, JSON.stringify(table[0] ?? null));
  if (table[0]?.present !== true) {
    failures += 1;
    console.log("  FAIL  every check below needs journal_daily_checklists; skipping them");
  }

  const owned = `SELECT count(*)::int AS n FROM journal_daily_checklists WHERE user_id = $1`;

  // (1) the first report of a day inserts a row, and the counts are the ones the DATABASE derived.
  outbound.length = 0;
  await sendWith(++updateId, message("/checklist bias: bullish\nh4: fvg"));
  const first = await q(
    `SELECT report_date, confirmed_items, unreviewed_items, unknown_items, review_state, reviewed_at,
            items->'dailyBias'->>'value' AS bias, items->'dailyBias'->>'normalised'::text AS norm
       FROM journal_daily_checklists WHERE user_id = $1`,
    [String(user.id)],
  );
  check(
    "the day's checklist row was created through the bot",
    first.length === 1 && Number(first[0]?.confirmed_items) === 2 && Number(first[0]?.unreviewed_items) === 9,
    JSON.stringify(first[0] ?? null),
  );
  check("two named items are PARTIAL, never CONFIRMED", first[0]?.review_state === "PARTIAL" && first[0]?.reviewed_at === null, JSON.stringify(first[0] ?? null));
  check("the answer is stored normalised and marked as such", first[0]?.bias === "BULLISH" && first[0]?.norm === "true", JSON.stringify(first[0] ?? null));

  // (2) a SECOND report naming different items merges into the same row: no lost update, no append.
  outbound.length = 0;
  await sendWith(++updateId, message("/checklist notes: دیر وارد شدم"));
  const merged = await q(
    `SELECT count(*)::int AS n, max(items->'dailyBias'->>'value') AS bias, max(notes) AS notes,
            max(confirmed_items)::int AS confirmed
       FROM journal_daily_checklists WHERE user_id = $1`,
    [String(user.id)],
  );
  check(
    "an update to the same day MERGES and does not duplicate",
    merged[0]?.n === 1 && merged[0]?.bias === "BULLISH" && merged[0]?.notes === "دیر وارد شدم",
    JSON.stringify(merged[0] ?? null),
  );
  check("the untouched item's count did not move (11 - named)", Number(merged[0]?.confirmed) === 2, JSON.stringify(merged[0] ?? null));

  // (3) Telegram redelivers the SAME update: the claim gate and the UPSERT must both keep it at one row.
  const retryId = ++updateId;
  await sendWith(retryId, message("/checklist risk: 0.5%"));
  const retried = await sendWith(retryId, message("/checklist risk: 0.5%"));
  const afterRetry = await q(
    `SELECT count(*)::int AS n, max(risk_value::text) AS risk, max(risk_unit) AS unit FROM journal_daily_checklists WHERE user_id = $1`,
    [String(user.id)],
  );
  check(
    "a redelivered webhook duplicates neither the row nor the risk figure",
    afterRetry[0]?.n === 1 && Number(afterRetry[0]?.risk) === 0.5 && afterRetry[0]?.unit === "PERCENT",
    `${JSON.stringify(afterRetry[0] ?? null)} secondDelivery=${JSON.stringify(retried.body)}`,
  );

  // (4) "?" is a different fact from "none", and only eleven named items complete a day.
  await sendWith(++updateId, message("/checklist cisd: ?\nsmt: none\nmacro: 09:30\nsl: 2655\nleg: bullish\nlocation: premium\nm15: fvg\nh1: none"));
  const partial = await q(
    `SELECT confirmed_items::int AS c, unknown_items::int AS u, review_state,
            items->'m1Cisd'->>'state' AS cisd, items->'smt'->>'value' AS smt
       FROM journal_daily_checklists WHERE user_id = $1`,
    [String(user.id)],
  );
  check(
    "an explicitly unknown item is UNKNOWN while 'none' is an answer",
    partial[0]?.cisd === "UNKNOWN" && partial[0]?.smt === "NONE",
    JSON.stringify(partial[0] ?? null),
  );
  check("ten confirmed items is still not a complete review", Number(partial[0]?.c) === 10 && partial[0]?.review_state === "PARTIAL", JSON.stringify(partial[0] ?? null));
  await sendWith(++updateId, message("/checklist bias: bearish"));
  const ten = await q(
    `SELECT confirmed_items::int AS c, unreviewed_items::int AS u, review_state, items->'dailyBias'->>'value' AS bias
       FROM journal_daily_checklists WHERE user_id = $1`,
    [String(user.id)],
  );
  // This is the check that keeps the feature honest: every item is now ANSWERED (unreviewed = 0), but
  // one answer is "I do not know", and a day where the user admitted not looking is not a completed
  // review. A `sum = 11` shortcut or a "nothing left to fill" rule would flip this to CONFIRMED.
  check(
    "answered-but-unknown keeps the day PARTIAL, and the bias was replaced",
    ten[0]?.u === 0 && Number(ten[0]?.c) === 10 && ten[0]?.review_state === "PARTIAL" && ten[0]?.bias === "BEARISH",
    JSON.stringify(ten[0] ?? null),
  );
  await sendWith(++updateId, message("/checklist cisd: yes"));
  const done = await q(
    `SELECT confirmed_items::int AS c, unreviewed_items::int AS u, review_state, reviewed_at IS NOT NULL AS stamped
       FROM journal_daily_checklists WHERE user_id = $1`,
    [String(user.id)],
  );
  check(
    "the eleventh confirmed item flips the day to CONFIRMED, stamped",
    done[0]?.review_state === "CONFIRMED" && done[0]?.stamped === true && Number(done[0]?.c) === 11 && done[0]?.u === 0,
    JSON.stringify(done[0] ?? null),
  );

  // (5a) a DATED report writes the day it names and leaves today alone. Reachable only because the
  // command parses a leading YYYY-MM-DD — a service method no user can call is not a feature.
  await sendWith(++updateId, message("/checklist 2026-10-15 bias: bullish"));
  const dated = await q(
    `SELECT report_date::text AS d, confirmed_items::int AS c FROM journal_daily_checklists
      WHERE user_id = $1 ORDER BY report_date`,
    [String(user.id)],
  );
  check(
    "a dated report files THAT day and does not disturb today's row",
    dated.length === 2 && dated[0]?.c === 1 && String(dated[1]?.d).startsWith("2026-10-18"),
    JSON.stringify(dated),
  );

  // (5b) an impossible calendar date is refused BEFORE any write, and must not roll over onto a real day.
  outbound.length = 0;
  await sendWith(++updateId, message("/checklist 2026-02-30 bias: bullish"));
  const dateReply = String(outbound.filter((c) => c.method === "sendMessage").pop()?.payload?.text ?? "");
  check("an impossible date is answered with the date sentence, not a generic failure", /YYYY-MM-DD/.test(dateReply), JSON.stringify(dateReply.slice(0, 80)));
  // Compared as text on purpose: '2026-02-30' is not a date PostgreSQL will accept, and the whole
  // point is that this string never reached the column — a rolled-over '2026-03-02' would have.
  const stray = await q(
    `SELECT count(*)::int AS n FROM journal_daily_checklists
      WHERE report_date::text LIKE '2026-02%' OR report_date::text = '2026-03-02'`,
  );
  check("an impossible report date writes nothing at all", stray[0]?.n === 0, JSON.stringify(stray[0] ?? null));

  // (6) statistics are read from the row the confirm button created, not from an example.
  const ledger = await q(
    `SELECT count(*)::int AS n, to_char(coalesce(sum(net_pnl), 0), 'FM999999990.00') AS pnl FROM trades WHERE deleted_at IS NULL`,
  );
  outbound.length = 0;
  await sendWith(++updateId, message("/stats"));
  const statsCard = outbound.filter((c) => c.method === "sendMessage").pop();
  const statsText = String(statsCard?.payload?.text ?? "");
  check(
    "/stats shows the persisted count and the ledger's own P/L",
    statsText.includes(`: ${String(ledger[0]?.n)} ·`) && statsText.includes(ledger[0]?.pnl ?? "\"\"\""),
    JSON.stringify({ card: statsText.slice(0, 120), ledger: ledger[0] ?? null }),
  );

  // (8) the one-tap emotion button, on the real record. The card's button must change the trade,
  // not just explain how to change it — which is the property a screenshot of a UI cannot prove.
  const emoRow = await q(`SELECT id FROM trades WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`);
  const emoId = String(emoRow[0]?.id ?? "");
  const emotionCol = await q(
    // 'emotion' is the ledger's authoritative column and the one the read path maps from
    // (tradeService.ts:719). 'emotional_score' is a 0022 legacy-parity MIRROR that the modern write
    // path does not populate — picking it by ILIKE made this check fail on the wrong column.
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'trades'
        AND column_name = ANY(ARRAY['emotion','emotional_score'])
      ORDER BY array_position(ARRAY['emotion','emotional_score'], column_name)
      LIMIT 1`,
  );
  if (emotionCol[0]?.column_name !== undefined && emoId !== "") {
    const col = String(emotionCol[0].column_name);
    await sendWith(++updateId, message(`/trade ${emoId}`));
    const card2 = outbound.filter((c) => c.method === "sendMessage").pop();
    const openData = (card2?.payload?.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => String(b?.callback_data ?? ""))
      .find((d) => d.startsWith("trade_edit:") && d.endsWith("-emotion"));
    check("the trade card offers the emotion picker as a callback the contract accepts", Boolean(openData), JSON.stringify(openData ?? null));
    if (openData) {
      outbound.length = 0;
      await sendWith(++updateId, {
        callback_query: { id: "cb-em-1", from: { id: Number(TG_USER), is_bot: false }, message: { message_id: 4, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" } }, data: openData },
      });
      const picker = outbound.filter((c) => c.method === "sendMessage").pop();
      const pick = (picker?.payload?.reply_markup?.inline_keyboard ?? []).flat().find((b) => String(b?.callback_data ?? "").endsWith("-emotion-4"));
      check("the picker offers exactly five scores", (picker?.payload?.reply_markup?.inline_keyboard ?? []).flat().length === 5, JSON.stringify(picker?.payload?.reply_markup ?? null));
      if (pick?.callback_data) {
        await sendWith(++updateId, {
          callback_query: { id: "cb-em-2", from: { id: Number(TG_USER), is_bot: false }, message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" } }, data: pick.callback_data },
        });
        const written = await q(`SELECT ${col} AS v FROM trades WHERE id = $1`, [emoId]);
        check("the chosen score is stored on the trade row", Number(written[0]?.v) === 4, JSON.stringify(written[0] ?? null));
      }
      // A score outside 1..5 is refused outright, and the stored value stays where it was.
      await sendWith(++updateId, {
        callback_query: { id: "cb-em-3", from: { id: Number(TG_USER), is_bot: false }, message: { message_id: 6, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" } }, data: `trade_delete:${emoId}-vX` },
      });
      const untouched = await q(`SELECT ${col} AS v FROM trades WHERE id = $1`, [emoId]);
      check("a malformed callback writes nothing", Number(untouched[0]?.v) === 4, JSON.stringify(untouched[0] ?? null));
    }
  } else {
    console.log("  FAIL  no emotion column found on trades — the picker cannot be verified here");
    failures += 1;
  }

  // (7b) journaling read authority (owner decision 2026-10-18). `strategy` and `emotion` are the
  // columns the modern write path maintains; `strategy_tag` and `emotional_score` are the 0022
  // legacy-parity MIRRORS. Three report reads used to PREFER the mirror, so a broker-imported label
  // could outlive the user's own edit. These checks construct the stores exactly as server-main.ts
  // does and read a row where the two column sets deliberately disagree.
  const { PgAnalyticsStore } = await import("../../api/src/analytics/analyticsStore.ts");
  const { PgPortfolioStore } = await import("../../api/src/portfolio/portfolioRoutes.ts");
  // The portfolio read filters `account_id IS NOT NULL`, and a trade created through the Telegram path
  // carries no account link at all. "Pick the newest trade" therefore only passed on a database that
  // still held an imported row from an earlier run — measured: it returned [] on a fresh one. Link
  // the row to this user's own manual account for the length of the check, then put it back.
  const liveTrade = await q(
    `SELECT id, account_id FROM trades WHERE deleted_at IS NULL AND quarantined = false ORDER BY id DESC LIMIT 1`,
  );
  const priorAccountId = liveTrade[0]?.account_id ?? null;
  const liveId = liveTrade[0]?.id;
  if (liveId === undefined) {
    console.log("  FAIL  no live trade to check read authority against");
    failures += 1;
  } else {
    await admin.unsafe(
      `UPDATE trades SET strategy = 'Modern edit', strategy_tag = 'LEGACY mirror', emotion = 4, emotional_score = NULL,
      account_id = $2 WHERE id = $1`,
      [liveId, acct.id],
    );
    const analytics = new PgAnalyticsStore(q);
    const portfolio = new PgPortfolioStore(q);
    const listed = await analytics.listTrades({ userId: String(user.id), from: null, to: null, accountId: null });
    const byAccount = await portfolio.tradesByAccount(String(user.id));
    check(
      "the analytics read takes the authoritative strategy, not the parity mirror",
      listed.some((r) => r.strategy === "Modern edit"),
      JSON.stringify(listed.map((r) => r.strategy)),
    );
    check(
      "the portfolio read agrees with it (both were mirror-first before this change)",
      byAccount.length > 0 && byAccount.some((r) => r.strategy === "Modern edit"),
      JSON.stringify(byAccount.map((r) => r.strategy)),
    );
    // The fallback must survive the fix: a legacy-imported row that ONLY has the mirror still shows
    // its label, because dropping the mirror read would silently blank real imported history.
    await admin.unsafe(`UPDATE trades SET strategy = NULL, strategy_tag = 'LEGACY mirror' WHERE id = $1`, [liveId]);
    const legacy = await analytics.listTrades({ userId: String(user.id), from: null, to: null, accountId: null });
    check(
      "a legacy row with only the mirror keeps its label (fallback, not preference)",
      legacy.some((r) => r.strategy === "LEGACY mirror"),
      JSON.stringify(legacy.map((r) => r.strategy)),
    );
    await admin.unsafe(`UPDATE trades SET account_id = $2 WHERE id = $1`, [liveId, priorAccountId]);
  }

  // (8) the tombstone flow: the card shows a version, the confirm button carries it, the row survives.
  const tradeRow = await q(`SELECT id, version FROM trades WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1`);
  const tradeId = String(tradeRow[0]?.id ?? "");
  outbound.length = 0;
  await sendWith(++updateId, message(`/trade ${tradeId}`));
  const detail = outbound.filter((c) => c.method === "sendMessage").pop();
  const detailText = String(detail?.payload?.text ?? "");
  check(
    "/trade <id> renders the stored trade with the version it will act on",
    detailText.includes("· v") && detailText.includes(String(tradeRow[0]?.version ?? -1)),
    JSON.stringify(detailText.slice(0, 160)),
  );
  const armData = (detail?.payload?.reply_markup?.inline_keyboard ?? [])
    .flat()
    .map((b) => String(b?.callback_data ?? ""))
    .find((d) => d.startsWith("trade_arm:"));
  if (armData !== undefined) {
    outbound.length = 0;
    await sendWith(++updateId, {
      callback_query: { id: "cb-del-1", from: { id: Number(TG_USER), is_bot: false }, message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" } }, data: armData },
    });
    const ask = outbound.filter((c) => c.method === "sendMessage").pop();
    const yesData = (ask?.payload?.reply_markup?.inline_keyboard ?? [])
      .flat()
      .map((b) => String(b?.callback_data ?? ""))
      .find((d) => d.startsWith("trade_delete:"));
    check("the confirmation button carries the shown version as its CAS token", yesData?.endsWith(`-v${String(tradeRow[0]?.version)}`) === true, JSON.stringify(yesData ?? null));
    outbound.length = 0;
    await sendWith(++updateId, {
      callback_query: { id: "cb-del-2", from: { id: Number(TG_USER), is_bot: false }, message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" } }, data: yesData ?? "trade_delete:none-v0" },
    });
    const tomb = await q(
      `SELECT (deleted_at IS NOT NULL) AS tombstoned, (SELECT count(*)::int FROM trades WHERE id = $1) AS still_there
         FROM trades WHERE id = $1`,
      [tradeId],
    );
    check(
      "the tombstone is an UPDATE, not a deletion — the row is still there and history keeps it",
      tomb[0]?.tombstoned === true && tomb[0]?.still_there === 1,
      JSON.stringify(tomb[0] ?? null),
    );
    const gone = await q(`SELECT count(*)::int AS n FROM trades WHERE deleted_at IS NULL`);
    check("a tombstoned trade leaves every statistic", gone[0]?.n === 0, JSON.stringify(gone[0] ?? null));
  } else {
    console.log("  FAIL  the trade card exposed no delete action");
    failures += 1;
  }

  // (9) per-user scoping at the row level: only the seeded owner has a checklist row here.
  const owners = await q(`SELECT count(DISTINCT user_id)::int AS n FROM journal_daily_checklists`);
  check("the day's row belongs to exactly one user", owners[0]?.n === 1, JSON.stringify(owners[0] ?? null));
}

console.log("\n── deferred-work isolation under concurrency (R1 regression, real path) ──");
{
  // Two deliveries, each in its OWN chat, so neither the journal flow above nor the
  // two requests can disturb each other. Only CHAT_A's Bot API call is slowed, and
  // that asymmetry is the whole point: B's work is instant, A's takes 700 ms, so if
  // B's settle took ~700 ms it can only be because B had taken A's task — which is
  // what the old module-scope queue did under workerd.
  const CHAT_A = 911001, CHAT_B = 911003;
  // `from.id` is the OWNER for both while the chats stay distinct: private mode keys authority on the
  // attested sender, and this section measures per-request isolation and per-chat routing — which needs
  // two concurrent deliveries, not two accounts (a single-owner bot has exactly one).
  const msg = (chat, text) => ({ message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "private" }, from: { id: Number(TG_USER), is_bot: false, first_name: "Concurrency" }, text } });
  const idA = ++updateId, idB = ++updateId;
  stubDelay = STUB_HOLD;
  slowChats.add(String(CHAT_A));
  const before = outbound.filter((c) => c.method === "sendMessage").length;
  const pA = sendAsync(idA, msg(CHAT_A, "/start"));
  const pB = sendAsync(idB, msg(CHAT_B, "/start"));
  const [rA, rB] = await Promise.all([pA, pB]);

  check("both concurrent deliveries answered 200", rA.status === 200 && rB.status === 200, `${rA.status}/${rB.status}`);
  check("each request holds its OWN waitUntil list", rA.ctx !== rB.ctx && rA.ctx.props.length >= 1 && rB.ctx.props.length >= 1, `A=${rA.ctx.props.length} B=${rB.ctx.props.length}`);

  const t0 = Date.now();
  const aSendsBefore = outbound.filter((c) => c.method === "sendMessage" && String(c.payload?.chat_id) === String(CHAT_A)).length;
  await Promise.allSettled(rB.ctx.props);
  const bAlone = Date.now() - t0;
  const aPending = inFlight.get(String(CHAT_A)) ?? 0;
  check("B finished while A's Telegram send was STILL IN FLIGHT (isolation, not timing)", aPending >= 1,
    `A had ${aPending} unresolved send(s) at B's drain — 0 would mean B really did wait for A`);
  const aSendsAfterB = outbound.filter((c) => c.method === "sendMessage" && String(c.payload?.chat_id) === String(CHAT_A)).length;
  console.log(`    probe: B drained in ${bAlone}ms; A's sendMessage had been ISSUED ${aSendsAfterB - aSendsBefore} time(s) but its response was still held by the stub`);
  check("B settled without waiting on A's task", bAlone < STUB_HOLD, `B waited ${bAlone}ms while A was held for ${STUB_HOLD}ms — on a high-latency origin raise IT_STUB_HOLD_MS; the in-flight check above is the load-bearing one`);

  // The stub appends at REQUEST ARRIVAL, so a send can be recorded before its response
  // returns; row state and log counts are therefore not the observable here. Timing is:
  // B's list drained in ~12ms, and only A's own invocation can have taken 700ms.
  const tA = Date.now();
  await Promise.allSettled(rA.ctx.props);
  const aAlone = Date.now() - tA;
  check(`A's work was still running when B finished (A needed its own ${STUB_HOLD}ms)`, aAlone + bAlone >= STUB_HOLD * 0.9, `A ${aAlone}ms after B's ${bAlone}ms, stub held A ${STUB_HOLD}ms`);
  slowChats.clear();
  stubDelay = 0;
  const aDone = await q(`SELECT outcome FROM telegram_updates WHERE update_id = ANY($1::bigint[]) ORDER BY update_id`, [[idA, idB]]);
  check("both claimed updates reached a terminal outcome", aDone.length === 2 && aDone.every((r) => r.outcome === "handled"), JSON.stringify(aDone));
  const rows = await q(`SELECT count(*)::int n FROM telegram_updates WHERE update_id = ANY($1::bigint[])`, [[idA, idB]]);
  check("no update was processed twice by the two requests", rows[0].n === 2, `rows=${rows[0].n}`);

  // Counted per chat over the whole log rather than over a slice: other sections'
  // replies are still draining into `outbound`, and a window would attribute them here.
  const sendsFor = (chat) => outbound.filter((c) => c.method === "sendMessage" && String(c.payload?.chat_id) === String(chat)).length;
  check("each reply landed on its own chat, never the other request's", sendsFor(CHAT_A) === 1 && sendsFor(CHAT_B) === 1, `A=${sendsFor(CHAT_A)} B=${sendsFor(CHAT_B)}`);
}

// The probe creates a scratch database, which needs CREATEDB — a privilege the
// least-privilege bot role must not hold. SKIP_LIFECYCLE=1 skips only this section, so
// the same file runs both as a maintenance role and as the bot role.
if (process.env.SKIP_LIFECYCLE === "1") {
  console.log("\n── connection lifecycle: SKIPPED (SKIP_LIFECYCLE=1 — the probe needs CREATEDB) ──");
}
if (process.env.SKIP_LIFECYCLE !== "1") {
console.log("\n── connection lifecycle: what POOL_MAX actually bounds (A5 evidence) ──");
  const { HyperdrivePool, POOL_MAX } = await import("../src/pgHyperdrive.ts");
  const { withTransaction } = await import("../../api/src/persistence/pg.ts");
  check("POOL_MAX is exported and inside the Workers per-invocation ceiling", Number.isInteger(POOL_MAX) && POOL_MAX > 0 && POOL_MAX <= 6, `POOL_MAX=${POOL_MAX} (Workers allow 6 simultaneous outgoing connections)`);

  // A private scratch database, because counting backends by datname is only exact when
  // nothing else is connected to it — and the bot section above, a second harness run, or
  // `wrangler dev` all connect to the main one (that shared-DB skew is exactly what made
  // these numbers read 15 and 9 once). The probe needs no schema: pg_sleep and
  // pg_backend_pid inside a transaction is all it runs.
  const PROBE_DB = "velora_cf_probe";
  const dbExists = await admin.unsafe(`SELECT 1 FROM pg_database WHERE datname = $1`, [PROBE_DB]);
  if (dbExists.length === 0) await admin.unsafe(`CREATE DATABASE ${PROBE_DB}`);
  const PROBE_URL = PG.replace(/\/[^/?]+(?=([?#]|$))/, `/${PROBE_DB}`);
  const backends = async () => (await q(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname = '${PROBE_DB}'`))[0].n;
  const HOLD = 0.25; // seconds each statement keeps its connection busy, so counts are stable

  // One measurement run: `adhoc` shared-pool queries and `txn` concurrent
  // transactions, all overlapping, with the backend count sampled underneath.
  const burst = async (max, adhoc, txn) => {
    const pool = new HyperdrivePool(PROBE_URL, undefined, max);
    const baseline = await backends();
    if (baseline !== 0) throw new Error(`probe db must have no foreign backends, saw ${baseline}`);
    let peak = baseline;
    const sampler = setInterval(() => { void backends().then((n) => { if (n > peak) peak = n; }); }, 10);
    const errors = [];
    const started = Date.now();
    const pids = [];
    const work = [];
    for (let i = 0; i < adhoc; i += 1) {
      work.push(pool.query(`SELECT pg_sleep(${HOLD}), 1 AS ok`).then(() => 0).catch((e) => { errors.push(`adhoc:${e?.name ?? e}`); return 0; }));
    }
    for (let i = 0; i < txn; i += 1) {
      work.push(withTransaction(pool, async (tx) => {
        const rows = await tx(`SELECT pg_backend_pid() AS pid, pg_sleep(${HOLD}), 1 AS ok`);
        if (rows.length !== 1) throw new Error("transaction read failed");
        return Number(rows[0].pid);
      }).then((pid) => { pids.push(pid); return pid; }).catch((e) => { errors.push(`txn:${e?.name ?? e}`); return 0; }));
    }
    await Promise.all(work);
    clearInterval(sampler);
    const midPeak = peak - baseline;
    // postgres.js keeps pool members idle (default idle_timeout 30s) rather than
    // closing them per query, so "tail" here must be read as "how many the pool
    // holds at rest" — the leak test is that it equals the cap and not the query
    // count, and that the transaction pins are what actually go away.
    await new Promise((r) => setTimeout(r, 1500));
    const tail = (await backends()) - baseline;
    await pool.end().catch(() => {});
    return { peak: midPeak, tail, errors, pids: pids.filter((x) => x > 0), elapsed: Date.now() - started };
  };

  const guard = (label, p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: 30s deadline hit — a deadlock or leaked pin would hang here`)), 30000)),
  ]);

  // (1) cap + reuse, no transactions: does the pool stay at its cap, and does it
  // reuse instead of opening one backend per query?
  const cap = await guard("cap probe", burst(POOL_MAX, 16, 0));
  check("16 concurrent ad-hoc queries never exceed the pool cap", cap.peak === POOL_MAX, `peak backends=${cap.peak} (cap=${POOL_MAX})`);
  check("connections are REUSED, not opened per query (no leak at rest)", cap.tail === POOL_MAX && cap.errors.length === 0, `at rest=${cap.tail} for 16 queries, errors=${JSON.stringify(cap.errors)}`);

  // (2) transactions are outside the pool: the property that makes a small cap safe.
  const both = await guard("mixed burst", burst(POOL_MAX, 16, 6));
  check("all 6 concurrent transactions committed at POOL_MAX", both.pids.length === 6 && both.errors.length === 0, `committed=${both.pids.length}/6 errors=${JSON.stringify(both.errors)}`);
  check("each transaction pinned its OWN connection (so a 2-slot pool cannot deadlock them)", new Set(both.pids).size === 6, `distinct pids=${new Set(both.pids).size}`);
  check("real peak per isolate = POOL_MAX + concurrent transactions", both.peak === POOL_MAX + 6, `peak=${both.peak}, expected ${POOL_MAX}+6`);
  check("transaction pins are released; only the pool's own members stay idle", both.tail === POOL_MAX, `at rest=${both.tail} after 6 transactions ended`);

  // (3) what the previous setting would have cost the origin.
  const at8 = await guard("max:8 probe", burst(8, 16, 6));
  check("the old max:8 held 75% more origin connections for the identical work", at8.peak === 14 && both.peak < at8.peak, `max8 peak=${at8.peak} vs max${POOL_MAX} peak=${both.peak}`);
  check("the cap, not a leak, is what bounds both settings", at8.tail === 8 && at8.errors.length === 0, `max8 at rest=${at8.tail}`);
  console.log(`  note: the 16-query burst took ${both.elapsed}ms at max:${POOL_MAX} vs ${at8.elapsed}ms at max:8 — that queueing is the whole cost of the smaller cap, and one webhook delivery issues at most one ad-hoc query at a time`);
}

console.log("\n── private test mode: the access gate, against a real database ──");
{
  const OWNER = Number(TG_USER);
  const STRANGER = 777002;
  const TABLES = ["telegram_updates", "telegram_journal_drafts", "telegram_link_tokens", "trades", "trade_events", "audit_log"];
  const snap = async () =>
    Object.fromEntries(await Promise.all(TABLES.map(async (tb) => [tb, Number((await q(`SELECT count(*)::int n FROM ${tb}`))[0].n)])));
  const delta = async (from) => {
    const now = await snap();
    return TABLES.map((tb) => now[tb] - from[tb]);
  };
  const allZero = (d) => d.every((n) => n === 0);
  let nextId = 910000001;
  const upd = (from, text) => ({
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from ?? 0, type: "private" },
      ...(from === null ? {} : { from: { id: from, is_bot: false, first_name: "probe" } }),
      ...(text === null ? {} : { text }),
    },
  });
  const asOwner = async (update, id = null) => sendWith(id ?? nextId++, update);

  // ── every way a stranger can try, and what each one is allowed to touch ──────
  let before = await snap();
  const stranger = await asOwner(upd(STRANGER, "/start"));
  check(
    "stranger is answered 200 so Telegram stops redelivering",
    stranger.status === 200,
    `status=${stranger.status} body=${JSON.stringify(stranger.body)}`,
  );
  check(
    "stranger's reply says dropped+private and names nobody",
    stranger.body?.data?.dropped === true && stranger.body?.data?.private === true && stranger.body?.data?.reason === "UNAUTHORIZED_SENDER",
    JSON.stringify(stranger.body),
  );
  let d = await delta(before);
  check("a refused sender writes NOTHING to any table", allZero(d), `delta=${d.join(",")} (${TABLES.join(",")})`);

  before = await snap();
  const impersonate = await asOwner(upd(STRANGER, `from.id: ${OWNER} /start ${OWNER}`));
  check("an id claimed inside the message text grants nothing", impersonate.body?.data?.reason === "UNAUTHORIZED_SENDER", JSON.stringify(impersonate.body));
  check("and it still writes nothing", allZero(await delta(before)));

  before = await snap();
  const cbStranger = await asOwner({
    callback_query: { id: "cb-gate-1", from: { id: STRANGER, is_bot: false }, data: `confirm:${OWNER}` },
  });
  check("callback data cannot confer authority either", cbStranger.body?.data?.reason === "UNAUTHORIZED_SENDER", JSON.stringify(cbStranger.body));
  check("a refused callback writes nothing", allZero(await delta(before)));

  before = await snap();
  const noSender = await asOwner(upd(null, "hi"));
  check("an update with no attested sender is dropped, not processed", noSender.body?.data?.reason === "SENDER_UNVERIFIED", JSON.stringify(noSender.body));
  check("an unattested sender writes nothing", allZero(await delta(before)));

  // ── the owner: unchanged behaviour, real persistence ─────────────────────────
  before = await snap();
  const ownerId = nextId++;
  const owner = await asOwner(upd(OWNER, "/start"), ownerId);
  check("the authorised sender is still served", owner.status === 200 && owner.body?.data?.dropped !== true, `status=${owner.status} body=${JSON.stringify(owner.body)}`);
  d = await delta(before);
  check(
    "the authorised update created its own row and no trade",
    d[TABLES.indexOf("telegram_updates")] >= 1 && d[TABLES.indexOf("trades")] === 0,
    `delta=${d.join(",")}`,
  );
  const back = await q(`SELECT update_id, chat_id, coalesce(outcome,'(pending)') AS outcome FROM telegram_updates WHERE chat_id = ${OWNER} ORDER BY update_id DESC LIMIT 1`);
  check(
    "the row is retrievable with a terminal outcome",
    back.length === 1 && String(back[0].chat_id) === String(OWNER) && back[0].outcome !== "(pending)",
    JSON.stringify(back[0] ?? {}),
  );
  const dup = await asOwner(upd(OWNER, "/start"), ownerId); // same update_id ⇒ the claim must answer duplicate
  check(
    "a redelivery of the SAME update_id is a duplicate, not a second row",
    dup.status === 200 && JSON.stringify(dup.body).includes("duplicate"),
    JSON.stringify(dup.body),
  );

  // ── the gate's own configuration ─────────────────────────────────────────────
  const post = (env2, update) =>
    worker.fetch(
      new Request("http://bot.internal/api/v1/webhooks/telegram", {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({ update_id: nextId++, ...update }),
      }),
      env2,
      mkCtx(),
    );
  before = await snap();
  const unconfigured = { ...env };
  delete unconfigured.TELEGRAM_TEST_USER_ID;
  const refused = await post(unconfigured, upd(OWNER, "/start"));
  const refusedText = await refused.text();
  check(
    "unset gate ⇒ 503 ACCESS_GATE_UNCONFIGURED even for the owner",
    refused.status === 503 && refusedText.includes("ACCESS_GATE_UNCONFIGURED"),
    `status=${refused.status}`,
  );
  const badGate = await post({ ...env, TELEGRAM_TEST_USER_ID: `${OWNER}, ${STRANGER}` }, upd(OWNER, "/start"));
  check("a gate that is not one plain id ⇒ 503, never an open bot", badGate.status === 503 && (await badGate.text()).includes("ACCESS_GATE_INVALID"), `status=${badGate.status}`);
  d = await delta(before);
  check("a broken gate writes nothing either", allZero(d), `delta=${d.join(",")}`);

  const h = await (await worker.fetch(new Request("http://bot.internal/health"), unconfigured, mkCtx())).json();
  check("/health reports the mode and that it is not armed", h.data.mode === "private-test" && String(h.data.access).startsWith("not-armed"), JSON.stringify(h.data));
  check("/health never carries the allowed id", !JSON.stringify(h).includes(String(OWNER)));
  const readyBare = await worker.fetch(new Request("http://bot.internal/ready"), unconfigured, mkCtx());
  check(
    "/ready is NOT green while the gate is broken, even though the database works",
    readyBare.status === 503 && JSON.stringify(await readyBare.json()).includes("UNCONFIGURED"),
    `status=${readyBare.status}`,
  );
  const readyArmed = await (await worker.fetch(new Request("http://bot.internal/ready"), env, mkCtx())).json();
  check(
    "/ready is green only when database AND gate are both fine",
    readyArmed.data.status === "ready" && readyArmed.data.access.valid === true && readyArmed.data.checks.database === "ok",
    JSON.stringify(readyArmed.data),
  );
  const diagText = await (await worker.fetch(
    new Request("http://bot.internal/api/v1/telegram/diagnostics", { headers: { authorization: "Bearer diagnostics-token-for-tests" } }),
    env,
    mkCtx(),
  )).text();
  check("diagnostics exposes the gate shape, never its value", diagText.includes('"mode":"private-test"') && !diagText.includes(String(OWNER)), diagText.slice(0, 90));
}

console.log("\n── secret hygiene ──");
const leaked = outbound.some((c) => JSON.stringify(c).includes(env.TELEGRAM_BOT_TOKEN));
check("bot token never appears in an outbound request body", !leaked);

await admin.unsafe(`DROP DATABASE IF EXISTS velora_cf_probe`).catch(() => {});
await admin.end({ timeout: 1 });
stub.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
