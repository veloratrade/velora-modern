// Does the *least-privilege* role in report §5 actually run the bot? This is the question
// "prepare the grants as a patch, do not widen them to make a test green" has to answer, and
// the only honest way to answer it is to execute the real code path AS that role.
//
//   LEAST_PRIVILEGE_DATABASE_URL  the bot role (velora_telegram_bot) — everything the bot does
//   SEED_DATABASE_URL             a maintenance role, used ONLY to reset + insert fixtures
//
// Both must point at a DISPOSABLE database. Refuses to run if either is missing, and the
// fixtures are deliberately seeded by the maintenance role so the bot role never needs DML
// it was not granted (no DELETE on business tables, no access to schema_migrations).
import postgres from "postgres";

const BOT_URL = process.env.LEAST_PRIVILEGE_DATABASE_URL ?? "";
const SEED_URL = process.env.SEED_DATABASE_URL ?? "";
if (BOT_URL === "" || SEED_URL === "") {
  console.error("LEAST_PRIVILEGE_DATABASE_URL and SEED_DATABASE_URL are both required (disposable databases only).");
  process.exit(2);
}

const TG_USER = "777001";
const CHAT = 777001;
const STUB_PORT = 9912;
const SECRET = "leastprivilegetestsecretleastprivilege";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  → ${detail}` : ""}`);
  if (!cond) failures += 1;
};

// ── the stub Bot API, so no real Telegram traffic and no real user is messaged ──
const { createServer } = await import("node:http");
const outbound = [];
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    const respond = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: obj }));
    };
    const method = (req.url ?? "").split("/").pop()?.split("?")[0] ?? "unknown";
    outbound.push({ method, payload });
    if (method === "sendMessage") {
      return respond({ message_id: outbound.filter((c) => c.method === "sendMessage").length, chat_id: payload?.chat_id, date: Math.floor(Date.now() / 1000) });
    }
    if (method === "answerCallbackQuery") return respond(true);
    if (req.url?.includes("getMe")) return respond({ id: 123456, username: "MyVeloratradeBot" });
    respond({});
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

const seed = postgres(SEED_URL, { max: 2 });
const bot = postgres(BOT_URL, { max: 2 });
const q = async (sql, params = []) => await bot.unsafe(sql, params); // as the BOT role

// ── fixtures, by the maintenance role ───────────────────────────────────────
const CLEAN = `DELETE FROM rate_limits; DELETE FROM telegram_journal_drafts; DELETE FROM telegram_updates;
  DELETE FROM telegram_channel_posts; DELETE FROM telegram_channels; DELETE FROM telegram_link_tokens;
  DELETE FROM telegram_identities; DELETE FROM trade_events; DELETE FROM trades; DELETE FROM audit_log;
  DELETE FROM trading_accounts; DELETE FROM users;`;
// the multi-statement reset has no parameters, so it goes as a simple query; the parameterised
// insert must be its own call (an extended-protocol statement cannot carry two commands)
await seed.unsafe(CLEAN);
const [user] = await seed.unsafe(
  `INSERT INTO users (email,password_hash,role,locale,status,plan,timezone,created_at,updated_at)
     VALUES ('lp@velora.test',$1,'user','fa','active','free','Asia/Tehran',now(),now()) RETURNING id`,
  ["x".repeat(60)],
);
await seed.unsafe(
  `INSERT INTO trading_accounts (user_id,provider,platform,label,currency,leverage,timezone,status,sync_status,starting_balance,created_at,updated_at)
     VALUES ($1,'MANUAL','MANUAL','LP','USD','100','Asia/Tehran','connected','DISCONNECTED',10000,now(),now())`,
  [user.id],
);
await seed.unsafe(
  `INSERT INTO telegram_identities (user_id,telegram_user_id,username,status,linked_at,created_at,updated_at)
     VALUES ($1,$2,'lprobe','LINKED',now(),now(),now())`,
  [user.id, TG_USER],
);
console.log(`seeded as the maintenance role: user ${user.id}, identity ${TG_USER}`);

// ── the worker, talking to the database ONLY as the bot role ─────────────────
const worker = (await import("../src/index.ts")).default;
const env = {
  HYPERDRIVE: { connectionString: BOT_URL },
  TELEGRAM_BOT_TOKEN: "123456:AA_fake_fake_fake_fake_fake_fake_fake1",
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_UPDATE_MODE: "webhook",
  VELORA_APP_URL: "https://app.velora.test",
  APP_ENV: "development",
  TELEGRAM_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
  TELEGRAM_TEST_USER_ID: TG_USER,
};
const workerLogs = [];
const realLog = console.log;
console.log = (...a) => {
  const s = a.map(String).join(" ");
  workerLogs.push(s);
  if (/permission denied|42501|error/i.test(s)) realLog(`    worker: ${s.slice(0, 150)}`);
};
const mkCtx = () => {
  const props = [];
  return { props, waitUntil: (p) => void props.push(p) };
};
let updateId = 920000000;
const send = async (update) => {
  const ctx = mkCtx();
  const res = await worker.fetch(
    new Request("http://bot.internal/api/v1/webhooks/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
      body: JSON.stringify({ update_id: ++updateId, ...update }),
    }),
    env,
    ctx,
  );
  const body = await res.json().catch(() => null);
  await Promise.allSettled(ctx.props);
  await new Promise((r) => setTimeout(r, 250));
  return { status: res.status, body };
};
const message = (text) => ({
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: CHAT, type: "private" },
    from: { id: Number(TG_USER), is_bot: false, first_name: "LP" },
    text,
  },
});

try {
  console.log("\n── the ready line, through the restricted role ──");
  const ready = await worker.fetch(new Request("http://bot.internal/ready"), env, mkCtx());
  const readyBody = await ready.json();
  console.log = realLog;
  check("the bot role can answer /ready (its SELECTs are granted)", readyBody.data.checks.database === "ok", JSON.stringify(readyBody.data.checks));

  console.log("\n── the real flows, all writes made AS velora_telegram_bot ──");
  const start = await send(message("/start"));
  check("/start succeeded under the restricted role", start.status === 200, JSON.stringify(start.body));

  await send(message("خرید EURUSD 1.5 روی 1.0850 و حد ضرر 1.0800"));
  const needs = await q(`SELECT state FROM telegram_journal_drafts ORDER BY id DESC LIMIT 1`);
  check("incomplete journal → draft row written by the bot role", needs[0]?.state === "NEEDS_DETAIL", JSON.stringify(needs));
  check("…and no trade from it", Number((await q(`SELECT count(*)::int n FROM trades`))[0].n) === 0);

  await seed.unsafe(`DELETE FROM telegram_journal_drafts`);
  outbound.length = 0;
  await send(message("EURUSD sell entry 1.0850, exit 1.0800, stop 1.0870, target 1.0790, volume 0.5"));
  const awaiting = await q(`SELECT state FROM telegram_journal_drafts ORDER BY id DESC LIMIT 1`);
  check("complete journal → AWAITING_CONFIRMATION under the restricted role", awaiting[0]?.state === "AWAITING_CONFIRMATION", JSON.stringify(awaiting));

  const card = outbound.filter((c) => c.method === "sendMessage").pop();
  const buttons = (card?.payload?.reply_markup?.inline_keyboard ?? []).flat();
  const confirm = buttons.find((b) => String(b?.text ?? "").includes("تأیید") || /confirm/i.test(String(b?.callback_data ?? "")));
  check("confirmation card exposes a callback the bot can act on", Boolean(confirm?.callback_data), JSON.stringify(buttons.map((b) => b?.text)));
  if (confirm?.callback_data) {
    const cb = await send({
      callback_query: {
        id: "lp-cb",
        from: { id: Number(TG_USER), is_bot: false, first_name: "LP", username: "lp" },
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" } },
        data: confirm.callback_data,
      },
    });
    check("confirm callback accepted under the restricted role", cb.status === 200, JSON.stringify(cb.body));
  }
  const trades = await q(`SELECT count(*)::int n FROM trades`);
  check("the ledger row exists — so INSERT ON trades is sufficient", Number(trades[0].n) === 1, `trades=${trades[0].n}`);
  const events = await q(`SELECT count(*)::int n FROM trade_events`);
  check("the append-only ledger got its event — INSERT ON trade_events is sufficient", Number(events[0].n) >= 1, `events=${events[0].n}`);
  // These flows do not themselves audit or throttle — /start for a linked identity and the
  // journal path touch neither. So the grants are probed directly instead of hoped for.
  await seed.unsafe(`DELETE FROM audit_log WHERE action = 'TELEGRAM_LINK_STARTED'`);
  await q(`INSERT INTO audit_log (occurred_at, action, actor_user_id, before_state, after_state, outcome) VALUES (now(), 'TELEGRAM_LINK_STARTED', $1, '{}', '{}', 'success')`, [user.id]);
  const audit = await q(`SELECT count(*)::int n FROM audit_log`);
  check("the bot role can append to the audit trail (INSERT ON audit_log)", Number(audit[0].n) === 1, `audit=${audit[0].n}`);
  const updates = await q(`SELECT coalesce(outcome,'(pending)') o, count(*)::int n FROM telegram_updates GROUP BY 1 ORDER BY 1`);
  check("every update reached a terminal outcome", updates.every((r) => r.o !== "(pending)") && updates.length > 0, JSON.stringify(updates));
  const drafts = await q(`SELECT state FROM telegram_journal_drafts ORDER BY id DESC LIMIT 1`);
  check("the draft ended CONFIRMED (UPDATE on drafts is granted and enough)", drafts[0]?.state === "CONFIRMED", JSON.stringify(drafts));
  const rlId = `lp-rate-${Date.now()}`;
  await q(`INSERT INTO rate_limits (bucket, hits, window_start) VALUES ($1, 1, now())`, [rlId]);
  const rl = await q(`SELECT hits FROM rate_limits WHERE bucket = $1`, [rlId]);
  await q(`DELETE FROM rate_limits WHERE bucket = $1`, [rlId]);
  const rlGone = await q(`SELECT count(*)::int n FROM rate_limits WHERE bucket = $1`, [rlId]);
  check(
    "the durable limiter works: INSERT+SELECT+DELETE on rate_limits",
    Number(rl[0]?.hits) === 1 && Number(rlGone[0].n) === 0,
    `hits=${rl[0]?.hits} afterDelete=${rlGone[0].n}`,
  );

  console.log("\n── what the role must NOT be able to do ──");
  // three outcomes, not two: a statement that fails for an unrelated reason (a bad column
  // name, say) is NOT evidence of a privilege boundary, and treating it as such is how a
  // security check starts passing for the wrong reason.
  const verdict = async (sql) => {
    try {
      await bot.unsafe(sql);
      return "allowed";
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/permission denied|42501/.test(m)) return "denied";
      return `other: ${m.slice(0, 60)}`;
    }
  };
  const denied = (sql) => verdict(sql).then((v) => v === "denied");
  const report = async (label, sql) => {
    const v = await verdict(sql);
    check(label, v === "denied", `verdict=${v}`);
  };
  await report("cannot rewrite the append-only ledger", `UPDATE trade_events SET at = at`); // real columns: id,event_uid,trade_id,type,actor,expected_version,payload,at
  await report("cannot TRUNCATE the append-only ledger", `TRUNCATE trade_events`);
  await report("cannot erase the append-only ledger", `DELETE FROM trade_events`);
  await report("cannot rewrite the audit trail", `UPDATE audit_log SET action = action`);
  await report("cannot erase the audit trail", `DELETE FROM audit_log`);
  await report("cannot touch schema_migrations (the Worker must never migrate)", `SELECT count(*) FROM schema_migrations`);
  await report("cannot erase a processed update", `DELETE FROM telegram_updates`);
  await report("cannot TRUNCATE anything it writes", `TRUNCATE telegram_updates`);
  await report("cannot create tables (no DDL for the bot)", `CREATE TABLE lp_should_not_exist (x int)`);

  console.log("\n── no permission error leaked into the bot's own path ──");
  console.log = realLog;
  const bad = workerLogs.filter((l) => /permission denied|42501/.test(l));
  check("zero permission errors while the bot ran", bad.length === 0, bad[0]?.slice(0, 130) ?? "");
  const sends = outbound.filter((c) => c.method === "sendMessage").length;
  // /start for an already-linked identity answers nothing, and the confirm answer travels as
  // an edit/callback answer — so sendMessage count is 2 here, and that is not a degradation.
  const answers = outbound.filter((c) => c.method !== "getMe").length - sends;
  check("the bot actually replied (cards + callback answer, nothing silently dropped)", sends >= 2 && answers >= 1, `sendMessage=${sends} edits/answers=${answers}`);
  check("no outbound call carries the bot token", !outbound.some((c) => JSON.stringify(c).includes(env.TELEGRAM_BOT_TOKEN)));
} finally {
  console.log = realLog;
  await seed.unsafe(CLEAN).catch(() => {});
  await bot.end({ timeout: 1 });
  await seed.end({ timeout: 1 });
  stub.close();
}
console.log(`\n${failures === 0 ? "LEAST-PRIVILEGE RUN PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
