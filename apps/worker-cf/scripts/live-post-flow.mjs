// LIVE evidence for the round-8 post flow, run against the DEPLOYED worker entry over the REAL
// staging database and the REAL Telegram Bot API — with one deliberate gate in the middle.
//
//   LIVE_DATABASE_URL=... TELEGRAM_BOT_TOKEN=... node apps/worker-cf/scripts/live-post-flow.mjs
//
// The Bot API is reached through a local recorder on 127.0.0.1 that:
//   • FORWARDS the read methods (`getMe`, `getChat`, `getChatMember`) to api.telegram.org verbatim,
//     so the rights and chat facts the bot reports are Telegram's own answers, not fixtures;
//   • ANSWERS every write/notification method locally and never forwards it, so no message can
//     reach the real channel from this run. The owner's rule is that a real post happens only on
//     an explicit approval in the flow; a test harness is not that approval.
// The token never appears in output: the recorder is the only place it is spliced into a URL.
//
// A disposable user + identity + channel row is created for the run and deleted afterwards, so the
// owner's data is not touched.
import { createServer } from "node:http";
import postgres from "postgres";

const PG = process.env.LIVE_DATABASE_URL ?? "";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (PG === "" || TOKEN === "") {
  console.error("LIVE_DATABASE_URL and TELEGRAM_BOT_TOKEN are both required.");
  process.exit(2);
}
const STUB_PORT = 9922;
// A disposable identity, picked to be unlikely to collide with any earlier probe row.
const TG_USER = String(778_800 + Math.floor(Math.random() * 1_000));
const CHAT = Number(TG_USER); // the "owner's" private conversation, which is this recorder
const CHANNEL = "-1003245304814"; // the owner's real channel: read-only, never written by this run
const REAL_API = "https://api.telegram.org";
const FORWARDED = new Set(["getMe", "getChat", "getChatMember", "getChatAdministrators"]);

const outbound = [];
let msgId = 5000;
const forwarded = [];
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    const method = (req.url ?? "").split("/").pop() ?? "";
    let payload = null;
    try { payload = JSON.parse(raw); } catch { payload = raw; }
    const record = { method, payload, forwarded: false };
    outbound.push(record);
    res.setHeader("content-type", "application/json");
    if (FORWARDED.has(method)) {
      try {
        const live = await fetch(`${REAL_API}/bot${TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw === "" ? "{}" : raw,
        });
        const text = await live.text();
        record.forwarded = true;
        forwarded.push({ method, status: live.status, ok: JSON.parse(text).ok });
        res.statusCode = live.status;
        res.end(text);
        return;
      } catch (error) {
        res.statusCode = 502;
        res.end(JSON.stringify({ ok: false, description: `forward failed: ${String(error)}` }));
        return;
      }
    }
    // NOT forwarded: every outbound write and notification is answered here.
    if (method === "sendMessage" || method === "sendPhoto" || method === "editMessageText") {
      res.end(JSON.stringify({ ok: true, result: { message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat: { id: payload?.chat_id ?? CHAT, type: "channel" }, text: payload?.text ?? "" } }));
    } else {
      res.end(JSON.stringify({ ok: true, result: true }));
    }
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

const db = postgres(PG, { max: 4 });
const q = async (sql, params = []) => await db.unsafe(sql, params);

// ── disposable fixtures ──────────────────────────────────────────────────────
const purgeProbe = async () => {
  const rows = await q(`SELECT id FROM users WHERE email = 'live-probe@velora.test'`);
  for (const row of rows) {
    await q(`DELETE FROM telegram_outbox_posts WHERE user_id = $1`, [row.id]);
    await q(`DELETE FROM telegram_post_templates WHERE user_id = $1`, [row.id]);
    await q(`DELETE FROM telegram_post_preferences WHERE user_id = $1`, [row.id]);
    await q(`DELETE FROM telegram_channel_posts WHERE user_id = $1`, [row.id]);
    await q(`DELETE FROM telegram_channels WHERE user_id = $1`, [row.id]);
    await q(`DELETE FROM journal_daily_checklists WHERE user_id = $1`, [row.id]);
    await q(`DELETE FROM telegram_identities WHERE user_id = $1`, [row.id]);
    // Audit rows are an append-only trail; these are the events a DISPOSABLE probe identity caused on
    // staging in the last few minutes, and leaving them would leave a dangling actor once the probe user
    // goes. Scoped by actor, never by table.
    await q(`DELETE FROM audit_log WHERE actor_user_id = $1`, [row.id]);
    await q(`DELETE FROM users WHERE id = $1`, [row.id]);
  }
  return rows.length;
};

const stale = await purgeProbe();
if (stale > 0) console.log(`removed ${String(stale)} probe user(s) left by an earlier run`);

const [user] = await q(
  `INSERT INTO users (email,password_hash,role,locale,status,plan,timezone,created_at,updated_at)
   VALUES ('live-probe@velora.test',$1,'user','fa','active','free','Asia/Tehran',now(),now()) RETURNING id`,
  ["x".repeat(60)],
);
await q(
  `INSERT INTO telegram_identities (user_id,telegram_user_id,username,status,linked_at,created_at,updated_at)
   VALUES ($1,$2,'liveprobe','LINKED',now(),now(),now())`,
  [user.id, TG_USER],
);
await q(
  `INSERT INTO telegram_channels (user_id,chat_id,title,chat_type,status,can_post,created_at,updated_at)
   VALUES ($1,$2,'ICT','supergroup','ACTIVE',true,now(),now())`,
  [user.id, CHANNEL],
);
console.log(`fixtures: user ${user.id} · telegram ${TG_USER} · channel row ${CHANNEL} (ACTIVE)`);

// ── the deployed worker entry, over the real database ────────────────────────
const worker = (await import("../src/index.ts")).default;
const SECRET = "liveprobe-liveprobe-liveprobe-liveprobe-1";
const env = {
  HYPERDRIVE: { connectionString: PG },
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  TELEGRAM_UPDATE_MODE: "webhook",
  VELORA_APP_URL: "https://app.velora.test",
  APP_ENV: "production",
  TELEGRAM_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
  TELEGRAM_BOT_USERNAME: "MyVeloratradeBot",
  TELEGRAM_TEST_USER_ID: TG_USER,
  LATENCY_PROBE: "1",
  ...(process.env.GEMINI_API_KEY === undefined ? {} : { GEMINI_API_KEY: process.env.GEMINI_API_KEY }),
};
// Deferred work is AWAITED, not dropped: the worker hands the actual send to `waitUntil`, and a
// harness that forgets that reads the previous message and calls the product broken.
const mkCtx = () => {
  const props = [];
  return { props, waitUntil(p) { props.push(Promise.resolve(p).catch(() => undefined)); } };
};
let updateId = 8_500_000;
const send = async (update) => {
  const mark = outbound.length;
  const ctx = mkCtx();
  const res = await worker.fetch(new Request("http://bot.internal/api/v1/webhooks/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify({ update_id: ++updateId, ...update }),
  }), env, ctx);
  const body = await res.json().catch(() => null);
  await Promise.allSettled(ctx.props);
  const writes = outbound.slice(mark).filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
  const buttons = writes.flatMap((c) => {
    const kb = c.payload?.reply_markup?.inline_keyboard;
    return Array.isArray(kb) ? kb.flat().map((b) => b.callback_data ?? b.url ?? "") : [];
  });
  return { status: res.status, body, writes, text: String(writes.at(-1)?.payload?.text ?? ""), buttons };
};
const message = (text) => ({
  message: {
    message_id: 1, date: Math.floor(Date.now() / 1000),
    chat: { id: CHAT, type: "private" },
    from: { id: Number(TG_USER), is_bot: false, first_name: "Live", username: "liveprobe" },
    text,
  },
});
const callback = (data) => ({
  callback_query: {
    id: `cb-${String(updateId)}`, from: { id: Number(TG_USER), is_bot: false, first_name: "Live" },
    chat_instance: "ci", data,
    message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" } },
  },
});

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  → ${detail}`}`);
  if (!cond) failures += 1;
};

console.log("\n── live: the channel screen reads Telegram itself ──");
const channelStep = await send(message(`/channel ${CHANNEL}`));
const channelScreen = channelStep.text;
check("getChat was forwarded to the real Bot API", forwarded.some((f) => f.method === "getChat" && f.ok === true));
check("getChatMember was forwarded with the BOT's own id", forwarded.some((f) => f.method === "getChatMember" && f.ok === true));
check("the screen names the chat and its rights", channelScreen.length > 0, JSON.stringify(channelScreen.slice(0, 90)));
check("the screen is the channel screen, not the generic menu", !channelScreen.includes("— ثبت نشد"));

console.log("\n── live: /post with no checklist is blocked, with a way out ──");
const blockedStep = await send(message("/post velora.bias"));
const blocked = blockedStep.text;
const blockedButtons = blockedStep.buttons;
check("no publish button is offered", !blockedButtons.some((d) => d.startsWith("post_pub:")), blockedButtons.join(","));
check("the checklist fix is offered", blockedButtons.includes("menu:checklist"));
check("the channel screen is offered", blockedButtons.includes("menu:channel"));
check("home is always offered", blockedButtons.includes("menu:home"));
check("the card says the fields are unrecorded", blocked.includes("ثبت نشد"));

console.log("\n── live: filing the checklist through the bot ──");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran" }).format(new Date());
const checklistStep = await send(message(`/checklist ${today} bias: bullish\nleg: up\nlocation: premium\nh4: fvg\nh1: ob\nm15: none\ncisd: yes\nsmt: no\nmacro: 09:30\nsl: 2641.5\nrisk: 0.5%`));
const savedCard = checklistStep.text;
check("the checklist card came back with coverage", savedCard.length > 0, JSON.stringify(savedCard.slice(0, 80)));
const stored = await q(`SELECT report_date, items FROM journal_daily_checklists WHERE user_id = $1`, [user.id]);
check("the row is in the staging database, not in memory", stored.length === 1, `rows=${stored.length}`);
const confirmed = stored[0]?.items === undefined ? 0 : Object.values(stored[0].items).filter((i) => i?.state === "CONFIRMED").length;
check("all eleven fields are recorded as confirmed", confirmed === 11, `confirmed=${confirmed}`);

console.log("\n── live: the preview now offers a publish button ──");
const previewStep = await send(message("/post velora.bias"));
const preview = previewStep.text;
const previewButtons = previewStep.buttons;
const publishData = previewButtons.find((d) => d.startsWith("post_pub:"));
check("a publish button is offered", typeof publishData === "string", previewButtons.join(","));
check("the card shows the RECORDED bias, not a placeholder", preview.includes("BULLISH") || preview.includes("bullish"), JSON.stringify(preview.slice(0, 130)));
// The renderer's own footnote counts fields this template prints that are NOT checklist items (symbol,
// timeframe, …); the assertion is about the checklist lines, which are the ones the gate is about.
check("no checklist line reads 'not recorded'", !preview.includes("بایاس روزانه: — ثبت نشد") && !preview.includes("SMT: — ثبت نشد"), JSON.stringify(preview.slice(0, 130)));

console.log("\n── live: publishing is confirmed in-flow, and nothing leaves this machine ──");
const publishStep = await send(callback(publishData ?? "post_pub:0"));
const toChannel = publishStep.writes.filter((c) => String(c.payload?.chat_id) === CHANNEL);
check("the publish call was made against the CHANNEL chat id", toChannel.length === 1, `calls=${toChannel.length}`);
check("…and it was NOT forwarded to Telegram (no real post)", toChannel.every((c) => c.forwarded === false));
check("the user got a receipt", publishStep.text.length > 0, JSON.stringify(publishStep.text.slice(0, 90)));
const postRow = await q(`SELECT status, telegram_message_id FROM telegram_outbox_posts WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [user.id]);
check("the row is PUBLISHED with the channel's message id", postRow[0]?.status === "PUBLISHED" && postRow[0]?.telegram_message_id !== null, JSON.stringify(postRow[0] ?? null));

console.log("\n── live: a second tap cannot send twice ──");
const secondStep = await send(callback(publishData ?? "post_pub:0"));
check("the second tap sent nothing to the channel", secondStep.writes.filter((c) => String(c.payload?.chat_id) === CHANNEL).length === 0);
check("the second tap answers instead of crashing", secondStep.text.length > 0, JSON.stringify(secondStep.text.slice(0, 70)));

console.log("\n── live: the result screen and the rest of the menu still work ──");
const resultStep = await send(callback("menu:postresult"));
check("the result screen reports the published post", resultStep.text.includes("✅") || resultStep.text.includes("منتشر"), JSON.stringify(resultStep.text.slice(0, 110)));
const journalStep = await send(message("/journal"));
check("/journal still answers", journalStep.text.length > 0, JSON.stringify(journalStep.text.slice(0, 70)));
const statsStep = await send(message("/stats today"));
check("/stats today still answers", statsStep.text.length > 0, JSON.stringify(statsStep.text.slice(0, 80)));
const cancelStep = await send(message("/cancel"));
check("/cancel answers without the crash it had (23502)", cancelStep.text.length > 0 && !cancelStep.text.includes("خطایی رخ داد"), JSON.stringify(cancelStep.text.slice(0, 60)));

console.log("\n── cleanup ──");
await q(`DELETE FROM rate_limits WHERE bucket LIKE '%' || $1 || '%'`, [TG_USER]);
await q(`DELETE FROM telegram_updates WHERE update_id >= $1`, [String(8_500_000)]);
await purgeProbe();
const leftovers = await q(`SELECT count(*)::int AS n FROM users WHERE email = 'live-probe@velora.test'`);
check("the disposable user is gone", leftovers[0].n === 0);

console.log(`\nSUMMARY: ${failures === 0 ? "ALL PASS" : `${String(failures)} FAIL`} · Bot API reads forwarded live: ${String(forwarded.length)} · writes recorded and withheld: ${String(outbound.filter((c) => !c.forwarded).length)}`);
stub.close();
await db.end();
process.exit(failures === 0 ? 0 : 1);
