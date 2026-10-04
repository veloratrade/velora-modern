// Support ticket lifecycle — Phase 5.
//
// These assertions are the CAPABILITY CONTRACT, taken from Legacy's own rules
// (api/src/Support/SupportService.php lifecycle block + `boundedFilters`):
//
//   user creates            -> status=open,    waiting_for=admin
//   admin text reply        -> status=pending, waiting_for=user   (+ first_reply_at ONCE)
//   user reply              -> status=open,    waiting_for=admin
//   admin closes            -> status=closed,  waiting_for=none
//   user reopens            -> status=open,    waiting_for=admin
//   admin reopens           -> status=pending, waiting_for=user
//   archive                 -> only from closed
//
// Two things are asserted that Legacy got WRONG or left to the client, because
// they are the difference between "a shell" and a real capability:
//   * an INTERNAL NOTE moves nothing (Legacy flipped the ticket, raised the user's
//     unread badge and stamped the first-reply sentinel);
//   * a CLIENT NEVER SENDS status/waiting_for — they are derived from the event.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemorySupportStore,
  SupportError,
  SupportService,
  sanitizeText,
  validateBody,
  validateSubject,
  type SupportStore,
} from "./supportService.js";

const svc = () => new SupportService({ store: new MemorySupportStore() });

async function ticketFor(service: SupportService, userId = "1"): Promise<string> {
  const { id } = await service.createTicket(userId, { subject: "شارژ حساب", message: "سلام، حساب من شارژ نشد." });
  return id;
}

test("create: a ticket opens for the ADMIN with one unread message for them", async () => {
  const service = svc();
  const id = await ticketFor(service);
  const { conversation, messages } = await service.userTicket("1", id);
  assert.equal(conversation.status, "open");
  assert.equal(conversation.waitingFor, "admin");
  assert.equal(conversation.unreadAdminCount, 1, "the opening message is unread FOR SUPPORT");
  assert.equal(conversation.unreadUserCount, 0);
  assert.equal(conversation.firstReplyAt, null, "no answer has been visible to the user yet");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.senderType, "user");
  assert.equal(messages[0]!.body, "سلام، حساب من شارژ نشد.");
});

test("admin text reply: hands the ticket to the user and stamps the first-reply sentinel ONCE", async () => {
  const service = svc();
  const id = await ticketFor(service);
  const first = await service.supportReply("9", id, "در حال بررسی است.");
  assert.deepEqual({ status: first.status, waitingFor: first.waitingFor, firstReply: first.firstReply }, { status: "pending", waitingFor: "user", firstReply: true });
  const second = await service.supportReply("9", id, "بررسی تمام شد.");
  assert.equal(second.firstReply, false, "the sentinel is an idempotency marker, not a per-reply flag");
  const { conversation } = await service.userTicket("1", id, { markRead: false });
  assert.equal(conversation.unreadUserCount, 2, "BOTH replies are unread for the user");
  assert.equal(conversation.unreadAdminCount, 0, "support read their own thread");
  // …and reading clears the badge IN THE SAME RESPONSE, so the screen the user
  // just opened does not render an unread marker for a message they are reading.
  const read = await service.userTicket("1", id);
  assert.equal(read.conversation.unreadUserCount, 0);
  assert.equal((await service.userTicket("1", id, { markRead: false })).conversation.unreadUserCount, 0);
  assert.notEqual(conversation.firstReplyAt, null);
});

test("DEFECT NOT REPRODUCED: an internal note moves nothing at all", async () => {
  const service = svc();
  const id = await ticketFor(service);
  const note = await service.supportReply("9", id, "کاربر قبلاً هم تیکت زده — چک کن.", true);
  assert.equal(note.firstReply, false);
  const { conversation, messages } = await service.userTicket("1", id);
  assert.equal(conversation.status, "open", "an invisible note must not flip the ticket to pending");
  assert.equal(conversation.waitingFor, "admin");
  assert.equal(conversation.unreadUserCount, 0, "…nor tell the user an answer is waiting");
  assert.equal(conversation.firstReplyAt, null, "…nor stamp the first-reply sentinel");
  assert.equal(messages.length, 1, "system notes are never user-visible");

  const admin = await service.supportTicket(id, { markRead: false });
  assert.equal(admin.messages.length, 2, "…but support DOES see it");
  assert.equal(admin.messages[1]!.messageType, "system_note");
});

test("user reply: back to the admin, clearing the user's unread badge", async () => {
  const service = svc();
  const id = await ticketFor(service);
  await service.supportReply("9", id, "پاسخ اول.");
  const reply = await service.userReply("1", id, "ممنون، هنوز مشکل دارم.");
  assert.deepEqual({ status: reply.status, waitingFor: reply.waitingFor }, { status: "open", waitingFor: "admin" });
  const { conversation } = await service.userTicket("1", id, { markRead: false });
  // NOT 2: support's own reply cleared their badge, and this user reply raises it
  // from 0 to 1 (Legacy's rule — an admin message marks the admin as having read
  // the thread, a user message raises their count again).
  assert.equal(conversation.unreadAdminCount, 1, "the user's reply is unread for support");
  // 0, and for the same rule: the user's own message marks the thread as read FOR
  // the user (Legacy clears the writer's own unread counter), so a reply also
  // serves as the read receipt.
  assert.equal(conversation.unreadUserCount, 0, "writing clears the writer's own unread badge");
});

test("close → user reopen → admin reopen, with each side's own destination", async () => {
  const service = svc();
  const id = await ticketFor(service);
  assert.deepEqual(await service.supportSetStatus("9", id, "close"), { status: "closed", waitingFor: "none" });

  // a closed ticket refuses a reply until it is reopened (Legacy: 422)
  await assert.rejects(() => service.userReply("1", id, "سلام؟"), (err: unknown) => {
    assert.ok(err instanceof SupportError);
    assert.equal(err.status, 422);
    assert.equal(err.code, "SUPPORT_TICKET_CLOSED");
    return true;
  });

  assert.deepEqual(await service.userReopen("1", id), { status: "open", waitingFor: "admin" });
  await service.supportSetStatus("9", id, "close");
  assert.deepEqual(await service.supportSetStatus("9", id, "reopen"), { status: "pending", waitingFor: "user" }, "an admin reopen hands it back to the user");
});

test("archive: only a CLOSED ticket may be archived; an archived ticket takes no replies", async () => {
  const service = svc();
  const id = await ticketFor(service);
  await assert.rejects(() => service.supportSetStatus("9", id, "archive"), (err: unknown) => {
    assert.ok(err instanceof SupportError);
    assert.equal(err.code, "SUPPORT_INVALID_TRANSITION");
    return true;
  });
  await service.supportSetStatus("9", id, "close");
  assert.deepEqual(await service.supportSetStatus("9", id, "archive"), { status: "archived", waitingFor: "none" });
  await assert.rejects(
    () => service.supportReply("9", id, "یک نکته"),
    (err: unknown) => err instanceof SupportError && err.code === "SUPPORT_INVALID_TRANSITION",
  );
});

test("a reopen on a live ticket is refused, and a concurrent transition is a 409", async () => {
  const service = svc();
  const id = await ticketFor(service);
  await assert.rejects(() => service.userReopen("1", id), (err: unknown) => err instanceof SupportError && err.code === "SUPPORT_INVALID_TRANSITION");

  // The store is the authority on "did MY transition win?" — a false answer is a
  // conflict, never a silent success. The double DELEGATES everything and only
  // makes the transition lose the race (a spread of a class instance would drop
  // its private state, so an explicit wrapper is the honest way to build this).
  const inner = new MemorySupportStore();
  const losing: SupportStore = {
    createTicket: (...args) => inner.createTicket(...args),
    listUserTickets: (...args) => inner.listUserTickets(...args),
    conversationForUser: (...args) => inner.conversationForUser(...args),
    conversation: (...args) => inner.conversation(...args),
    messages: (...args) => inner.messages(...args),
    appendMessage: (...args) => inner.appendMessage(...args),
    transition: async () => false,
    markUserRead: (...args) => inner.markUserRead(...args),
    markAdminRead: (...args) => inner.markAdminRead(...args),
    unreadForUser: (...args) => inner.unreadForUser(...args),
    adminList: (...args) => inner.adminList(...args),
    assign: (...args) => inner.assign(...args),
  };
  const raced = new SupportService({ store: losing });
  const racedId = await raced.createTicket("1", { subject: "s", message: "m" });
  await assert.rejects(() => raced.supportSetStatus("9", racedId.id, "close"), (err: unknown) => err instanceof SupportError && err.status === 409);
});

test("OWNERSHIP: another user's ticket is a single non-disclosing 404 on every path", async () => {
  const service = svc();
  const id = await ticketFor(service, "1");
  for (const act of [
    () => service.userTicket("2", id),
    () => service.userReply("2", id, "سلام"),
    () => service.userReopen("2", id),
  ]) {
    await assert.rejects(act, (err: unknown) => {
      assert.ok(err instanceof SupportError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "SUPPORT_TICKET_NOT_FOUND");
      return true;
    });
  }
  // …and a ticket that does not exist at all is the SAME answer.
  await assert.rejects(
    () => service.userTicket("1", "999999"),
    (err: unknown) => err instanceof SupportError && err.status === 404,
  );
});

test("validation: subject and body bounds come from Legacy, and a UTF-8 subject is measured in code points", async () => {
  assert.equal(validateSubject("  شارژ حساب  "), "شارژ حساب", "trimmed");
  assert.equal(validateSubject("ا".repeat(200)), "ا".repeat(200), "200 Persian characters are 200 characters");
  assert.throws(() => validateSubject("ا".repeat(201)), /max 200/);
  assert.throws(() => validateSubject(""), /required/);
  assert.throws(() => validateSubject(42), /required/);

  assert.equal(validateBody("سلام\r\nدنیا"), "سلام\nدنیا", "CRLF normalised");
  assert.equal(sanitizeText("a\u0000b\u0007c"), "abc", "control characters stripped");
  assert.equal(sanitizeText("a\n\nb").includes("\n"), true, "newlines survive");
  assert.throws(() => validateBody("x".repeat(5001)), /max 5000/);
  assert.throws(() => validateBody(null), /required/);
});

test("listing: bounded to 20 per page with a stable order and a per-user unread total", async () => {
  const service = svc();
  for (let i = 0; i < 3; i += 1) await ticketFor(service, "1");
  await ticketFor(service, "2");
  const page = await service.listUserTickets("1", {});
  assert.equal(page.tickets.length, 3, "only the caller's tickets");
  assert.equal(page.total, 3);
  assert.equal(page.perPage, 20);
  assert.equal(page.page, 1);
  assert.equal(page.unreadTotal, 0, "nobody has answered yet ⇒ nothing is unread FOR THE USER");
  assert.equal((await service.listUserTickets("1", { status: "pending" })).tickets.length, 0);
  assert.equal((await service.listUserTickets("1", { page: 2 })).page, 2);
  assert.equal((await service.listUserTickets("1", { page: 0 })).page, 1, "an invalid page falls back to the first, never an error page");

  // …and an answer shows up as unread for the user, then in the pending filter.
  await service.supportReply("9", page.tickets[0]!.id, "پاسخ");
  assert.equal((await service.listUserTickets("1", {})).unreadTotal, 1, "an answer raises the user's unread total");
  assert.equal((await service.listUserTickets("1", { status: "pending" })).tickets.length, 1);
});

test("support queue: filters, counters, search and the unread filter", async () => {
  const service = svc();
  const a = await ticketFor(service, "1");
  await ticketFor(service, "2");
  await service.supportReply("9", a, "بررسی می‌کنم.");
  const all = await service.listForSupport({});
  assert.equal(all.total, 2);
  assert.deepEqual(all.counters, { open: 1, pending: 1, unread: 1 });
  assert.equal((await service.listForSupport({ status: "pending" })).total, 1);
  assert.equal((await service.listForSupport({ waitingFor: "user" })).total, 1);
  assert.equal((await service.listForSupport({ unread: "admin" })).total, 1);
  assert.equal((await service.listForSupport({ q: "شارژ" })).total, 2);
  assert.equal((await service.listForSupport({ q: "شارژ%" })).total, 0, "a bound parameter, never a pattern");
});

test("ORDERING: the lists follow the last VISIBLE message — an internal note reorders nothing", async () => {
  const service = svc();
  const first = await ticketFor(service, "1");
  const second = await ticketFor(service, "1");
  // the newest ticket is on top…
  assert.deepEqual((await service.listUserTickets("1", {})).tickets.map((t) => t.id), [second, first]);
  // …a reply moves the OTHER one up, because that is a visible event…
  await service.supportReply("9", first, "پاسخ");
  assert.deepEqual((await service.listUserTickets("1", {})).tickets.map((t) => t.id), [first, second]);
  assert.deepEqual((await service.listForSupport({})).tickets.map((t) => t.id), [first, second]);
  // …and a note moves nothing at all, so the order is unchanged.
  await service.supportReply("9", second, "یادداشت داخلی", true);
  assert.deepEqual((await service.listUserTickets("1", {})).tickets.map((t) => t.id), [first, second]);
  assert.deepEqual((await service.listForSupport({})).tickets.map((t) => t.id), [first, second]);
});

test("QUEUE COUNTERS describe the queue, not the current filter", async () => {
  const service = svc();
  const a = await ticketFor(service, "1");
  await ticketFor(service, "2");
  await service.supportReply("9", a, "پاسخ");
  const filtered = await service.listForSupport({ status: "pending" });
  assert.equal(filtered.total, 1, "the filter applies to the rows…");
  assert.deepEqual(filtered.counters, { open: 1, pending: 1, unread: 1 }, "…and the badges stay whole-queue");
});

test("support read clears the admin badge and returns the ticket", async () => {
  const service = svc();
  const id = await ticketFor(service);
  const before = await service.supportTicket(id, { markRead: false });
  assert.equal(before.conversation.unreadAdminCount, 1);
  const after = await service.supportTicket(id);
  assert.equal(after.conversation.unreadAdminCount, 0);
  // Support reads ANY ticket by design (the route authorizes the caller); what it
  // does NOT do is invent one.
  const foreign = await ticketFor(service, "2");
  assert.equal((await service.supportTicket(foreign, { markRead: false })).conversation.userId, "2");
  await assert.rejects(
    () => service.supportTicket("999999", { markRead: false }),
    (err: unknown) => err instanceof SupportError && err.status === 404,
  );
});

test("assignment is recorded and unknown tickets are a 404", async () => {
  const service = svc();
  const id = await ticketFor(service);
  await service.assign(id, "9");
  assert.equal((await service.supportTicket(id, { markRead: false })).conversation.assignedAdminId, "9");
  await assert.rejects(() => service.assign("999999", "9"), (err: unknown) => err instanceof SupportError && err.status === 404);
});
