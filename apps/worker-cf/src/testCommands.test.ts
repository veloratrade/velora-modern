/**
 * Unit battery for the private-test command layer — the fix for «/start did not work».
 *
 * These assert grammar and wording only. Whether a *delivered* `/start` produces a store write, a
 * reply and a terminal outcome is `d1TestStore.test.ts` (fake store, real handler) and
 * `deploy-kit/verify-gate.sh` (live Worker, live D1, real Bot API); the split is deliberate, because
 * the reported defect had two causes and only one of them is code.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml, planCommand, replyFor } from "./testCommands.js";
import { zeroCounts } from "./d1TestStore.js";

const plan = (text: string | null, kind: "message" | "callback_query" | "edited_message" = "message") =>
  planCommand({ kind, text });

const say = (text: string | null, counts = zeroCounts()) => {
  const p = plan(text);
  return replyFor({ plan: p, counts, updateId: 991, kind: "message", storage: "d1-test" });
};

test("/start is its own command, and so is /start with a payload", () => {
  assert.equal(plan("/start").command, "start");
  assert.equal(plan("  /start  ").command, "start", "Telegram sends the text verbatim; padding is not a different command");
  assert.equal(plan("/start@MyVeloratradeBot").command, "start", "the privacy-mode mention form is the same command");
  assert.equal(plan("/start LINK-abc123").command, "start_payload");
  assert.equal(plan("/start@MyVeloratradeBot\tLINK-abc").command, "start_payload");
});

test("/help, /stats and ordinary text are told apart; unknown slashes are not swallowed", () => {
  assert.equal(plan("/help").command, "help");
  assert.equal(plan("/stats@MyVeloratradeBot").command, "stats");
  assert.equal(plan("خرید EURUSD 1.5").command, "record");
  assert.equal(plan(null).command, "record", "a message with no text (a photo, a sticker) still gets recorded");
  assert.equal(plan("").command, "record");
  // The product answers any other leading slash with the menu. Here that path does not exist, and
  // answering "recorded" is honest; what must not happen is silence.
  assert.equal(plan("/journal").command, "record");
  assert.equal(plan("/nostart").command, "record", "a prefix look-alike is not a command");
});

test("only /stats pays for a read, and no command is read-only in the sense of skipping the claim", () => {
  assert.equal(plan("/stats").needsCounts, true);
  for (const text of ["/start", "/help", "سلام", "/start TOKEN"]) assert.equal(plan(text).needsCounts, false, text);
});

test("a callback query never becomes a command, whatever its data says", () => {
  // `callback_query.data` is the one field in an update an attacker fully controls. If it were
  // parsed as a command, `data: "/start"` would reach the onboarding branch and `data:
  // "/stats"` would read the store, both without the sender having typed anything.
  for (const data of ["/start", "/stats", "/start LINK-1", "confirm:999"]) {
    const p = plan(data, "callback_query");
    assert.equal(p.command, "callback", data);
    assert.equal(p.needsCounts, false, data);
  }
});

test("the /start reply states what works here and what does not, in Persian", () => {
  const text = say("/start");
  assert.match(text, /حالت تست خصوصی/);
  assert.match(text, /D1/);
  assert.match(text, /\/stats/);
  assert.match(text, /update_id یکتا/, "dedupe is described because it is the property under test");
  assert.match(text, /PostgreSQL نیاز دارند/, "and the disabled capabilities are in the same message, not in a footnote");
  assert.ok(!/ثبت معاملهٔ واقعی|trade/i.test(text), "no wording may suggest a real trade is recorded");
  assert.ok(!/https?:\/\//.test(text), "the private-test onboarding sends nobody anywhere by URL");
});

test("/start with a payload refuses the handshake instead of imitating it", () => {
  const text = say("/start LINK-abc123");
  assert.match(text, /اتصال حساب در این نسخه انجام نمی‌شود/);
  assert.match(text, /دسترسی‌ای نمی‌خرد|دسترسی‌ای نمی‌دهد/, "the refusal says why: untrusted text buys no authority");
  assert.ok(!/LINK-abc123/.test(text), "the payload is never echoed back into the reply");
  assert.ok(!/✓|✅|ثبت شد/.test(text), "a refused handshake must not look like a completed one");
});

test("/stats reports the numbers the store returned, and only those", () => {
  const counts = { rows: 12, handled: 6, failed: 5, claimed: 1, retries: 3 };
  const text = say("/stats", counts);
  assert.match(text, /ردیف=12/);
  assert.match(text, /handled=6/);
  assert.match(text, /failed=5/);
  assert.match(text, /claimed=1/);
  assert.match(text, /retry=3/, "the retry total is the observable of acceptance rule 7");
  assert.match(text, /d1-test/, "and the reply names which store answered, so a test DB is never read as the product one");
  // A reply must not invent a count it did not read: zeroCounts is what the non-stats paths carry.
  assert.match(say("/start"), /^((?!ردیف=).)*$/s, "the /start reply contains no counters at all");
});

test("every reply is HTML-safe under the parse_mode the client always sets", () => {
  // `HttpTelegramBotApi.sendMessage` sends `parse_mode: "HTML"` for every message, so an
  // unescaped `<` in interpolated text is a markup error at best and a silent format change at worst.
  for (const text of ["/start", "/start LINK<x>&y", "/help", "/stats", "some <b>text</b>"]) {
    const reply = say(text, { rows: 1, handled: 0, failed: 0, claimed: 1, retries: 0 });
    assert.ok(!/<(?!\/?(b|i|u|code|pre)\b)[a-zA-Z]/.test(reply.replace(/&lt;|&gt;|&amp;/g, "")), reply.slice(0, 80));
  }
  assert.equal(escapeHtml(`<a href="x">&`), "&lt;a href=\"x\"&gt;&amp;");
});

test("the record ack keeps the update id and the kind, because that is what a test reads back", () => {
  const text = say("سلام دنیا");
  assert.match(text, /✓ ثبت شد/);
  assert.match(text, /update 991/);
  assert.match(text, /kind message/);
  assert.ok(!/سلام دنیا/.test(text), "the stored excerpt is not reflected back into the reply");
});

test("the callback reply is an acknowledgement, not a result", () => {
  const text = replyFor({ plan: plan("", "callback_query"), counts: zeroCounts(), updateId: 5, kind: "callback_query", storage: "d1-test" });
  assert.match(text, /دادهٔ callback در این نسخه پردازش نمی‌شود/);
  assert.ok(!/✓ انجام شد|confirmed/i.test(text), "nothing may read as an executed action");
});
