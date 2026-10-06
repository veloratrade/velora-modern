// MailPort adapter tests (Phase 3B-1, OD-12).
//
// The Resend adapter is exercised through an INJECTED transport: no network
// call, no real API key, no live send. Secret-handling assertions are explicit
// because §7 forbids leaking credentials through results or error paths.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAIL_FROM } from "./mailPort.js";
import { LogMailProvider } from "./logMailProvider.js";
import { ResendMailProvider, type HttpTransport } from "./resendMailProvider.js";

const MSG = { to: "trader@example.test", subject: "Subject", text: "Body" };

// --- log driver -------------------------------------------------------------

test("MAIL log driver: captures the message and reports success", async () => {
  const mail = new LogMailProvider();
  const res = await mail.send(MSG);
  assert.equal(res.ok, true);
  assert.equal(mail.outbox.length, 1);
  assert.equal(mail.lastTo("trader@example.test")?.subject, "Subject");
});

test("MAIL log driver: lastTo is case/whitespace insensitive, unknown → null", async () => {
  const mail = new LogMailProvider();
  await mail.send(MSG);
  assert.ok(mail.lastTo("  TRADER@EXAMPLE.TEST ") !== null);
  assert.equal(mail.lastTo("nobody@example.test"), null);
});

// --- Resend adapter ---------------------------------------------------------

function stub(
  status: number,
  body = "{}",
): { transport: HttpTransport; calls: { url: string; headers: Record<string, string>; body: string }[] } {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status, text: async () => body };
  };
  return { transport, calls };
}

test("RESEND: posts to the Resend API with the C-09 From identity", async () => {
  const { transport, calls } = stub(200, JSON.stringify({ id: "msg_123" }));
  const mail = new ResendMailProvider({ apiKey: "test-key-not-real", transport });

  const res = await mail.send(MSG);

  assert.deepEqual(res, { ok: true, id: "msg_123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  const sent = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.equal(sent["from"], MAIL_FROM);
  assert.equal(sent["from"], "VELORA TRADE <no-reply@veloratrade.ir>");
  assert.deepEqual(sent["to"], ["trader@example.test"]);
});

test("RESEND: sends the key ONLY as a Bearer header — never in the body", async () => {
  const { transport, calls } = stub(200);
  const mail = new ResendMailProvider({ apiKey: "super-secret-key", transport });
  await mail.send(MSG);

  assert.equal(calls[0]!.headers["Authorization"], "Bearer super-secret-key");
  // The credential must not appear anywhere in the serialized payload.
  assert.equal(calls[0]!.body.includes("super-secret-key"), false);
});

test("RESEND: NOT CONFIGURED (missing key) → fails closed, no transport call", async () => {
  const { transport, calls } = stub(200);
  const mail = new ResendMailProvider({ apiKey: undefined, transport });

  assert.equal(mail.configured, false);
  assert.deepEqual(await mail.send(MSG), { ok: false, reason: "not-configured" });
  assert.equal(calls.length, 0); // never attempts a send without a key
});

test("RESEND: blank/whitespace key is treated as missing (no accidental send)", async () => {
  const { transport, calls } = stub(200);
  const mail = new ResendMailProvider({ apiKey: "   ", transport });
  assert.equal(mail.configured, false);
  assert.deepEqual(await mail.send(MSG), { ok: false, reason: "not-configured" });
  assert.equal(calls.length, 0);
});

test("RESEND: provider 4xx/5xx → 'rejected'; error body never surfaced", async () => {
  const leaky = JSON.stringify({ message: "Invalid API key: super-secret-key" });
  const { transport } = stub(401, leaky);
  const mail = new ResendMailProvider({ apiKey: "super-secret-key", transport });

  const res = await mail.send(MSG);

  assert.deepEqual(res, { ok: false, reason: "rejected" });
  // The provider echoed the key back; it must not escape through the result.
  assert.equal(JSON.stringify(res).includes("super-secret-key"), false);
});

test("RESEND: transport throw → 'transport-error' (never propagates)", async () => {
  const transport: HttpTransport = async () => {
    throw new Error("ECONNRESET");
  };
  const mail = new ResendMailProvider({ apiKey: "k", transport });
  assert.deepEqual(await mail.send(MSG), { ok: false, reason: "transport-error" });
});

test("RESEND: 2xx with unparsable body is still a successful send", async () => {
  const { transport } = stub(202, "not-json");
  const mail = new ResendMailProvider({ apiKey: "k", transport });
  assert.deepEqual(await mail.send(MSG), { ok: true, id: null });
});

// --- MG-EMAIL-TYPES: branded sends (inline CID images, RFC 2369 header) ------

test("RESEND: inline CID images become attachments with content_id (Legacy parity)", async () => {
  const { transport, calls } = stub(200, JSON.stringify({ id: "msg_cid" }));
  const mail = new ResendMailProvider({ apiKey: "test-key-not-real", transport });

  const res = await mail.send({
    to: "trader@example.test",
    subject: "Subject",
    text: "Body",
    html: '<img src="cid:velora-logo" />',
    inlineImages: [
      { cid: "velora-logo", filename: "velora-email-logo.png", contentBase64: "aGVsbG8=" },
      { cid: "velora-verification", filename: "verification.png", contentBase64: "d29ybGQ=" },
    ],
  });

  assert.deepEqual(res, { ok: true, id: "msg_cid" });
  const sent = JSON.parse(calls[0]!.body) as {
    attachments: { filename: string; content: string; content_id: string }[];
  };
  assert.equal(sent.attachments.length, 2);
  assert.deepEqual(sent.attachments[0], {
    filename: "velora-email-logo.png",
    content: "aGVsbG8=",
    content_id: "velora-logo",
  });
  assert.deepEqual(sent.attachments[1], {
    filename: "verification.png",
    content: "d29ybGQ=",
    content_id: "velora-verification",
  });
});

test("RESEND: every send carries reply_to + List-Unsubscribe (Mailer-level, BUG-A9)", async () => {
  const { transport, calls } = stub(200);
  const mail = new ResendMailProvider({
    apiKey: "test-key-not-real",
    transport,
    appOrigin: "https://app.example.test/",
  });
  await mail.send(MSG);
  const sent = JSON.parse(calls[0]!.body) as {
    reply_to: string;
    headers: Record<string, string>;
  };
  assert.equal(sent.reply_to, "no-reply@veloratrade.ir");
  assert.equal(
    sent.headers["List-Unsubscribe"],
    "<mailto:support@veloratrade.ir?subject=unsubscribe>, " +
      "<https://app.example.test/profile?focus=email-preferences>",
  );
});

test("RESEND: over-length CID truncates to 127 (Legacy mb_substr cap)", async () => {
  const { transport, calls } = stub(200);
  const mail = new ResendMailProvider({ apiKey: "test-key-not-real", transport });
  const longCid = "a".repeat(200);
  await mail.send({
    to: "trader@example.test",
    subject: "s",
    text: "t",
    inlineImages: [{ cid: longCid, filename: "x.png", contentBase64: "" }],
  });
  const sent = JSON.parse(calls[0]!.body) as { attachments: { content_id: string }[] };
  assert.equal(sent.attachments[0]!.content_id.length, 127);
});
