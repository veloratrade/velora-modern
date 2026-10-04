// Support ticket domain service — Phase 5 (the capability Legacy shipped in
// `api/src/Support/`, migrated by MEANING; no PHP structure copied).
//
// THE MODEL (source-read of Legacy's SupportService/SupportRepository, migrated):
//
//   Two INDEPENDENT axes, both SERVER-DERIVED:
//     status       open | pending | closed | archived    — what the ticket is
//     waiting_for  admin | user | none                   — whose turn it is
//
//   Lifecycle, exactly as Legacy defined it:
//     user creates          -> open    / admin
//     admin text reply      -> pending / user   (+ first_reply_at, once)
//     user reply            -> open    / admin
//     admin closes          -> closed  / none
//     user reopens (only from closed|archived) -> open    / admin
//     admin reopens                            -> pending / user
//     archive (only from closed)               -> archived / none
//
//   A client NEVER sends `status` or `waiting_for`; they are derived from the
//   event. That is what stops a caller from asserting "waiting for user".
//
// ONE DEFECT IS NOT REPRODUCED (documented in 0026 and pinned by tests): Legacy
// ran the same UPDATE for every admin message, so an INTERNAL NOTE flipped the
// ticket to pending/user, raised the user's unread badge and stamped the
// first-reply sentinel — the user was told an answer existed while nothing they
// could see had been written. Modern stores the note (admin-only) and moves
// nothing.
//
// OWNERSHIP IS STRUCTURAL: every user-facing read/write is scoped by `user_id`,
// and a foreign ticket is a single non-disclosing 404 (a missing ticket and
// somebody else's ticket are indistinguishable to the caller).
//
// VALIDATION: subject 1..200, body 1..5000 (Legacy's own bounds), control
// characters stripped except newline, CRLF normalised. The DATABASE enforces the
// same bounds (0026 CHECKs) — this layer exists to return a precise 422, never to
// "fix up" a violating value.
import type { QueryFn } from "../persistence/pg.js";

export const SUPPORT_STATUSES = ["open", "pending", "closed", "archived"] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export const SUPPORT_WAITING = ["admin", "user", "none"] as const;
export type SupportWaiting = (typeof SUPPORT_WAITING)[number];
export const SUPPORT_PRIORITIES = ["low", "normal", "high"] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];
export const MESSAGE_TYPES = ["text", "system_note"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
export const PAGE_SIZE = 20;
export const MAX_MESSAGES_PER_READ = 200;

export interface SupportTicketRecord {
  readonly id: string;
  readonly userId: string;
  readonly subject: string;
  readonly status: SupportStatus;
  readonly waitingFor: SupportWaiting;
  readonly priority: SupportPriority | null;
  readonly assignedAdminId: string | null;
  readonly firstReplyAt: string | null;
  readonly lastMessageAt: string;
  readonly unreadAdminCount: number;
  readonly unreadUserCount: number;
  readonly createdAt: string;
}

export interface SupportMessageRecord {
  readonly id: string;
  readonly senderType: "user" | "admin" | "system";
  readonly senderUserId: string | null;
  readonly body: string;
  readonly messageType: MessageType;
  readonly createdAt: string;
}

export interface SupportCounters {
  readonly open: number;
  readonly pending: number;
  readonly unread: number;
}

export class SupportError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SupportError";
  }
}

export interface SupportStore {
  createTicket(userId: string, subject: string, body: string): Promise<{ id: string }>;
  listUserTickets(userId: string, filters: { status?: SupportStatus; offset: number; limit: number }): Promise<{ tickets: SupportTicketRecord[]; total: number }>;
  conversationForUser(userId: string, ticketId: string): Promise<SupportTicketRecord | null>;
  conversation(ticketId: string): Promise<SupportTicketRecord | null>;
  messages(ticketId: string, includeInternal: boolean, limit: number): Promise<SupportMessageRecord[]>;
  appendMessage(input: {
    ticketId: string;
    senderType: "user" | "admin" | "system";
    senderId: string | null;
    body: string;
    messageType: MessageType;
    requireLive: boolean;
  }): Promise<{ messageId: string; status: SupportStatus; waitingFor: SupportWaiting; firstReplyNow: boolean } | null>;
  transition(ticketId: string, from: SupportStatus[], to: { status: SupportStatus; waitingFor: SupportWaiting }): Promise<boolean>;
  markUserRead(userId: string, ticketId: string): Promise<boolean>;
  markAdminRead(ticketId: string): Promise<boolean>;
  unreadForUser(userId: string): Promise<number>;
  adminList(filters: { status?: SupportStatus; waitingFor?: SupportWaiting; unread?: "admin" | "user"; q?: string; offset: number; limit: number }): Promise<{ tickets: SupportTicketRecord[]; total: number; counters: SupportCounters }>;
  assign(ticketId: string, adminUserId: string | null): Promise<boolean>;
}

type Row = Record<string, unknown>;

function mapTicket(row: Row): SupportTicketRecord {
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    subject: String(row["subject"]),
    status: String(row["status"]) as SupportStatus,
    waitingFor: String(row["waiting_for"]) as SupportWaiting,
    priority: row["priority"] === null ? null : (String(row["priority"]) as SupportPriority),
    assignedAdminId: row["assigned_admin_id"] === null ? null : String(row["assigned_admin_id"]),
    firstReplyAt: row["first_reply_at"] === null ? null : iso(row["first_reply_at"]),
    lastMessageAt: iso(row["last_message_at"]),
    unreadAdminCount: Number(row["unread_admin_count"]),
    unreadUserCount: Number(row["unread_user_count"]),
    createdAt: iso(row["created_at"]),
  };
}

function mapMessage(row: Row): SupportMessageRecord {
  return {
    id: String(row["id"]),
    senderType: String(row["sender_type"]) as "user" | "admin" | "system",
    senderUserId: row["sender_user_id"] === null ? null : String(row["sender_user_id"]),
    body: String(row["body"]),
    messageType: String(row["message_type"]) as MessageType,
    createdAt: iso(row["created_at"]),
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Strip control characters (keep newlines), normalise CRLF, trim. Legacy's rule. */
export function sanitizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

export function validateSubject(raw: unknown): string {
  if (typeof raw !== "string") throw new SupportError(422, "SUPPORT_SUBJECT_INVALID", `Subject is required (max ${SUBJECT_MAX} chars).`);
  const subject = sanitizeText(raw);
  // Length is measured in CODE POINTS, the same unit the DB CHECK uses
  // (char_length): a 200-character Persian subject must not be rejected because
  // its UTF-8 form is longer.
  if (subject.length === 0 || [...subject].length > SUBJECT_MAX) {
    throw new SupportError(422, "SUPPORT_SUBJECT_INVALID", `Subject is required (max ${SUBJECT_MAX} chars).`);
  }
  return subject;
}

export function validateBody(raw: unknown): string {
  if (typeof raw !== "string") throw new SupportError(422, "SUPPORT_MESSAGE_INVALID", `Message is required (max ${BODY_MAX} chars).`);
  const body = sanitizeText(raw);
  if (body.length === 0 || [...body].length > BODY_MAX) {
    throw new SupportError(422, "SUPPORT_MESSAGE_INVALID", `Message is required (max ${BODY_MAX} chars).`);
  }
  return body;
}

export interface SupportServiceDeps {
  readonly store: SupportStore;
}

export class SupportService {
  constructor(private readonly deps: SupportServiceDeps) {}

  // ── user side ─────────────────────────────────────────────────────────────

  async createTicket(userId: string, input: { subject?: unknown; message?: unknown }): Promise<{ id: string }> {
    const subject = validateSubject(input.subject);
    const body = validateBody(input.message);
    return this.deps.store.createTicket(userId, subject, body);
  }

  async listUserTickets(userId: string, query: { status?: string; page?: number }): Promise<{
    tickets: SupportTicketRecord[];
    total: number;
    page: number;
    perPage: number;
    unreadTotal: number;
  }> {
    const status = SUPPORT_STATUSES.includes(query.status as SupportStatus) ? (query.status as SupportStatus) : undefined;
    const page = Number.isInteger(query.page) && (query.page as number) > 0 ? (query.page as number) : 1;
    const { tickets, total } = await this.deps.store.listUserTickets(userId, {
      ...(status === undefined ? {} : { status }),
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    return { tickets, total, page, perPage: PAGE_SIZE, unreadTotal: await this.deps.store.unreadForUser(userId) };
  }

  /** Ownership-enforced detail. A foreign ticket is a non-disclosing 404. */
  async userTicket(userId: string, ticketId: string, options: { markRead?: boolean } = {}): Promise<{
    conversation: SupportTicketRecord;
    messages: SupportMessageRecord[];
  }> {
    const conversation = await this.deps.store.conversationForUser(userId, ticketId);
    if (conversation === null) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
    // System notes are NEVER user-visible (Legacy's own rule on the user read path).
    const messages = await this.deps.store.messages(ticketId, false, MAX_MESSAGES_PER_READ);
    if (options.markRead !== false) {
      await this.deps.store.markUserRead(userId, ticketId);
      // The response must not report a badge that THIS call just cleared: the
      // client would render "1 unread" on the screen it is opening. (Legacy's
      // user path returned the pre-read row; its admin path already zeroed the
      // field explicitly — this is that same correction, applied to both.)
      return { conversation: { ...conversation, unreadUserCount: 0 }, messages };
    }
    return { conversation, messages };
  }

  async userReply(userId: string, ticketId: string, message: unknown): Promise<{ id: string; status: SupportStatus; waitingFor: SupportWaiting }> {
    const body = validateBody(message);
    const conversation = await this.deps.store.conversationForUser(userId, ticketId);
    if (conversation === null) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
    const appended = await this.deps.store.appendMessage({
      ticketId,
      senderType: "user",
      senderId: userId,
      body,
      messageType: "text",
      requireLive: true,
    });
    if (appended === null) {
      // The guard refused: the only reason a live ticket rejects a user message is
      // that it stopped being live between the read and the write.
      throw new SupportError(422, "SUPPORT_TICKET_CLOSED", "Ticket is closed; reopen it first.");
    }
    return { id: appended.messageId, status: appended.status, waitingFor: appended.waitingFor };
  }

  async userReopen(userId: string, ticketId: string): Promise<{ status: SupportStatus; waitingFor: SupportWaiting }> {
    const conversation = await this.deps.store.conversationForUser(userId, ticketId);
    if (conversation === null) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
    return this.reopen(conversation, "user");
  }

  // ── support/admin side (HTTP surface lands with the admin phase) ───────────

  async listForSupport(query: {
    status?: string;
    waitingFor?: string;
    unread?: string;
    q?: string;
    page?: number;
  }): Promise<{ tickets: SupportTicketRecord[]; total: number; page: number; perPage: number; counters: SupportCounters }> {
    const page = Number.isInteger(query.page) && (query.page as number) > 0 ? (query.page as number) : 1;
    const status = SUPPORT_STATUSES.includes(query.status as SupportStatus) ? (query.status as SupportStatus) : undefined;
    const waitingFor = SUPPORT_WAITING.includes(query.waitingFor as SupportWaiting) ? (query.waitingFor as SupportWaiting) : undefined;
    const unread = query.unread === "admin" || query.unread === "user" ? query.unread : undefined;
    const q = typeof query.q === "string" ? sanitizeText(query.q).slice(0, 100) : undefined;
    const { tickets, total, counters } = await this.deps.store.adminList({
      ...(status === undefined ? {} : { status }),
      ...(waitingFor === undefined ? {} : { waitingFor }),
      ...(unread === undefined ? {} : { unread }),
      ...(q === undefined || q === "" ? {} : { q }),
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    return { tickets, total, page, perPage: PAGE_SIZE, counters };
  }

  async supportTicket(ticketId: string, options: { markRead?: boolean } = {}): Promise<{
    conversation: SupportTicketRecord;
    messages: SupportMessageRecord[];
  }> {
    const conversation = await this.deps.store.conversation(ticketId);
    if (conversation === null) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
    const messages = await this.deps.store.messages(ticketId, true, MAX_MESSAGES_PER_READ);
    if (options.markRead !== false) {
      await this.deps.store.markAdminRead(ticketId);
      return { conversation: { ...conversation, unreadAdminCount: 0 }, messages };
    }
    return { conversation, messages };
  }

  async supportReply(actorId: string, ticketId: string, message: unknown, internal = false): Promise<{
    id: string;
    status: SupportStatus;
    waitingFor: SupportWaiting;
    firstReply: boolean;
  }> {
    const body = validateBody(message);
    const conversation = await this.deps.store.conversation(ticketId);
    if (conversation === null) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
    if (conversation.status === "archived") {
      throw new SupportError(422, "SUPPORT_INVALID_TRANSITION", "Archived tickets cannot receive replies.");
    }
    const appended = await this.deps.store.appendMessage({
      ticketId,
      senderType: "admin",
      senderId: actorId,
      body,
      messageType: internal ? "system_note" : "text",
      requireLive: false,
    });
    if (appended === null) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
    return { id: appended.messageId, status: appended.status, waitingFor: appended.waitingFor, firstReply: appended.firstReplyNow };
  }

  async supportSetStatus(actorId: string, ticketId: string, action: string): Promise<{ status: SupportStatus; waitingFor: SupportWaiting }> {
    const conversation = await this.deps.store.conversation(ticketId);
    if (conversation === null) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
    switch (action) {
      case "close":
        return this.transitionOrConflict(ticketId, ["open", "pending"], { status: "closed", waitingFor: "none" });
      case "archive":
        // Legacy: only a CLOSED ticket may be archived.
        if (conversation.status !== "closed") {
          throw new SupportError(422, "SUPPORT_INVALID_TRANSITION", "Only closed tickets can be archived.");
        }
        return this.transitionOrConflict(ticketId, ["closed"], { status: "archived", waitingFor: "none" });
      case "open":
        return this.transitionOrConflict(ticketId, ["open", "pending", "closed", "archived"], { status: "open", waitingFor: "admin" });
      case "reopen":
        return this.reopen(conversation, "admin");
      default:
        throw new SupportError(422, "SUPPORT_INVALID_ACTION", "Unknown status action.");
    }
    void actorId;
  }

  async assign(ticketId: string, adminUserId: string | null): Promise<void> {
    const ok = await this.deps.store.assign(ticketId, adminUserId);
    if (!ok) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
  }

  // ── shared internals ──────────────────────────────────────────────────────

  /** A user reopen returns the ticket to the admin; an admin reopen hands it back to the user. */
  private async reopen(conversation: SupportTicketRecord, actor: "user" | "admin"): Promise<{ status: SupportStatus; waitingFor: SupportWaiting }> {
    if (conversation.status !== "closed" && conversation.status !== "archived") {
      throw new SupportError(422, "SUPPORT_INVALID_TRANSITION", "Only closed tickets can be reopened.");
    }
    const to: { status: SupportStatus; waitingFor: SupportWaiting } =
      actor === "admin" ? { status: "pending", waitingFor: "user" } : { status: "open", waitingFor: "admin" };
    return this.transitionOrConflict(conversation.id, ["closed", "archived"], to);
  }

  private async transitionOrConflict(
    ticketId: string,
    from: SupportStatus[],
    to: { status: SupportStatus; waitingFor: SupportWaiting },
  ): Promise<{ status: SupportStatus; waitingFor: SupportWaiting }> {
    const applied = await this.deps.store.transition(ticketId, from, to);
    if (!applied) {
      throw new SupportError(409, "SUPPORT_STATE_CONFLICT", "Ticket state changed concurrently; reload and retry.");
    }
    return { status: to.status, waitingFor: to.waitingFor };
  }
}

// ── PostgreSQL store ────────────────────────────────────────────────────────

const TICKET_COLUMNS = `id, user_id, subject, status, waiting_for, priority, assigned_admin_id,
                        first_reply_at, last_message_at, unread_admin_count, unread_user_count, created_at`;

export class PgSupportStore implements SupportStore {
  constructor(private readonly q: QueryFn) {}

  async createTicket(userId: string, subject: string, body: string): Promise<{ id: string }> {
    const rows = await this.q("SELECT ticket_id, created_at FROM velora_support_create_ticket($1,$2,$3)", [userId, subject, body]);
    const row = rows[0];
    if (row === undefined) throw new SupportError(500, "SUPPORT_CREATE_FAILED", "Ticket could not be created.");
    return { id: String(row["ticket_id"]) };
  }

  async listUserTickets(userId: string, filters: { status?: SupportStatus; offset: number; limit: number }): Promise<{ tickets: SupportTicketRecord[]; total: number }> {
    const params: unknown[] = [userId];
    let where = "user_id = $1";
    if (filters.status !== undefined) {
      params.push(filters.status);
      where += ` AND status = $${params.length}`;
    }
    const total = await this.q(`SELECT count(*)::int AS n FROM support_tickets WHERE ${where}`, params);
    params.push(filters.limit, filters.offset);
    const rows = await this.q(
      `SELECT ${TICKET_COLUMNS} FROM support_tickets WHERE ${where}
        ORDER BY last_message_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { tickets: rows.map(mapTicket), total: Number(total[0]?.["n"] ?? 0) };
  }

  async conversationForUser(userId: string, ticketId: string): Promise<SupportTicketRecord | null> {
    const rows = await this.q(`SELECT ${TICKET_COLUMNS} FROM support_tickets WHERE id = $1 AND user_id = $2`, [ticketId, userId]);
    const row = rows[0];
    return row === undefined ? null : mapTicket(row);
  }

  async conversation(ticketId: string): Promise<SupportTicketRecord | null> {
    const rows = await this.q(`SELECT ${TICKET_COLUMNS} FROM support_tickets WHERE id = $1`, [ticketId]);
    const row = rows[0];
    return row === undefined ? null : mapTicket(row);
  }

  async messages(ticketId: string, includeInternal: boolean, limit: number): Promise<SupportMessageRecord[]> {
    const rows = await this.q(
      `SELECT id, sender_type, sender_user_id, body, message_type, created_at
         FROM support_messages
        WHERE ticket_id = $1 AND deleted_at IS NULL ${includeInternal ? "" : "AND message_type = 'text'"}
        ORDER BY created_at ASC, id ASC LIMIT $2`,
      [ticketId, limit],
    );
    return rows.map(mapMessage);
  }

  async appendMessage(input: {
    ticketId: string;
    senderType: "user" | "admin" | "system";
    senderId: string | null;
    body: string;
    messageType: MessageType;
    requireLive: boolean;
  }): Promise<{ messageId: string; status: SupportStatus; waitingFor: SupportWaiting; firstReplyNow: boolean } | null> {
    const rows = await this.q("SELECT * FROM velora_support_append_message($1,$2,$3,$4,$5,$6)", [
      input.ticketId,
      input.senderType,
      input.senderId,
      input.body,
      input.messageType,
      input.requireLive,
    ]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      messageId: String(row["message_id"]),
      status: String(row["status"]) as SupportStatus,
      waitingFor: String(row["waiting_for"]) as SupportWaiting,
      firstReplyNow: row["first_reply_now"] === true,
    };
  }

  async transition(ticketId: string, from: SupportStatus[], to: { status: SupportStatus; waitingFor: SupportWaiting }): Promise<boolean> {
    const rows = await this.q("SELECT * FROM velora_support_transition($1,$2::text[],$3,$4)", [ticketId, from, to.status, to.waitingFor]);
    return rows.length > 0;
  }

  async markUserRead(userId: string, ticketId: string): Promise<boolean> {
    const rows = await this.q(
      "UPDATE support_tickets SET unread_user_count = 0 WHERE id = $1 AND user_id = $2 RETURNING id",
      [ticketId, userId],
    );
    return rows.length > 0;
  }

  async markAdminRead(ticketId: string): Promise<boolean> {
    const rows = await this.q("UPDATE support_tickets SET unread_admin_count = 0 WHERE id = $1 RETURNING id", [ticketId]);
    return rows.length > 0;
  }

  async unreadForUser(userId: string): Promise<number> {
    const rows = await this.q(
      "SELECT COALESCE(SUM(unread_user_count), 0)::int AS n FROM support_tickets WHERE user_id = $1 AND status <> 'archived'",
      [userId],
    );
    return Number(rows[0]?.["n"] ?? 0);
  }

  async adminList(filters: { status?: SupportStatus; waitingFor?: SupportWaiting; unread?: "admin" | "user"; q?: string; offset: number; limit: number }): Promise<{ tickets: SupportTicketRecord[]; total: number; counters: SupportCounters }> {
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (filters.status !== undefined) {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filters.waitingFor !== undefined) {
      params.push(filters.waitingFor);
      clauses.push(`waiting_for = $${params.length}`);
    }
    if (filters.unread === "admin") clauses.push("unread_admin_count > 0");
    if (filters.unread === "user") clauses.push("unread_user_count > 0");
    if (filters.q !== undefined) {
      params.push(`%${filters.q.replace(/[%_]/g, (m) => `\\${m}`)}%`);
      clauses.push(`subject ILIKE $${params.length}`);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const total = await this.q(`SELECT count(*)::int AS n FROM support_tickets${where}`, params);
    params.push(filters.limit, filters.offset);
    const rows = await this.q(
      `SELECT ${TICKET_COLUMNS} FROM support_tickets${where}
        ORDER BY last_message_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const counters = await this.q(
      `SELECT
         count(*) FILTER (WHERE status = 'open')::int    AS open,
         count(*) FILTER (WHERE status = 'pending')::int AS pending,
         COALESCE(SUM(unread_admin_count), 0)::int       AS unread
       FROM support_tickets`,
    );
    return {
      tickets: rows.map(mapTicket),
      total: Number(total[0]?.["n"] ?? 0),
      counters: {
        open: Number(counters[0]?.["open"] ?? 0),
        pending: Number(counters[0]?.["pending"] ?? 0),
        unread: Number(counters[0]?.["unread"] ?? 0),
      },
    };
  }

  async assign(ticketId: string, adminUserId: string | null): Promise<boolean> {
    const rows = await this.q("UPDATE support_tickets SET assigned_admin_id = $2, updated_at = now() WHERE id = $1 RETURNING id", [
      ticketId,
      adminUserId,
    ]);
    return rows.length > 0;
  }
}

// ── in-memory double (contract-identical; NOT database evidence) ────────────

/**
 * The double keeps MUTABLE state, so it does not extend the readonly record: the
 * domain interface describes what the API returns (immutable snapshots), while a
 * store has to evolve the row. Keeping them separate is what stops a future
 * caller from "just setting" a field on a value the API handed out.
 */
/** The double's ordering key, identical to the SQL's `ORDER BY last_message_at DESC, id DESC`. */
function sortedByRecency(tickets: MemoryTicket[]): MemoryTicket[] {
  return [...tickets].sort((a, b) =>
    a.lastMessageAt === b.lastMessageAt ? Number(b.id) - Number(a.id) : (a.lastMessageAt < b.lastMessageAt ? 1 : -1),
  );
}

/** A snapshot: the double must never hand out a reference into its own state. */
function copyTicket(t: MemoryTicket): SupportTicketRecord {
  const { messages: _messages, ...record } = t;
  return { ...record };
}

interface MemoryTicket {
  id: string;
  userId: string;
  subject: string;
  status: SupportStatus;
  waitingFor: SupportWaiting;
  priority: SupportPriority | null;
  assignedAdminId: string | null;
  firstReplyAt: string | null;
  lastMessageAt: string;
  unreadAdminCount: number;
  unreadUserCount: number;
  createdAt: string;
  messages: SupportMessageRecord[];
}

export class MemorySupportStore implements SupportStore {
  #seq = 1;
  #messageSeq = 1;
  /** Monotonic stamp source. The DB's ordering key is a TIMESTAMPTZ; the double
   *  needs the same "later visible event sorts later" property without a wall
   *  clock, so it derives the stamp from a counter. */
  #clock = 1;

  #stamp(): string {
    this.#clock += 1;
    return new Date(this.#clock * 1000).toISOString();
  }
  readonly #tickets = new Map<string, MemoryTicket>();

  async createTicket(userId: string, subject: string, body: string): Promise<{ id: string }> {
    const id = String(this.#seq++);
    const ticket: MemoryTicket = {
      id,
      userId,
      subject,
      status: "open",
      waitingFor: "admin",
      priority: null,
      assignedAdminId: null,
      firstReplyAt: null,
      lastMessageAt: this.#stamp(),
      unreadAdminCount: 1,
      unreadUserCount: 0,
      createdAt: new Date(0).toISOString(),
      messages: [
        {
          id: String(this.#messageSeq++),
          senderType: "user",
          senderUserId: userId,
          body,
          messageType: "text",
          createdAt: new Date(0).toISOString(),
        },
      ],
    };
    this.#tickets.set(id, ticket);
    return { id };
  }

  async listUserTickets(userId: string, filters: { status?: SupportStatus; offset: number; limit: number }): Promise<{ tickets: SupportTicketRecord[]; total: number }> {
    const all = sortedByRecency(
      [...this.#tickets.values()].filter((t) => t.userId === userId && (filters.status === undefined || t.status === filters.status)),
    );
    return { tickets: all.slice(filters.offset, filters.offset + filters.limit).map(copyTicket), total: all.length };
  }

  async conversationForUser(userId: string, ticketId: string): Promise<SupportTicketRecord | null> {
    const t = this.#tickets.get(ticketId);
    return t !== undefined && t.userId === userId ? copyTicket(t) : null;
  }

  async conversation(ticketId: string): Promise<SupportTicketRecord | null> {
    const t = this.#tickets.get(ticketId);
    return t === undefined ? null : copyTicket(t);
  }

  async messages(ticketId: string, includeInternal: boolean, limit: number): Promise<SupportMessageRecord[]> {
    const t = this.#tickets.get(ticketId);
    if (t === undefined) return [];
    return t.messages.filter((m) => includeInternal || m.messageType === "text").slice(0, limit);
  }

  async appendMessage(input: {
    ticketId: string;
    senderType: "user" | "admin" | "system";
    senderId: string | null;
    body: string;
    messageType: MessageType;
    requireLive: boolean;
  }): Promise<{ messageId: string; status: SupportStatus; waitingFor: SupportWaiting; firstReplyNow: boolean } | null> {
    const t = this.#tickets.get(input.ticketId);
    if (t === undefined) return null;
    if (input.requireLive && t.status !== "open" && t.status !== "pending") return null;
    const isText = input.messageType === "text";
    const firstReplyNow = input.senderType === "admin" && isText && t.firstReplyAt === null;
    if (input.senderType === "user") {
      t.status = "open";
      t.waitingFor = "admin";
      t.unreadUserCount = 0;
      t.unreadAdminCount += 1;
    } else if (input.senderType === "admin" && isText) {
      t.status = "pending";
      t.waitingFor = "user";
      t.unreadAdminCount = 0;
      t.unreadUserCount += 1;
      if (firstReplyNow) t.firstReplyAt = new Date(0).toISOString();
    }
    if (isText) t.lastMessageAt = this.#stamp();
    const id = String(this.#messageSeq++);
    t.messages.push({
      id,
      senderType: input.senderType,
      senderUserId: input.senderId,
      body: input.body,
      messageType: input.messageType,
      createdAt: new Date(0).toISOString(),
    });
    return { messageId: id, status: t.status, waitingFor: t.waitingFor, firstReplyNow };
  }

  async transition(ticketId: string, from: SupportStatus[], to: { status: SupportStatus; waitingFor: SupportWaiting }): Promise<boolean> {
    const t = this.#tickets.get(ticketId);
    if (t === undefined || !from.includes(t.status)) return false;
    t.status = to.status;
    t.waitingFor = to.waitingFor;
    return true;
  }

  async markUserRead(userId: string, ticketId: string): Promise<boolean> {
    const t = this.#tickets.get(ticketId);
    if (t === undefined || t.userId !== userId) return false;
    t.unreadUserCount = 0;
    return true;
  }

  async markAdminRead(ticketId: string): Promise<boolean> {
    const t = this.#tickets.get(ticketId);
    if (t === undefined) return false;
    t.unreadAdminCount = 0;
    return true;
  }

  async unreadForUser(userId: string): Promise<number> {
    return [...this.#tickets.values()]
      .filter((t) => t.userId === userId && t.status !== "archived")
      .reduce((sum, t) => sum + t.unreadUserCount, 0);
  }

  async adminList(filters: { status?: SupportStatus; waitingFor?: SupportWaiting; unread?: "admin" | "user"; q?: string; offset: number; limit: number }): Promise<{ tickets: SupportTicketRecord[]; total: number; counters: SupportCounters }> {
    const every = [...this.#tickets.values()];
    const all = sortedByRecency(
      every.filter((t) => {
        if (filters.status !== undefined && t.status !== filters.status) return false;
        if (filters.waitingFor !== undefined && t.waitingFor !== filters.waitingFor) return false;
        if (filters.unread === "admin" && t.unreadAdminCount === 0) return false;
        if (filters.unread === "user" && t.unreadUserCount === 0) return false;
        // Literal, case-insensitive substring — the same thing the SQL does after
        // escaping `%`/`_`, so a `%` in a search term matches a literal `%`.
        if (filters.q !== undefined && !t.subject.toLowerCase().includes(filters.q.toLowerCase())) return false;
        return true;
      }),
    );
    return {
      tickets: all.slice(filters.offset, filters.offset + filters.limit).map(copyTicket),
      total: all.length,
      // The queue counters describe the QUEUE, not the current filter — they are
      // computed over every ticket, exactly as the SQL aggregate does.
      counters: {
        open: every.filter((t) => t.status === "open").length,
        pending: every.filter((t) => t.status === "pending").length,
        unread: every.reduce((sum, t) => sum + t.unreadAdminCount, 0),
      },
    };
  }

  async assign(ticketId: string, adminUserId: string | null): Promise<boolean> {
    const t = this.#tickets.get(ticketId);
    if (t === undefined) return false;
    t.assignedAdminId = adminUserId;
    return true;
  }
}
