// Support routes — Phase 5. Legacy surface, migrated by capability:
//
//   USER (Legacy `api/index.php` 198-203, identical shapes)
//     POST /api/v1/support/tickets                  {subject, message}   -> 201 {ticket:{id}}
//     GET  /api/v1/support/tickets?status=&page=                        -> 200 {tickets,total,page,perPage,unreadTotal}
//     GET  /api/v1/support/tickets/{id}                                 -> 200 {conversation,messages}
//     POST /api/v1/support/tickets/{id}/messages    {message}           -> 200 {message:{id,status,waitingFor}}
//     POST /api/v1/support/tickets/{id}/read                            -> 200 {ok:true,unreadTotal}
//     POST /api/v1/support/tickets/{id}/reopen                          -> 200 {status,waitingFor}
//
//   SUPPORT/admin (Legacy 206-209, permission-gated)
//     GET  /api/v1/admin/communications/tickets                         -> 200 {tickets,total,page,perPage,counters}
//     GET  /api/v1/admin/communications/tickets/{id}                    -> 200 {conversation,messages}
//     POST /api/v1/admin/communications/tickets/{id}/messages {message, internal?} -> 200 {message:{…,firstReply}}
//     POST /api/v1/admin/communications/tickets/{id}/status  {action}   -> 200 {status,waitingFor}
//
// DELIBERATELY NOT WIRED (phase 7 owns them): `/translate` and `/copilot`, which
// call an AI provider. They will land with the AI capability's consent gate,
// provider abstraction and fail-closed error states — never as a stub that
// quietly returns empty text.
//
// AUTHORIZATION. User routes are ownership-scoped by `claims.sub`; a foreign
// ticket is a single non-disclosing 404. The support routes require the
// capability `support.tickets.view` / `support.tickets.manage` (Legacy:
// `communication.view` / `communication.reply`, granted to BOTH `admin` and
// `super_admin` — verified in api/src/Auth/Role.php lines 107-108 and 130-131).
import { fail, ok } from "@velora/contracts";
import { canAct } from "@velora/contracts";
import { SupportError, type SupportService } from "./supportService.js";
import { capabilityAbsent, forbidden, notFound, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

const USER_COLLECTION = "/api/v1/support/tickets";
const USER_TICKET = /^\/api\/v1\/support\/tickets\/([^/]+)$/;
const USER_MESSAGES = /^\/api\/v1\/support\/tickets\/([^/]+)\/messages$/;
const USER_READ = /^\/api\/v1\/support\/tickets\/([^/]+)\/read$/;
const USER_REOPEN = /^\/api\/v1\/support\/tickets\/([^/]+)\/reopen$/;

const ADMIN_COLLECTION = "/api/v1/admin/communications/tickets";
const ADMIN_TICKET = /^\/api\/v1\/admin\/communications\/tickets\/([^/]+)$/;
const ADMIN_MESSAGES = /^\/api\/v1\/admin\/communications\/tickets\/([^/]+)\/messages$/;
const ADMIN_STATUS = /^\/api\/v1\/admin\/communications\/tickets\/([^/]+)\/status$/;

const MAX_PAGE = 1000;

function supportError(ctx: ExtendedRouteContext, err: SupportError): RouteResult {
  return { status: err.status, body: fail(err.code, err.message, ctx.requestId) };
}

function pageOf(ctx: ExtendedRouteContext): number | { error: RouteResult } {
  const raw = ctx.url.searchParams.get("page");
  if (raw === null) return 1;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    return { error: { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { page: `1..${MAX_PAGE}` }) } };
  }
  return page;
}

async function readJsonObject(ctx: ExtendedRouteContext): Promise<Record<string, unknown>> {
  const body = (await ctx.readBody(ctx.req)) as unknown;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

export async function handleSupportRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const isUserRoute =
    ctx.path === USER_COLLECTION ||
    USER_TICKET.test(ctx.path) ||
    USER_MESSAGES.test(ctx.path) ||
    USER_READ.test(ctx.path) ||
    USER_REOPEN.test(ctx.path);
  const isAdminRoute =
    ctx.path === ADMIN_COLLECTION ||
    ADMIN_TICKET.test(ctx.path) ||
    ADMIN_MESSAGES.test(ctx.path) ||
    ADMIN_STATUS.test(ctx.path);
  if (!isUserRoute && !isAdminRoute) return null;

  const service: SupportService | null = ctx.config.support ?? null;
  if (service === null) return capabilityAbsent(ctx, "support");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  try {
    if (isUserRoute) {
      const userId = claims.sub;

      if (ctx.path === USER_COLLECTION) {
        if (ctx.method === "GET") {
          const page = pageOf(ctx);
          if (typeof page === "object") return page.error;
          const status = ctx.url.searchParams.get("status") ?? undefined;
          return { status: 200, body: ok(await service.listUserTickets(userId, { ...(status === undefined ? {} : { status }), page })) };
        }
        if (ctx.method === "POST") {
          const body = await readJsonObject(ctx);
          const created = await service.createTicket(userId, { subject: body["subject"], message: body["message"] });
          return { status: 201, body: ok({ ticket: { id: created.id } }) };
        }
        return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
      }

      const ticketId = decodeURIComponent((USER_TICKET.exec(ctx.path) ?? USER_MESSAGES.exec(ctx.path) ?? USER_READ.exec(ctx.path) ?? USER_REOPEN.exec(ctx.path))?.[1] ?? "");

      if (USER_TICKET.test(ctx.path)) {
        if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
        return { status: 200, body: ok(await service.userTicket(userId, ticketId)) };
      }

      if (USER_MESSAGES.test(ctx.path)) {
        if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
        const body = await readJsonObject(ctx);
        const message = await service.userReply(userId, ticketId, body["message"]);
        return { status: 200, body: ok({ message }) };
      }

      if (USER_READ.test(ctx.path)) {
        if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
        // markRead is part of the read: a foreign ticket must not be revealed, so
        // the ownership check runs first (userTicket) and a miss is a 404.
        await service.userTicket(userId, ticketId, { markRead: true });
        const listed = await service.listUserTickets(userId, {});
        return { status: 200, body: ok({ ok: true, unreadTotal: listed.unreadTotal }) };
      }

      if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
      return { status: 200, body: ok(await service.userReopen(userId, ticketId)) };
    }

    // ── support/admin surface ────────────────────────────────────────────────
    // Fail-closed authorization (same pattern as the admin routes): the authority
    // check runs for an authenticated caller only, and an unknown role yields no
    // permissions at all.
    const authority = { role: claims.role, isSystemOwner: await ctx.isSystemOwner(claims.sub) };
    const writes = ADMIN_MESSAGES.test(ctx.path) || ADMIN_STATUS.test(ctx.path);
    const permission = writes ? "support.tickets.manage" : "support.tickets.view";
    if (!canAct(authority, permission)) return forbidden(ctx);

    if (ctx.path === ADMIN_COLLECTION) {
      if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
      const page = pageOf(ctx);
      if (typeof page === "object") return page.error;
      const params = ctx.url.searchParams;
      return {
        status: 200,
        body: ok(
          await service.listForSupport({
            ...(params.get("status") === null ? {} : { status: params.get("status") as string }),
            ...(params.get("waiting_for") === null ? {} : { waitingFor: params.get("waiting_for") as string }),
            ...(params.get("unread") === null ? {} : { unread: params.get("unread") as string }),
            ...(params.get("q") === null ? {} : { q: params.get("q") as string }),
            page,
          }),
        ),
      };
    }

    const adminTicketId = decodeURIComponent(
      (ADMIN_TICKET.exec(ctx.path) ?? ADMIN_MESSAGES.exec(ctx.path) ?? ADMIN_STATUS.exec(ctx.path))?.[1] ?? "",
    );

    if (ADMIN_TICKET.test(ctx.path)) {
      if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
      return { status: 200, body: ok(await service.supportTicket(adminTicketId)) };
    }

    if (ADMIN_MESSAGES.test(ctx.path)) {
      if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
      const body = await readJsonObject(ctx);
      // INTERNAL NOTES ARE A SUPER_ADMIN ACT, and a refused request is a refusal.
      // Legacy computed this as `!empty($body['internal']) && $me['role'] ===
      // SUPER_ADMIN`, i.e. an ADMIN asking for an internal note silently got a
      // USER-VISIBLE reply instead — the note's text was delivered to the customer.
      // Modern keeps the privilege (super_admin only) and makes the denial loud.
      const internal = body["internal"] === true;
      if (internal && claims.role !== "super_admin") return forbidden(ctx);
      const message = await service.supportReply(claims.sub, adminTicketId, body["message"], internal);
      return { status: 200, body: ok({ message }) };
    }

    if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const body = await readJsonObject(ctx);
    const action = typeof body["action"] === "string" ? body["action"] : "";
    return { status: 200, body: ok(await service.supportSetStatus(claims.sub, adminTicketId, action)) };
  } catch (err) {
    if (err instanceof SupportError) {
      if (err.status === 404) return notFound(ctx, err.message);
      return supportError(ctx, err);
    }
    throw err;
  }
}
