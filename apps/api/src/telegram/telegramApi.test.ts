// The Bot API client — the only module that speaks to api.telegram.org.
//
// THE PROPERTY THAT MATTERS MOST IS ONE TELEGRAM NEVER TOLD US ABOUT: the bot
// token travels in the URL PATH. That makes every careless mistake — a thrown
// driver error, a retried request logged with its URL, an error message built
// from `response.url` — a credential leak. The suite below therefore does not
// merely check that calls succeed; it checks that NOTHING THIS MODULE PRODUCES
// EVER CONTAINS THE TOKEN, including on every failure path, and it would fail if
// a future edit embedded a URL in a message.
//
// The remaining cases pin the classifications the callers branch on:
//   * 409 CONFLICT is what a second consumer of the update stream looks like, and
//     the poller backs off furthest on exactly that code;
//   * `retry_after` is surfaced, never slept on internally (a silent retry inside
//     a webhook response would stack latency and hide the limit);
//   * a download is refused when it exceeds the cap rather than truncated —
//     a truncated screenshot stored as an attachment is silent corruption;
//   * `getChatMember` derives posting rights from fields Telegram ACTUALLY sent,
//     defaulting to "cannot post" — an unverified chat is never treated as
//     writable, because that decision binds a user's journal to a chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpTelegramBotApi, TELEGRAM_MAX_DOWNLOAD_BYTES, TelegramApiError } from "./telegramApi.js";
import type { SecretValue } from "./telegramConfig.js";

const TOKEN = "123456789:AAFakeTokenValueForTestsOnly_000000000000";
const secret: SecretValue = { reveal: () => TOKEN, toString: () => "[redacted]", toJSON: () => "[redacted]" } as SecretValue;

interface Call {
  url: string;
  /** Present-but-possibly-undefined: `exactOptionalPropertyTypes` forbids assigning undefined to an optional field. */
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } | undefined;
}

/** A scripted transport. Every call is recorded so the request itself is assertable. */
function transport(script: (call: Call) => { ok?: boolean; status?: number; json?: unknown; bytes?: Buffer } | "throw" | "abort" | "badjson") {
  const calls: Call[] = [];
  const impl = async (url: string, init?: Call["init"]) => {
    const call: Call = { url, init };
    calls.push(call);
    const next = script(call);
    if (next === "throw") throw new Error(`connect failed: ${url}`);
    if (next === "abort") {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    if (next === "badjson") {
      return { ok: true, status: 200, json: async () => { throw new Error("not json"); }, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.json ?? { ok: true, result: true },
      // Copy out of the Buffer's OWN window: small Buffers share one pooled
      // ArrayBuffer, so a bare `.buffer` would hand back unrelated bytes.
      arrayBuffer: async () => {
        const bytes = next.bytes ?? Buffer.from("");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
    };
  };
  return { impl, calls };
}

test("the token is sent in the URL — and appears in NOTHING the client produces", async () => {
  const t = transport(() => ({ json: { ok: false, error_code: 401, description: "Unauthorized" } }));
  const api = new HttpTelegramBotApi(secret, t.impl as never);

  let caught: unknown;
  try {
    await api.sendMessage("555", "hello");
  } catch (err) {
    caught = err;
  }

  // It WAS sent (that is how the Bot API authenticates) …
  assert.ok(t.calls[0]!.url.includes(TOKEN));
  // … and it is absent from every artifact a log or a stack could capture.
  const err = caught as TelegramApiError;
  assert.ok(err instanceof TelegramApiError);
  assert.ok(!err.message.includes(TOKEN), "the error message must not carry the token");
  assert.ok(!err.message.includes("api.telegram.org"), "the error message must not carry the URL");
  assert.ok(!JSON.stringify(err).includes(TOKEN));
  assert.ok(!String(err.stack ?? "").includes(TOKEN), "a stack trace must not quote the request URL");
  assert.equal(err.code, "API_ERROR");
});

test("a transport failure and a timeout are different codes, neither echoing the URL", async () => {
  const net = transport(() => "throw");
  await assert.rejects(
    () => new HttpTelegramBotApi(secret, net.impl as never).sendMessage("555", "x"),
    (err: TelegramApiError) => err.code === "NETWORK" && !err.message.includes(TOKEN) && !err.message.includes("connect failed"),
  );

  const aborted = transport(() => "abort");
  await assert.rejects(
    () => new HttpTelegramBotApi(secret, aborted.impl as never).sendMessage("555", "x"),
    (err: TelegramApiError) => err.code === "TIMEOUT" && err.status === null,
  );
});

test("429 surfaces retry_after to the caller instead of sleeping on it internally", async () => {
  const t = transport(() => ({ json: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } } }));
  await assert.rejects(
    () => new HttpTelegramBotApi(secret, t.impl as never).sendMessage("555", "x"),
    (err: TelegramApiError) => {
      assert.equal(err.code, "RATE_LIMITED");
      assert.equal(err.retryAfterSeconds, 7, "the limit must reach the caller, which decides what to do");
      assert.equal(t.calls.length, 1, "the client must not retry behind the caller's back");
      return true;
    },
  );
});

test("a second consumer (409) is classified as CONFLICT, not as a generic failure", async () => {
  const t = transport(() => ({ ok: false, status: 409, json: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" } }));
  await assert.rejects(
    () => new HttpTelegramBotApi(secret, t.impl as never).getUpdates(null),
    (err: TelegramApiError) => err.code === "CONFLICT" && err.telegramCode === 409,
  );
});

test("an unparseable body is MALFORMED_RESPONSE rather than an exception escaping the module", async () => {
  const t = transport(() => "badjson");
  await assert.rejects(
    () => new HttpTelegramBotApi(secret, t.impl as never).getUpdates(null),
    (err: TelegramApiError) => err.code === "MALFORMED_RESPONSE",
  );
});

test("getUpdates bounds its own long-poll window and asks for the offset it was given", async () => {
  const t = transport(() => ({ json: { ok: true, result: [] } }));
  const api = new HttpTelegramBotApi(secret, t.impl as never);

  await api.getUpdates(42);
  const payload = JSON.parse(t.calls[0]!.init!.body!) as Record<string, unknown>;
  assert.equal(payload["offset"], 42);
  assert.equal(payload["timeout"], 25);

  // The Bot API's own contract is 0–50s; a caller's mistake must not become a
  // request the API rejects (which would look like a network failure to the poller).
  await api.getUpdates(null, 5000);
  assert.equal((JSON.parse(t.calls[1]!.init!.body!) as Record<string, unknown>)["timeout"], 50);
  await api.getUpdates(null, -3);
  const third = JSON.parse(t.calls[2]!.init!.body!) as Record<string, unknown>;
  assert.equal(third["timeout"], 0);
  assert.ok(!("offset" in third), "a null offset must mean \"whatever is pending\", not offset 0");
});

test("a download over the cap is refused, never silently truncated", async () => {
  const big = Buffer.alloc(TELEGRAM_MAX_DOWNLOAD_BYTES + 1, 1);
  const t = transport(() => ({ ok: true, status: 200, bytes: big }));
  await assert.rejects(
    () => new HttpTelegramBotApi(secret, t.impl as never).downloadFile("voice/file_1.oga"),
    (err: TelegramApiError) => err.code === "FILE_TOO_LARGE",
  );

  const small = transport(() => ({ ok: true, status: 200, bytes: Buffer.from("ID3audio") }));
  const bytes = await new HttpTelegramBotApi(secret, small.impl as never).downloadFile("voice/file_1.oga");
  assert.equal(bytes.toString(), "ID3audio");
  assert.ok(small.calls[0]!.url.includes(TOKEN) === true);
});

test("posting rights come from Telegram's own fields and default to NO", async () => {
  const cases: { result: Record<string, unknown>; canPost: boolean }[] = [
    { result: { status: "creator" }, canPost: true },
    { result: { status: "administrator", can_post_messages: true }, canPost: true },
    { result: { status: "administrator" }, canPost: true }, // field omitted, admin ⇒ posting is intended
    { result: { status: "administrator", can_post_messages: false }, canPost: false },
    { result: { status: "member" }, canPost: false },
    { result: { status: "restricted", can_post_messages: true }, canPost: false },
    { result: { status: "left" }, canPost: false },
    { result: { status: "something_new" }, canPost: false }, // unknown status → least authority
    { result: {}, canPost: false },
  ];
  for (const c of cases) {
    const t = transport(() => ({ json: { ok: true, result: c.result } }));
    const member = await new HttpTelegramBotApi(secret, t.impl as never).getChatMember("-100123", "999");
    assert.equal(member.canPostMessages, c.canPost, `status=${String(c.result["status"])} can_post_messages=${String(c.result["can_post_messages"])}`);
  }

  // A status Telegram never documented must not be trusted as membership either.
  const unknown = transport(() => ({ json: { ok: true, result: { status: "banana" } } }));
  const member = await new HttpTelegramBotApi(secret, unknown.impl as never).getChatMember("-100123", "999");
  assert.equal(member.status, "left");
});

test("a private chat reported for a channel id is reported as private, and a chat lookup failure is classified", async () => {
  const priv = transport(() => ({ json: { ok: true, result: { id: 555, type: "private", first_name: "Trader" } } }));
  const chat = await new HttpTelegramBotApi(secret, priv.impl as never).getChat("555");
  assert.equal(chat.type, "private", "the caller refuses private chats; the client must not relabel one");

  const missing = transport(() => ({ ok: false, status: 404, json: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }));
  await assert.rejects(
    () => new HttpTelegramBotApi(secret, missing.impl as never).getChat("-100999"),
    (err: TelegramApiError) => err.code === "API_ERROR" && err.telegramCode === 400,
  );
});

test("buttons are sent in the shape Telegram accepts — url XOR callback_data", async () => {
  const t = transport(() => ({ json: { ok: true, result: { message_id: 77 } } }));
  const api = new HttpTelegramBotApi(secret, t.impl as never);
  const sent = await api.sendMessage("555", "card", {
    replyToMessageId: "41",
    inlineKeyboard: [[{ text: "تأیید", callbackData: "confirm:12" }], [{ text: "اتصال امن به Velora", url: "https://t.me/velora_bot?start=abc" }]],
  });
  assert.equal(sent.messageId, "77");

  const payload = JSON.parse(t.calls[0]!.init!.body!) as Record<string, unknown>;
  assert.equal(payload["chat_id"], "555");
  assert.equal(payload["reply_to_message_id"], 41, "ids cross the wire as numbers, as the Bot API requires");
  const rows = (payload["reply_markup"] as { inline_keyboard: Record<string, unknown>[][] }).inline_keyboard;
  assert.deepEqual(rows[0]![0], { text: "تأیید", callback_data: "confirm:12" });
  assert.deepEqual(rows[1]![0], { text: "اتصال امن به Velora", url: "https://t.me/velora_bot?start=abc" });
});
