// Admin — v1.0 "RBAC admin panel" (read surface).
//
//   GET /api/v1/admin/audit-logs   the append-only audit trail (Phase 6: filtered read)
//   GET /api/v1/admin/metrics      platform KPIs
//
// PHASE 6 SHARING RULE. The audit trail and the platform KPIs stayed HERE rather
// than moving into the Phase 6 console module, because there must be exactly one
// implementation of "read the trail": the console's Audit and user-detail views
// call this same endpoint with `?targetUserId=` / `?actorUserId=` / `?action=`
// instead of re-reading `audit_log` through a second port. What Phase 6 added
// here is filters (all narrowing, all optional) plus the joined actor/target
// e-mail addresses, so a trail row is readable without a second round trip.
//
// AUTHORIZATION: `admin.panel.access` — the EXISTING contract permission whose
// documented purpose is "read-only administrative visibility that the panel
// entry point requires". No new permission is invented, and the check runs
// through `canAct`, so the System Owner is covered by the same mechanism as an
// `admin` rather than by a special case in the route.
//
// WHAT IS NOT HERE: no write surface. Legacy's admin controllers can suspend
// users, change roles and edit trade content; those operations already exist in
// this codebase as the Phase C user-management routes (`AdminUserService`) plus
// the ownership routes, backed by `audit_log`. Duplicating them under a second
// path would create two ways to change a role — the exact drift the migration
// is meant to prevent.
//
// THE AUDIT TRAIL IS READ, NEVER WRITTEN, HERE. `audit_log.action` is a CLOSED
// vocabulary (0009/0011) covering ownership, roles, status and credentials.
// Billing, AI-consent and developer-key events are NOT in that vocabulary, and
// widening a CHECK constraint would be a schema change. This pass therefore
// does not attempt to write them; the finding is recorded for the Owner instead
// of being resolved silently.
import { fail, ok } from "@velora/contracts";
import { canAct } from "@velora/contracts";
import type { QueryFn } from "../persistence/pg.js";
import { capabilityAbsent, forbidden, unauthenticated } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

export const AUDIT_LOGS = "/api/v1/admin/audit-logs";
export const METRICS = "/api/v1/admin/metrics";

export interface AuditEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly actorUserId: string;
  readonly targetUserId: string | null;
  readonly outcome: string;
  readonly requestId: string | null;
  /**
   * Phase 6 (additive): the LOW-CARDINALITY before/after values of a lifecycle
   * action (`user` → `admin`, `active` → `suspended`, `live:2` → `live:0`), or
   * null where the action has no prior state. The console shows them beside the
   * action name: "role changed" is far less useful to an operator than "role
   * changed user → admin".
   */
  readonly beforeState?: string | null;
  readonly afterState?: string | null;
  /**
   * Phase 6 (additive): the e-mail addresses behind actorUserId/targetUserId.
   *
   * WHY: an operator reading the trail sees "actor 7 changed target 9's role" and
   * has no way to know who those are without a second lookup per row. The join is
   * free once the trail is read by filter rather than by id, and it removes the
   * console's need to page the user list per entry. `null` when the account has
   * since been deleted (the trail outlives the account it names — that is the
   * point of ON DELETE RESTRICT on actor_user_id and the LEFT JOIN here).
   */
  readonly actorEmail?: string | null;
  readonly targetEmail?: string | null;
}

export interface PlatformMetrics {
  readonly users: number;
  readonly activeUsers: number;
  readonly tradingAccounts: number;
  readonly connectedAccounts: number;
  readonly trades: number;
  readonly openTrades: number;
  readonly paidSubscriptions: number;
}

/**
 * Audit-trail read filters (Phase 6, additive).
 *
 * Every field is optional and every field NARROWS: an absent field means "any".
 * The time window is half-open [since, until) on occurred_at, matching the
 * console's analytics windows — consecutive windows then partition the trail with
 * no boundary row counted twice.
 */
export interface AuditLogFilter {
  readonly action?: string;
  readonly actorUserId?: string;
  readonly targetUserId?: string;
  /** Keyset pagination: only rows with id < before. */
  readonly before?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit: number;
}

export interface AdminStore {
  /** The audit trail, filtered. Returns the page AND the total matching count so
   *  a caller can say "12 of 340" instead of presenting a truncated list as the
   *  whole truth. */
  auditLog(filter: AuditLogFilter): Promise<{ items: readonly AuditEntry[]; total: number }>;
  metrics(): Promise<PlatformMetrics>;
}

type Row = Record<string, unknown>;

export class PgAdminStore implements AdminStore {
  constructor(private readonly q: QueryFn) {}

  async auditLog(filter: AuditLogFilter): Promise<{ items: readonly AuditEntry[]; total: number }> {
    // Built from ONE parameter list so the page query and its count can never
    // apply different predicates — a filter that narrowed the rows but not the
    // total is how "12 of 340" becomes a lie.
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.action !== undefined) {
      params.push(filter.action);
      where.push(`a.action = $${params.length}`);
    }
    if (filter.actorUserId !== undefined) {
      params.push(filter.actorUserId);
      where.push(`a.actor_user_id = $${params.length}::bigint`);
    }
    if (filter.targetUserId !== undefined) {
      params.push(filter.targetUserId);
      where.push(`a.target_user_id = $${params.length}::bigint`);
    }
    if (filter.before !== undefined) {
      params.push(filter.before);
      where.push(`a.id < $${params.length}::bigint`);
    }
    if (filter.since !== undefined) {
      params.push(filter.since);
      where.push(`a.occurred_at >= $${params.length}`);
    }
    if (filter.until !== undefined) {
      params.push(filter.until);
      where.push(`a.occurred_at < $${params.length}`);
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const pageParams = [...params, filter.limit];
    const rows = await this.q(
      `SELECT a.id::text AS id, a.occurred_at, a.action, a.actor_user_id::text AS actor_user_id,
              a.target_user_id::text AS target_user_id, a.outcome, a.request_id,
              a.before_state, a.after_state,
              actor.email AS actor_email, target.email AS target_email
         FROM audit_log a
         LEFT JOIN users actor  ON actor.id  = a.actor_user_id
         LEFT JOIN users target ON target.id = a.target_user_id
         ${clause}
        ORDER BY a.id DESC
        LIMIT $${pageParams.length}`,
      pageParams,
    );
    const counted = await this.q(
      `SELECT count(*)::int AS n FROM audit_log a ${clause}`,
      params,
    );
    return {
      items: rows.map((row: Row) => ({
        id: String(row["id"]),
        occurredAt: row["occurred_at"] instanceof Date ? (row["occurred_at"] as Date).toISOString() : String(row["occurred_at"]),
        action: String(row["action"]),
        actorUserId: String(row["actor_user_id"]),
        targetUserId: row["target_user_id"] === null ? null : String(row["target_user_id"]),
        outcome: String(row["outcome"]),
        requestId: row["request_id"] === null ? null : String(row["request_id"]),
        beforeState: row["before_state"] === null || row["before_state"] === undefined ? null : String(row["before_state"]),
        afterState: row["after_state"] === null || row["after_state"] === undefined ? null : String(row["after_state"]),
        actorEmail: row["actor_email"] === null || row["actor_email"] === undefined ? null : String(row["actor_email"]),
        targetEmail: row["target_email"] === null || row["target_email"] === undefined ? null : String(row["target_email"]),
      })),
      total: Number(counted[0]?.["n"] ?? 0),
    };
  }

  async metrics(): Promise<PlatformMetrics> {
    const rows = await this.q(
      `SELECT (SELECT count(*) FROM users)                                            AS users,
              (SELECT count(*) FROM users WHERE status = 'active')                   AS active_users,
              (SELECT count(*) FROM trading_accounts)                                AS trading_accounts,
              (SELECT count(*) FROM trading_accounts WHERE metaapi_account_id IS NOT NULL) AS connected_accounts,
              (SELECT count(*) FROM trades WHERE deleted_at IS NULL)                 AS trades,
              (SELECT count(*) FROM trades WHERE status = 'OPEN' AND deleted_at IS NULL) AS open_trades,
              (SELECT count(*) FROM subscriptions WHERE status IN ('active','trialing')) AS paid_subscriptions`,
      [],
    );
    const row = rows[0] ?? {};
    const n = (k: string): number => Number(row[k] ?? 0);
    return {
      users: n("users"),
      activeUsers: n("active_users"),
      tradingAccounts: n("trading_accounts"),
      connectedAccounts: n("connected_accounts"),
      trades: n("trades"),
      openTrades: n("open_trades"),
      paidSubscriptions: n("paid_subscriptions"),
    };
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryAdminStore implements AdminStore {
  constructor(
    private readonly entries: AuditEntry[] = [],
    private readonly counts: PlatformMetrics = {
      users: 0,
      activeUsers: 0,
      tradingAccounts: 0,
      connectedAccounts: 0,
      trades: 0,
      openTrades: 0,
      paidSubscriptions: 0,
    },
  ) {}

  async auditLog(filter: AuditLogFilter): Promise<{ items: readonly AuditEntry[]; total: number }> {
    // Contract-identical narrowing, and deliberately the SAME order as the pg
    // adapter: filter first, then page. (A double that paged first would let a
    // test pass a filter that never worked in production.)
    const matched = this.entries.filter((e) => {
      if (filter.action !== undefined && e.action !== filter.action) return false;
      if (filter.actorUserId !== undefined && e.actorUserId !== filter.actorUserId) return false;
      if (filter.targetUserId !== undefined && e.targetUserId !== filter.targetUserId) return false;
      if (filter.before !== undefined && !(BigInt(e.id) < BigInt(filter.before))) return false;
      if (filter.since !== undefined && e.occurredAt < filter.since.toISOString()) return false;
      if (filter.until !== undefined && e.occurredAt >= filter.until.toISOString()) return false;
      return true;
    });
    const sorted = [...matched].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
    return { items: sorted.slice(0, filter.limit), total: sorted.length };
  }

  async metrics(): Promise<PlatformMetrics> {
    return this.counts;
  }
}

const MAX_LIMIT = 200;

export async function handleAdminRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  if (ctx.path !== AUDIT_LOGS && ctx.path !== METRICS) return null;
  const store: AdminStore | null = ctx.config.admin ?? null;
  if (store === null) return capabilityAbsent(ctx, "admin");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  // Fail-closed authorization: the System Owner check is only consulted for an
  // authenticated caller, and an unknown role yields no permissions at all.
  const authority = { role: claims.role, isSystemOwner: await ctx.isSystemOwner(claims.sub) };
  if (!canAct(authority, "admin.panel.access")) return forbidden(ctx);

  if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };

  if (ctx.path === METRICS) {
    return { status: 200, body: ok(await store.metrics()) };
  }

  const q = ctx.url.searchParams;
  const rawLimit = q.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { limit: `1..${MAX_LIMIT}` }) };
  }
  // Phase 6 filters. Numeric ids are validated as such BEFORE they reach SQL so
  // a non-numeric value is a 400 rather than a cast error surfacing as a 500.
  const filter: AuditLogFilter = {
    ...(q.get("action") ? { action: q.get("action")! } : {}),
    ...(q.get("actorUserId") ? { actorUserId: q.get("actorUserId")! } : {}),
    ...(q.get("targetUserId") ? { targetUserId: q.get("targetUserId")! } : {}),
    ...(q.get("before") ? { before: q.get("before")! } : {}),
    limit,
  };
  for (const key of ["actorUserId", "targetUserId", "before"] as const) {
    const value = q.get(key);
    if (value !== null && !/^\d+$/.test(value)) {
      return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { [key]: "must be a numeric id" }) };
    }
  }
  for (const [key, bound] of [["since", "since"], ["until", "until"]] as const) {
    const raw = q.get(key);
    if (raw === null || raw.trim() === "") continue;
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) {
      return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { [key]: "must be an ISO-8601 instant" }) };
    }
    if (bound === "since") (filter as { since?: Date }).since = instant;
    else (filter as { until?: Date }).until = instant;
  }
  if (filter.since !== undefined && filter.until !== undefined && filter.since.getTime() >= filter.until.getTime()) {
    return { status: 422, body: fail("RANGE_INVALID", "The range start must precede its end.", ctx.requestId) };
  }
  const page = await store.auditLog(filter);
  return { status: 200, body: ok({ entries: page.items, total: page.total, limit }) };
}
