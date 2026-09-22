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
