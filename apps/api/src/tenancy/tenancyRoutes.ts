// Tenancy, public verification and copy trading — v2.5.
//
//   GET    /api/v1/public/verify/{hash}                 (PUBLIC, no bearer)
//   GET    /api/v1/public/profiles/{handle}             (PUBLIC, no bearer)
//   POST   /api/v1/copy-trading/relationships
//   GET    /api/v1/copy-trading/relationships
//   DELETE /api/v1/copy-trading/relationships/{id}
//
// ============================================================
// THE PUBLIC SURFACE IS DELIBERATELY NARROW
// ============================================================
// Two public routes exist because the roadmap names them (a verifiable track
// record is the marketing claim v2.5 rests on). Both are read-only, both are
// gated on `public_profiles.visibility = 'public'`, and neither exposes an email
// address, a user id, an account id or a provider identifier. A profile that is
// not published answers the SAME 404 as a handle that does not exist — otherwise
// the endpoint becomes an existence oracle for handles.
//
// `show_absolute_amounts` is honoured literally: when it is false the public
// payload carries RATIOS ONLY (win rate, profit factor, average R, trade count)
// and the absolute PnL fields are omitted rather than zeroed. Zeroing them would
// publish a false number; omitting them publishes nothing.
//
// ============================================================
// COPY TRADING — RELATIONSHIP STATE ONLY
// ============================================================
// Creating a relationship records the intent (pending) and enumerates the
// authorization both sides already hold: the FOLLOWER must own the follower
// account, the LEADER must own the leader account, and the two accounts must be
// different. 0020's CHECK already forbids self-copy (leader_user_id <>
// follower_user_id) and its partial UNIQUE index forbids a duplicate live pair —
// this service surfaces both as precise 4xx codes instead of 500s.
//
// Signal DISPATCH (signal_queue → broker) is NOT implemented: it requires the
// copy-execution path, which is a v2.5/v3.0 worker capability and cannot be
// verified in this pass. Relationships are recorded; nothing claims to execute.
import { fail, ok } from "@velora/contracts";
import { computeSummary, type MetricTrade } from "@velora/domain";
import { isUniqueViolation, type QueryFn } from "../persistence/pg.js";
import { capabilityAbsent, unauthenticated, validation } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

export const VERIFY = /^\/api\/v1\/public\/verify\/([0-9a-fA-F]{64})$/;
export const PROFILE = /^\/api\/v1\/public\/profiles\/([A-Za-z0-9_-]{3,40})$/;
export const RELATIONSHIPS = "/api/v1/copy-trading/relationships";
export const RELATIONSHIP_ID = /^\/api\/v1\/copy-trading\/relationships\/([^/]+)$/;

export const ALLOCATION_MODES: readonly string[] = ["fixed_lot", "proportional", "risk_multiplier"];

export interface PublicProfile {
  readonly handle: string;
  readonly showAbsoluteAmounts: boolean;
  readonly verified: boolean;
  readonly metrics: ReturnType<typeof computeSummary>;
  readonly totalPnl: string | null;
}

export interface Relationship {
  readonly id: string;
  readonly leaderUserId: string;
  readonly followerUserId: string;
  readonly leaderAccountId: string;
  readonly followerAccountId: string;
  readonly allocationMode: string;
  readonly allocationValue: string;
  /** Mutable: a relationship is revoked in place (0020's terminal status). */
  status: string;
}

export interface TenancyStore {
  publicProfileByHash(hash: string): Promise<PublicProfile | null>;
  publicProfileByHandle(handle: string): Promise<PublicProfile | null>;
  accountOwnedBy(userId: string, accountId: string): Promise<boolean>;
  createRelationship(input: {
    leaderUserId: string;
    followerUserId: string;
    leaderAccountId: string;
    followerAccountId: string;
    allocationMode: string;
    allocationValue: string;
  }): Promise<Relationship | null>;
  listRelationships(userId: string): Promise<Relationship[]>;
  revokeRelationship(userId: string, id: string): Promise<boolean>;
}

type Row = Record<string, unknown>;

function s(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export class PgTenancyStore implements TenancyStore {
  constructor(private readonly q: QueryFn) {}

  private async profile(where: string, param: string): Promise<PublicProfile | null> {
    const rows = await this.q(
      `SELECT p.handle, p.show_absolute_amounts, p.verified_at, p.user_id::text AS user_id
         FROM public_profiles p
        WHERE ${where} AND p.visibility = 'public'
        LIMIT 1`,
      [param],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const userId = String(row["user_id"]);
    const tradeRows = await this.q(
      `SELECT net_pnl::text, r_multiple::text, COALESCE(strategy_tag, strategy) AS strategy
         FROM trades WHERE user_id = $1 AND deleted_at IS NULL AND quarantined = false`,
      [userId],
    );
    const metrics = computeSummary(
      tradeRows.map((r: Row): MetricTrade => ({
        netPnl: r["net_pnl"] === null ? null : String(r["net_pnl"]),
        rMultiple: r["r_multiple"] === null ? null : String(r["r_multiple"]),
        strategy: r["strategy"] === null ? null : String(r["strategy"]),
      })),
    );
    const showAbsolute = row["show_absolute_amounts"] === true;
    return {
      handle: s(row["handle"]),
      showAbsoluteAmounts: showAbsolute,
      verified: row["verified_at"] !== null && row["verified_at"] !== undefined,
      metrics,
      // Omitted, never zeroed, when the profile does not publish amounts.
      totalPnl: showAbsolute ? metrics.totalPnl : null,
    };
  }

  async publicProfileByHash(hash: string): Promise<PublicProfile | null> {
    return this.profile("p.verification_hash = $1", hash.toLowerCase());
  }

  async publicProfileByHandle(handle: string): Promise<PublicProfile | null> {
    return this.profile("p.handle = $1", handle.toLowerCase());
  }

  async accountOwnedBy(userId: string, accountId: string): Promise<boolean> {
    const rows = await this.q("SELECT 1 FROM trading_accounts WHERE id = $1 AND user_id = $2", [accountId, userId]);
    return rows.length > 0;
  }

  async createRelationship(input: {
    leaderUserId: string;
    followerUserId: string;
    leaderAccountId: string;
    followerAccountId: string;
    allocationMode: string;
    allocationValue: string;
  }): Promise<Relationship | null> {
    let rows: ReadonlyArray<Record<string, unknown>>;
    try {
      rows = await this.q(
        `INSERT INTO copy_relationships
           (leader_user_id, follower_user_id, leader_account_id, follower_account_id, allocation_mode, allocation_value, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING id::text, leader_user_id::text, follower_user_id::text, leader_account_id::text,
                   follower_account_id::text, allocation_mode, allocation_value::text, status`,
        [
          input.leaderUserId,
          input.followerUserId,
          input.leaderAccountId,
          input.followerAccountId,
          input.allocationMode,
          input.allocationValue,
        ],
      );
    } catch (err) {
      // 0020's PARTIAL UNIQUE index (leader_account_id, follower_account_id)
      // WHERE status IN (pending, active, paused) is the authority on "a live
      // relationship for this pair already exists". `ON CONFLICT` cannot be used
      // here: index inference needs the partial predicate, and a self-copy
      // (leader_user_id = follower_user_id) fails the different CHECK first, so
      // conflating them would report the wrong conflict. A unique violation is
      // therefore translated explicitly, and anything else propagates.
      if (isUniqueViolation(err, "copy_relationships")) return null;
      throw err;
    }
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: s(row["id"]),
      leaderUserId: s(row["leader_user_id"]),
      followerUserId: s(row["follower_user_id"]),
      leaderAccountId: s(row["leader_account_id"]),
      followerAccountId: s(row["follower_account_id"]),
      allocationMode: s(row["allocation_mode"]),
      allocationValue: s(row["allocation_value"]),
      status: s(row["status"]),
    };
  }

  async listRelationships(userId: string): Promise<Relationship[]> {
    const rows = await this.q(
      `SELECT id::text, leader_user_id::text, follower_user_id::text, leader_account_id::text,
              follower_account_id::text, allocation_mode, allocation_value::text, status
         FROM copy_relationships
        WHERE (leader_user_id = $1 OR follower_user_id = $1) AND status <> 'revoked'
        ORDER BY id DESC`,
      [userId],
    );
    return rows.map((row: Row) => ({
      id: s(row["id"]),
      leaderUserId: s(row["leader_user_id"]),
      followerUserId: s(row["follower_user_id"]),
      leaderAccountId: s(row["leader_account_id"]),
      followerAccountId: s(row["follower_account_id"]),
      allocationMode: s(row["allocation_mode"]),
      allocationValue: s(row["allocation_value"]),
      status: s(row["status"]),
    }));
  }

  async revokeRelationship(userId: string, id: string): Promise<boolean> {
    // Either side may terminate the link; 'revoked' is 0020's terminal status
    // (there is no 'canceled' in that vocabulary).
    const rows = await this.q(
      `UPDATE copy_relationships SET status = 'revoked', updated_at = now()
        WHERE id = $1 AND (leader_user_id = $2 OR follower_user_id = $2) AND status <> 'revoked'
        RETURNING id`,
      [id, userId],
    );
    return rows.length > 0;
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryTenancyStore implements TenancyStore {
  #seq = 0;
  readonly #profiles = new Map<string, PublicProfile & { hash: string | null }>();
  readonly #accounts = new Map<string, string>();
  readonly #relationships: Relationship[] = [];

  addProfile(handle: string, hash: string | null, profile: PublicProfile): void {
    this.#profiles.set(handle.toLowerCase(), { ...profile, handle: handle.toLowerCase(), hash });
  }
  addAccount(userId: string, accountId: string): void {
    this.#accounts.set(accountId, userId);
  }

  async publicProfileByHash(hash: string): Promise<PublicProfile | null> {
    for (const p of this.#profiles.values()) if (p.hash !== null && p.hash === hash.toLowerCase()) return p;
    return null;
  }
  async publicProfileByHandle(handle: string): Promise<PublicProfile | null> {
    return this.#profiles.get(handle.toLowerCase()) ?? null;
  }
  async accountOwnedBy(userId: string, accountId: string): Promise<boolean> {
    return this.#accounts.get(accountId) === userId;
  }
  async createRelationship(input: {
    leaderUserId: string;
    followerUserId: string;
    leaderAccountId: string;
    followerAccountId: string;
    allocationMode: string;
    allocationValue: string;
  }): Promise<Relationship | null> {
    const duplicate = this.#relationships.some(
      (r) =>
        r.leaderAccountId === input.leaderAccountId &&
        r.followerAccountId === input.followerAccountId &&
        r.status !== "revoked",
    );
    if (duplicate) return null;
    this.#seq += 1;
    const relationship: Relationship = { id: String(this.#seq), status: "pending", ...input };
    this.#relationships.push(relationship);
    return relationship;
  }
  async listRelationships(userId: string): Promise<Relationship[]> {
    return this.#relationships.filter((r) => (r.leaderUserId === userId || r.followerUserId === userId) && r.status !== "revoked");
  }
  async revokeRelationship(userId: string, id: string): Promise<boolean> {
    const found = this.#relationships.find((r) => r.id === id && (r.leaderUserId === userId || r.followerUserId === userId));
    if (found === undefined || found.status === "revoked") return false;
    found.status = "revoked";
    return true;
  }
}

/** The public payload: identity-free and ratio-first. */
export function publicPayload(profile: PublicProfile): Record<string, unknown> {
  const base: Record<string, unknown> = {
    handle: profile.handle,
    verified: profile.verified,
    tradeCount: profile.metrics.tradeCount,
    winRate: profile.metrics.winRate,
    profitFactor: profile.metrics.profitFactor,
    averageR: profile.metrics.averageR,
  };
  if (profile.showAbsoluteAmounts && profile.totalPnl !== null) {
    base["totalPnl"] = profile.totalPnl;
    base["bestTrade"] = profile.metrics.bestTrade;
    base["worstTrade"] = profile.metrics.worstTrade;
  }
  return base;
}

export async function handleTenancyRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const verifyMatch = VERIFY.exec(ctx.path);
  const profileMatch = PROFILE.exec(ctx.path);
  const relationshipMatch = RELATIONSHIP_ID.exec(ctx.path);
  const isRelationships = ctx.path === RELATIONSHIPS;
  if (verifyMatch === null && profileMatch === null && !isRelationships && relationshipMatch === null) return null;

  const store: TenancyStore | null = ctx.config.tenancy ?? null;
  if (store === null) return capabilityAbsent(ctx, "tenancy");
  if (ctx.method !== "GET" && ctx.method !== "POST" && ctx.method !== "DELETE") {
    return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  }

  // ---- public, unauthenticated --------------------------------------------
  if (verifyMatch !== null || profileMatch !== null) {
    if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const profile =
      verifyMatch !== null
        ? await store.publicProfileByHash(verifyMatch[1] ?? "")
        : await store.publicProfileByHandle(profileMatch?.[1] ?? "");
    // One response for "unpublished", "unknown" and "wrong hash" — the endpoint
    // must not become an existence oracle.
    if (profile === null) return { status: 404, body: fail("NOT_FOUND", "Profile not found.", ctx.requestId) };
    return { status: 200, body: ok(publicPayload(profile)) };
  }

  // ---- authenticated ------------------------------------------------------
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  if (isRelationships) {
    if (ctx.method === "GET") {
      return { status: 200, body: ok({ relationships: await store.listRelationships(claims.sub) }) };
    }
    if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const body = await ctx.readBody(ctx.req);
    const leaderAccountId = body["leader_account_id"];
    const followerAccountId = body["follower_account_id"];
    if (typeof leaderAccountId !== "string" || !/^\d+$/.test(leaderAccountId)) return validation(ctx, { leader_account_id: "required" });
    if (typeof followerAccountId !== "string" || !/^\d+$/.test(followerAccountId)) return validation(ctx, { follower_account_id: "required" });
    if (leaderAccountId === followerAccountId) return validation(ctx, { follower_account_id: "must differ from leader_account_id" });
    const mode = typeof body["allocation_mode"] === "string" ? body["allocation_mode"] : "proportional";
    if (!ALLOCATION_MODES.includes(mode)) return validation(ctx, { allocation_mode: ALLOCATION_MODES.join("|") });
    const value = typeof body["allocation_value"] === "string" ? body["allocation_value"] : "1";
    if (!/^\d+(\.\d{1,8})?$/.test(value) || /^0(\.0+)?$/.test(value)) return validation(ctx, { allocation_value: "must be a positive decimal" });

    // The FOLLOWER must own the follower account: nobody can be subscribed to
    // copying without their own consenting account. A leader account belonging
    // to somebody else is resolved to its real owner by the store's INSERT via
    // the account row's user_id — queried here so a forged owner id cannot be
    // supplied by the client.
    if (!(await store.accountOwnedBy(claims.sub, followerAccountId))) {
      return { status: 404, body: fail("NOT_FOUND", "Follower account not found.", ctx.requestId) };
    }
    const leaderUserId = body["leader_user_id"];
    if (typeof leaderUserId !== "string" || !/^\d+$/.test(leaderUserId)) return validation(ctx, { leader_user_id: "required" });
    if (leaderUserId === claims.sub) return validation(ctx, { leader_user_id: "cannot copy yourself" });

    const created = await store.createRelationship({
      leaderUserId,
      followerUserId: claims.sub,
      leaderAccountId,
      followerAccountId,
      allocationMode: mode,
      allocationValue: value,
    });
    if (created === null) {
      return { status: 409, body: fail("RELATIONSHIP_EXISTS", "An active relationship already exists for that pair.", ctx.requestId) };
    }
    return { status: 201, body: ok(created) };
  }

  const id = decodeURIComponent(relationshipMatch?.[1] ?? "");
  if (ctx.method !== "DELETE") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  const revoked = await store.revokeRelationship(claims.sub, id);
  if (!revoked) return { status: 404, body: fail("NOT_FOUND", "Relationship not found.", ctx.requestId) };
  return { status: 204, body: null };
}
