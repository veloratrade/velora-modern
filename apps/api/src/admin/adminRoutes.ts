// Admin — v1.0 "RBAC admin panel" (read surface).
//
//   GET /api/v1/admin/audit-logs   the append-only audit trail
//   GET /api/v1/admin/metrics      platform KPIs
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

export interface AdminStore {
  auditLog(limit: number, before: string | null): Promise<AuditEntry[]>;
  metrics(): Promise<PlatformMetrics>;
}

type Row = Record<string, unknown>;

export class PgAdminStore implements AdminStore {
  constructor(private readonly q: QueryFn) {}

  async auditLog(limit: number, before: string | null): Promise<AuditEntry[]> {
    const rows = await this.q(
      `SELECT id::text, occurred_at, action, actor_user_id::text, target_user_id::text, outcome, request_id
         FROM audit_log
        WHERE ($2::bigint IS NULL OR id < $2::bigint)
        ORDER BY id DESC
        LIMIT $1`,
      [limit, before],
    );
    return rows.map((row: Row) => ({
      id: String(row["id"]),
      occurredAt: row["occurred_at"] instanceof Date ? (row["occurred_at"] as Date).toISOString() : String(row["occurred_at"]),
      action: String(row["action"]),
      actorUserId: String(row["actor_user_id"]),
      targetUserId: row["target_user_id"] === null ? null : String(row["target_user_id"]),
      outcome: String(row["outcome"]),
      requestId: row["request_id"] === null ? null : String(row["request_id"]),
    }));
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

  async auditLog(limit: number, before: string | null): Promise<AuditEntry[]> {
    return this.entries.filter((e) => before === null || BigInt(e.id) < BigInt(before)).slice(0, limit);
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

  const rawLimit = ctx.url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { limit: `1..${MAX_LIMIT}` }) };
  }
  const before = ctx.url.searchParams.get("before");
  if (before !== null && !/^\d+$/.test(before)) {
    return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { before: "must be a numeric id" }) };
  }
  return { status: 200, body: ok({ entries: await store.auditLog(limit, before) }) };
}
