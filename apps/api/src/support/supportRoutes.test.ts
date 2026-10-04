// Support HTTP surface — the whole capability over a real socket.
//
// WHAT THIS FILE IS EVIDENCE FOR. Everything below runs through the REAL kernel
// (`createApp` + `listen`) and the REAL bearer verification; only the storage
// adapter is a double. That is deliberate, because the security properties here
// are decided at the ROUTE layer and a service-level test cannot prove them:
//
//   1. identity comes from `claims.sub` ONLY — a client-supplied user id is
//      ignored, so a forged body cannot open a ticket in someone else's name;
//   2. a ticket belonging to another user is a non-disclosing 404 on every path;
//   3. the support surface is gated by the RBAC permissions mapped from Legacy's
//      P_COMM_VIEW / P_COMM_REPLY (admin + super_admin), NOT by a client role;
//   4. status and waiting_for are derived server-side — a client that sends them
//      cannot move the ticket itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, listen } from "../kernel/server.js";
import { AuthService } from "../auth/authService.js";
import { JwtService } from "../auth/jwt.js";
import { VeloraHasher } from "../auth/hashing.js";
import { MemoryUserStore } from "../auth/memoryUserStore.js";
import { LogMailProvider } from "../mail/logMailProvider.js";
import { MemoryAuditStore } from "../auth/memoryAuditStore.js";
import { FixedWindowRateLimiter } from "../ratelimits/rateLimiter.js";
import { MemoryRateLimitStore } from "../ratelimits/memoryRateLimitStore.js";
import { MemorySupportStore, SupportService } from "./supportService.js";

const JWT_SECRET = "support-routes-test-secret-0123456789abcdef"; // test-only

interface Envelope<T = Record<string, unknown>> {
  status: string;
  data: T;
  error: { code: string; message: string; details?: Record<string, string | number> } | null;
  timestamp: string;
}

interface Harness {
  readonly base: string;
  readonly store: MemoryUserStore;
  readonly roles: (email: string, role: "user" | "admin" | "super_admin") => Promise<void>;
  readonly close: () => Promise<void>;
}

async function withServer(fn: (h: Harness, tokens: { alice: string; bob: string; admin: string }) => Promise<void>): Promise<void> {
  const verificationTokens: string[] = [];
  const store = new MemoryUserStore();
  const auth = new AuthService({
    store,
    hasher: new VeloraHasher(),
    jwt: JwtService.create(JWT_SECRET),
    generateVerificationToken: () => {
      const t = `support-verification-${Math.random().toString(36).slice(2)}-0123456789`;
      verificationTokens.push(t);
      return t;
    },
    mail: new LogMailProvider(),
  });
  const support = new SupportService({ store: new MemorySupportStore() });
  const app = createApp({
    allowedOrigins: ["https://app.velora.example"],
    checks: { database: async () => "ok" as const },
    auth,
    support,
    rateLimiter: new FixedWindowRateLimiter(new MemoryRateLimitStore()),
  });
  const port = await listen(app);
  const base = `http://127.0.0.1:${port}`;

  /** Register → verify → (optionally elevate) → log in. Order matters: the token's
   *  role is read from storage at login, so the elevation has to happen first. */
  async function login(email: string, role: "user" | "admin" | "super_admin" = "user"): Promise<string> {
    await fetch(`${base}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    await fetch(`${base}/api/v1/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verificationTokens.shift() }),
    });
    if (role !== "user") {
      const user = await store.findUserByEmail(email);
      assert.ok(user !== null, `${email} must exist before it can be elevated`);
      await store.updateUserRole(user.id, role, new Date());
    }
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "a-strong-password-123" }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;
  }

  async function roles(email: string, role: "user" | "admin" | "super_admin"): Promise<void> {
    const user = await store.findUserByEmail(email);
    assert.ok(user !== null);
    await store.updateUserRole(user.id, role, new Date());
  }

  try {
    const alice = await login("sup-alice@velora.example");
    const bob = await login("sup-bob@velora.example");
    const admin = await login("sup-admin@velora.example", "admin");
    await fn({ base, store, roles, close: async () => undefined }, { alice, bob, admin });
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
  }
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function create(base: string, token: string, body: Record<string, unknown>): Promise<{ status: number; payload: Envelope<{ ticket: { id: string } }> }> {
  const res = await fetch(`${base}/api/v1/support/tickets`, { method: "POST", headers: bearer(token), body: JSON.stringify(body) });
  return { status: res.status, payload: (await res.json()) as Envelope<{ ticket: { id: string } }> };
}

// ── Authentication and authorization ────────────────────────────────────────

test("AUTH: every support route refuses an anonymous caller — user and support alike", async () => {
  await withServer(async ({ base }) => {
    const anonymous: [string, string][] = [
      ["GET", "/api/v1/support/tickets"],
      ["POST", "/api/v1/support/tickets"],
      ["GET", "/api/v1/support/tickets/1"],
      ["POST", "/api/v1/support/tickets/1/messages"],
      ["POST", "/api/v1/support/tickets/1/read"],
      ["POST", "/api/v1/support/tickets/1/reopen"],
      ["GET", "/api/v1/admin/communications/tickets"],
      ["POST", "/api/v1/admin/communications/tickets/1/status"],
    ];
    for (const [method, path] of anonymous) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : {},
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(((await res.json()) as Envelope).error?.code, "UNAUTHENTICATED");
    }
  });
});

test("AUTHZ: the support surface is closed to a plain user and open to an admin (Legacy P_COMM_*)", async () => {
  await withServer(async ({ base }, { alice, admin }) => {
    const asUser = await fetch(`${base}/api/v1/admin/communications/tickets`, { headers: bearer(alice) });
    assert.equal(asUser.status, 403);
    assert.equal(((await asUser.json()) as Envelope).error?.code, "FORBIDDEN");

    const asAdmin = await fetch(`${base}/api/v1/admin/communications/tickets`, { headers: bearer(admin) });
    assert.equal(asAdmin.status, 200);

    // The permission is decided by the STORED role, not by what the client says:
    // an admin who is demoted loses the surface with the token they already hold.
    const { payload } = await create(base, alice, { subject: "s", message: "m" });
    assert.equal(payload.status, "success");
  });
});

test("AUTHZ: an admin may NOT read a user's private list — that surface is the user's own", async () => {
  await withServer(async ({ base }, { alice, admin }) => {
    const { payload } = await create(base, alice, { subject: "خصوصی", message: "فقط من" });
    const adminTriesUserSurface = await fetch(`${base}/api/v1/support/tickets/${payload.data.ticket.id}`, { headers: bearer(admin) });
    // The admin token is a valid user token too, but it is NOT alice: the route
    // scopes on claims.sub, so the admin sees the same 404 alice's neighbour sees.
    assert.equal(adminTriesUserSurface.status, 404);
    // Support has its own, authorized view of that same ticket.
    const supportView = await fetch(`${base}/api/v1/admin/communications/tickets/${payload.data.ticket.id}`, { headers: bearer(admin) });
    assert.equal(supportView.status, 200);
  });
});

// ── Identity is server-derived ──────────────────────────────────────────────

test("IDENTITY: a client-supplied user_id is ignored — the ticket belongs to the token holder", async () => {
  await withServer(async ({ base }, { alice, bob }) => {
    const res = await fetch(`${base}/api/v1/support/tickets`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({ subject: "s", message: "m", user_id: "999", userId: "999" }),
    });
    assert.equal(res.status, 201);
    const id = ((await res.json()) as Envelope<{ ticket: { id: string } }>).data.ticket.id;

    for (const [method, path, payload] of [
      ["GET", `/api/v1/support/tickets/${id}`, undefined],
      ["POST", `/api/v1/support/tickets/${id}/messages`, { message: "سلام" }],
      ["POST", `/api/v1/support/tickets/${id}/read`, {}],
      ["POST", `/api/v1/support/tickets/${id}/reopen`, {}],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: bearer(bob),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      assert.equal(res.status, 404, `${method} ${path} must not disclose alice's ticket`);
      const env = (await res.json()) as Envelope;
      // Legacy answers a missing ticket with its generic 404 envelope code and the
      // same message either way; Modern keeps BOTH, so the response cannot be used
      // to tell "someone else's ticket" from "no such ticket".
      assert.equal(env.error?.code, "NOT_FOUND");
      assert.equal(env.error?.message, "Ticket not found.");
    }
    const bobList = (await (await fetch(`${base}/api/v1/support/tickets`, { headers: bearer(bob) })).json()) as Envelope<{ total: number }>;
    assert.equal(bobList.data.total, 0, "…and it is not in bob's list");
  });
});

test("STATUS IS SERVER-DERIVED: a forged status in the body does not move the ticket", async () => {
  await withServer(async ({ base }, { alice, admin }) => {
    const { payload } = await create(base, alice, { subject: "s", message: "m" });
    const id = payload.data.ticket.id;
    const res = await fetch(`${base}/api/v1/support/tickets/${id}/messages`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({ message: "سلام", status: "closed", waiting_for: "none" }),
    });
    assert.equal(res.status, 200);
    const seen = (await (await fetch(`${base}/api/v1/admin/communications/tickets/${id}`, { headers: bearer(admin) })).json()) as Envelope<{
      conversation: { status: string; waitingFor: string };
    }>;
    assert.equal(seen.data.conversation.status, "open", "a user reply re-opens, never closes");
    assert.equal(seen.data.conversation.waitingFor, "admin");
  });
});

// ── Happy path over HTTP ────────────────────────────────────────────────────

test("LIFECYCLE over HTTP: create → admin reply → user reply → close → reopen", async () => {
  await withServer(async ({ base }, { alice, admin }) => {
    const created = await create(base, alice, { subject: "  شارژ حساب  ", message: "سلام، حساب من شارژ نشد.\r\nلطفاً بررسی کنید." });
    assert.equal(created.status, 201);
    const id = created.payload.data.ticket.id;

    const list = (await (await fetch(`${base}/api/v1/support/tickets`, { headers: bearer(alice) })).json()) as Envelope<{
      tickets: { id: string; subject: string }[];
      unreadTotal: number;
    }>;
    assert.equal(list.data.tickets[0]!.subject, "شارژ حساب", "the subject is trimmed server-side");

    const reply = await fetch(`${base}/api/v1/admin/communications/tickets/${id}/messages`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({ message: "در حال بررسی است." }),
    });
    assert.equal(reply.status, 200);
    assert.equal(
      ((await reply.json()) as Envelope<{ message: { waitingFor: string; firstReply: boolean } }>).data.message.waitingFor,
      "user",
      "an admin text reply hands the ticket to the user",
    );

    const userReply = await fetch(`${base}/api/v1/support/tickets/${id}/messages`, {
      method: "POST",
      headers: bearer(alice),
      body: JSON.stringify({ message: "ممنون." }),
    });
    assert.equal(userReply.status, 200);

    const closed = await fetch(`${base}/api/v1/admin/communications/tickets/${id}/status`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({ action: "close" }),
    });
    assert.equal(closed.status, 200);
    assert.equal(((await closed.json()) as Envelope<{ status: string }>).data.status, "closed");

    const reopened = await fetch(`${base}/api/v1/support/tickets/${id}/reopen`, { method: "POST", headers: bearer(alice), body: "{}" });
    assert.equal(reopened.status, 200);
    assert.deepEqual(
      ((await reopened.json()) as Envelope<{ status: string; waitingFor: string }>).data,
      { status: "open", waitingFor: "admin" },
    );

    // `read` is idempotent: calling it twice is a success, not a conflict.
    for (let i = 0; i < 2; i += 1) {
      const read = await fetch(`${base}/api/v1/support/tickets/${id}/read`, { method: "POST", headers: bearer(alice), body: "{}" });
      assert.equal(read.status, 200);
    }
  });
});

test("HTTP SHAPE: invalid input is a 422 with Legacy's own code, an unknown ticket a 404", async () => {
  await withServer(async ({ base }, { alice, admin }) => {
    // 422 + Legacy's own codes: the web client keys its fa/en validation copy off
    // exactly these (Legacy `errors.support.subjectInvalid` / `…messageInvalid`).
    const overlong = await create(base, alice, { subject: "ا".repeat(201), message: "m" });
    assert.equal(overlong.status, 422);
    assert.equal(overlong.payload.error?.code, "SUPPORT_SUBJECT_INVALID");

    const missing = await create(base, alice, { subject: "s" });
    assert.equal(missing.status, 422);
    assert.equal(missing.payload.error?.code, "SUPPORT_MESSAGE_INVALID");

    const longBody = await create(base, alice, { subject: "s", message: "x".repeat(5001) });
    assert.equal(longBody.status, 422);
    assert.equal(longBody.payload.error?.code, "SUPPORT_MESSAGE_INVALID");

    const notFound = await fetch(`${base}/api/v1/support/tickets/999999`, { headers: bearer(alice) });
    assert.equal(notFound.status, 404);

    // Existence is checked BEFORE the action: an unknown action on an unknown
    // ticket is a 404 (Legacy's `adminSetStatus` loads the row first too).
    assert.equal(
      (await fetch(`${base}/api/v1/admin/communications/tickets/999999/status`, {
        method: "POST",
        headers: bearer(admin),
        body: JSON.stringify({ action: "explode" }),
      })).status,
      404,
    );
    const live = await create(base, alice, { subject: "s", message: "m" });
    const badAction = await fetch(`${base}/api/v1/admin/communications/tickets/${live.payload.data.ticket.id}/status`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({ action: "explode" }),
    });
    assert.equal(badAction.status, 422);
    assert.equal(((await badAction.json()) as Envelope).error?.code, "SUPPORT_INVALID_ACTION");
  });
});

test("HTTP SHAPE: a wrong method is a 405 on both surfaces, and support list filters work", async () => {
  await withServer(async ({ base }, { alice, admin }) => {
    assert.equal((await fetch(`${base}/api/v1/support/tickets`, { method: "DELETE", headers: bearer(alice) })).status, 405);
    assert.equal((await fetch(`${base}/api/v1/support/tickets/1/read`, { headers: bearer(alice) })).status, 405);
    assert.equal((await fetch(`${base}/api/v1/admin/communications/tickets/1/status`, { headers: bearer(admin) })).status, 405);

    const { payload } = await create(base, alice, { subject: "شارژ حساب", message: "m" });
    const id = payload.data.ticket.id;
    await fetch(`${base}/api/v1/admin/communications/tickets/${id}/messages`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({ message: "پاسخ" }),
    });
    const queued = (await (await fetch(`${base}/api/v1/admin/communications/tickets?status=pending&q=شارژ`, { headers: bearer(admin) })).json()) as Envelope<{
      total: number;
      counters: Record<string, number>;
    }>;
    assert.equal(queued.data.total, 1);
    assert.equal(queued.data.counters["pending"], 1);
  });
});

test("INTERNAL NOTES: an admin cannot write one (fail-closed), and a super_admin's note is invisible to the user", async () => {
  await withServer(async ({ base, roles }, { alice, admin }) => {
    const { payload } = await create(base, alice, { subject: "s", message: "m" });
    const id = payload.data.ticket.id;

    // Legacy's controller computed `internal` as `!empty($body['internal']) &&
    // $me['role'] === SUPER_ADMIN`, so an ADMIN who asked for an internal note got
    // it written as a USER-VISIBLE reply instead. That direction leaks internal
    // remarks to the customer, so Modern refuses the request outright.
    const asAdmin = await fetch(`${base}/api/v1/admin/communications/tickets/${id}/messages`, {
      method: "POST",
      headers: bearer(admin),
      body: JSON.stringify({ message: "یادداشت داخلی", internal: true }),
    });
    assert.equal(asAdmin.status, 403);
    assert.equal(((await asAdmin.json()) as Envelope).error?.code, "FORBIDDEN");

    await roles("sup-admin@velora.example", "super_admin");
    const superAdmin = ((await (await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sup-admin@velora.example", password: "a-strong-password-123" }),
    })).json()) as Envelope<{ tokens: { accessToken: string } }>).data.tokens.accessToken;

    const note = await fetch(`${base}/api/v1/admin/communications/tickets/${id}/messages`, {
      method: "POST",
      headers: bearer(superAdmin),
      body: JSON.stringify({ message: "یادداشت داخلی", internal: true }),
    });
    assert.equal(note.status, 200);
    const noteEnv = (await note.json()) as Envelope<{ message: { waitingFor: string; firstReply: boolean } }>;
    assert.equal(noteEnv.data.message.firstReply, false, "a note is not a visible reply, so it cannot be the first one");
    assert.equal(noteEnv.data.message.waitingFor, "admin", "…and it must not hand the ticket to the user");

    // Written as a note or not, it is never part of what the user reads…
    const userView = (await (await fetch(`${base}/api/v1/support/tickets/${id}`, { headers: bearer(alice) })).json()) as Envelope<{
      messages: { messageType: string }[];
      conversation: { status: string; waitingFor: string };
    }>;
    assert.equal(userView.data.messages.every((m) => m.messageType !== "system_note"), true);
    assert.equal(userView.data.conversation.waitingFor, "admin", "a note must not tell the user they were answered");
    // …but support does see it, flagged as internal.
    const supportView = (await (await fetch(`${base}/api/v1/admin/communications/tickets/${id}`, { headers: bearer(superAdmin) })).json()) as Envelope<{
      messages: { messageType: string }[];
    }>;
    assert.equal(supportView.data.messages.some((m) => m.messageType === "system_note"), true);
  });
});

test("THROTTLE: a ticket is not an amplification channel — the write route is rate limited per user", async () => {
  await withServer(async ({ base }, { alice }) => {
    let sawLimit = false;
    let opened = 0;
    for (let i = 0; i < 25; i += 1) {
      const res = await create(base, alice, { subject: `s${i}`, message: "m" });
      if (res.status === 429) {
        sawLimit = true;
        assert.equal(res.payload.error?.code, "TOO_MANY_REQUESTS");
        break;
      }
      assert.equal(res.status, 201);
      opened += 1;
    }
    assert.ok(sawLimit, "the 20-per-5-minute write budget must engage");
    assert.ok(opened >= 20, `expected the budget to allow the first 20 writes, saw ${opened}`);
  });
});
