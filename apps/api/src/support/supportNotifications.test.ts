// SupportService ↔ notifications wiring tests — MG-EMAIL-TYPES (AC-33).
//
// Legacy Phase 9A parity through the public service surface:
//   - createTicket → exactly ONE SUPPORT_NEW_TICKET notification
//   - first admin TEXT reply → exactly ONE SUPPORT_FIRST_REPLY notification
//   - internal notes (system_note) never trigger the reply email
//   - second admin reply → no second notification
//   - a notification failure never breaks the ticket/reply itself

import { test } from "node:test";
import assert from "node:assert/strict";

import { SupportService } from "./supportService.js";
import { MemorySupportStore } from "./supportService.js";

interface Hooks {
  newTicket: { ticketId: string; userId: string; subject: string; preview: string }[];
  firstReply: { ticketId: string; userId: string; subject: string; preview: string }[];
}

function makeService(opts: { throwOn?: "newTicket" | "firstReply" } = {}): {
  service: SupportService;
  hooks: Hooks;
} {
  const hooks: Hooks = { newTicket: [], firstReply: [] };
  const service = new SupportService({
    store: new MemorySupportStore(),
    notifications: {
      onNewTicket: async (input) => {
        if (opts.throwOn === "newTicket") throw new Error("boom");
        hooks.newTicket.push(input);
      },
      onFirstReply: async (input) => {
        if (opts.throwOn === "firstReply") throw new Error("boom");
        hooks.firstReply.push(input);
      },
    },
  });
  return { service, hooks };
}

test("support: ticket create fires exactly one SUPPORT_NEW_TICKET hook", async () => {
  const { service, hooks } = makeService();
  const { id } = await service.createTicket("5", {
    subject: "شارژ حساب",
    message: "سلام، حساب من شارژ نشد و موجودی کم شده.",
  });
  assert.equal(hooks.newTicket.length, 1);
  assert.equal(hooks.newTicket[0]!.ticketId, id);
  assert.equal(hooks.newTicket[0]!.userId, "5");
  assert.equal(hooks.newTicket[0]!.subject, "شارژ حساب");
  assert.ok(hooks.newTicket[0]!.preview.includes("شارژ نشد"));
  assert.ok(hooks.newTicket[0]!.preview.length <= 220, "preview bounded");
});

test("support: first admin text reply fires the hook once; notes and repeats do not", async () => {
  const { service, hooks } = makeService();
  const { id } = await service.createTicket("5", { subject: "s", message: "m" });
  await service.supportReply("admin-1", id, "پاسخ اول");
  assert.equal(hooks.firstReply.length, 1, "first admin text reply → hook");
  assert.equal(hooks.firstReply[0]!.ticketId, id);

  await service.supportReply("admin-1", id, "پاسخ دوم");
  assert.equal(hooks.firstReply.length, 1, "second reply → no second hook");

  // a fresh ticket: an internal note is NOT a reply
  const t2 = await service.createTicket("6", { subject: "s2", message: "m2" });
  await service.supportReply("admin-1", t2.id, "یادداشت داخلی", true);
  assert.equal(hooks.firstReply.length, 1, "internal note → no hook");
  await service.supportReply("admin-1", t2.id, "پاسخ واقعی");
  assert.equal(hooks.firstReply.length, 2, "first REAL reply on the second ticket → hook");
});

test("support: a notification failure never breaks the ticket or the reply", async () => {
  const boom = makeService({ throwOn: "newTicket" });
  const created = await boom.service.createTicket("7", { subject: "s", message: "m" });
  assert.ok(created.id.length > 0, "ticket exists despite the hook throwing");

  const boom2 = makeService({ throwOn: "firstReply" });
  const t = await boom2.service.createTicket("7", { subject: "s", message: "m" });
  const res = await boom2.service.supportReply("admin-1", t.id, "پاسخ");
  assert.ok(res.id.length > 0, "reply exists despite the hook throwing");
});
