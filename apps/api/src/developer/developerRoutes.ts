// Developer API keys + ML predictions — v3.0 "Sovereign Trading OS".
//
//   POST   /api/v1/developer/keys          create a key (secret shown ONCE)
//   GET    /api/v1/developer/keys          list keys (never the secret)
//   DELETE /api/v1/developer/keys/{id}     revoke
//   GET    /api/v1/developer/predictions   stored model predictions
//
// ============================================================
// KEY HANDLING — GROUNDED IN 0021's CONTRACT
// ============================================================
// 0021 already fixes the storage shape and it is a good one, so it is used
// literally rather than approximated:
//   key_hash   ^[0-9a-f]{64}$            → SHA-256 of the secret (high-entropy
//                                          token: a KDF would only slow the
//                                          hot path with nothing to protect)
//   key_prefix ^[A-Za-z0-9]{6,12}$       → a non-secret display prefix
//   scopes     ⊆ {trades:read, trades:write, analytics:read, accounts:read}
//   rate_limit_per_min ∈ [1, 10000]      → the roadmap's 100 req/min default
// The secret is returned exactly once, at creation. It is never logged, never
// echoed by a read path, and never recoverable — a lost key is replaced.
//
// ============================================================
// WHAT IS NOT CLAIMED
// ============================================================
// Authentication BY a developer key on the data routes is NOT wired: the
// roadmap requires scoped OAuth2-style tokens and a per-key rate limit, and
// this pass implements the key LIFECYCLE (create/list/revoke) plus the
// predictions read. A key that exists but cannot yet authenticate a request is
// reported as PARTIALLY_IMPLEMENTED rather than presented as a working API.
// The roadmap's `/ws/v1/voice-copilot` is likewise NOT implemented: this kernel
// has no WebSocket upgrade path, and adding one is an architecture decision
// (ADR-level), not a migration detail — reported as BLOCKED/deferred.
//
// ML PREDICTIONS are a READ of a table a Python microservice writes; the
// microservice itself is out of scope for this backend pass and is reported as
// such. No prediction is ever computed here.
import { fail, ok } from "@velora/contracts";
import { createHash, randomBytes } from "node:crypto";
import type { QueryFn } from "../persistence/pg.js";
import { capabilityAbsent, unauthenticated, validation } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

export const KEYS = "/api/v1/developer/keys";
export const KEY_ID = /^\/api\/v1\/developer\/keys\/([^/]+)$/;
export const PREDICTIONS = "/api/v1/developer/predictions";

/** 0021's scope vocabulary, verbatim. */
export const SCOPES: readonly string[] = ["trades:read", "trades:write", "analytics:read", "accounts:read"];
export const DEFAULT_RATE_LIMIT = 100;
export const MAX_RATE_LIMIT = 10_000;

export interface DeveloperKey {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly scopes: string[];
  readonly rateLimitPerMin: number;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface Prediction {
  readonly id: string;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly tradeId: string | null;
  readonly probability: string | null;
  readonly prediction: Record<string, unknown>;
  readonly createdAt: string;
}

export interface DeveloperStore {
  listKeys(userId: string): Promise<DeveloperKey[]>;
  createKey(input: {
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    rateLimitPerMin: number;
  }): Promise<DeveloperKey>;
  revokeKey(userId: string, id: string): Promise<boolean>;
  listPredictions(userId: string, limit: number): Promise<Prediction[]>;
}

type Row = Record<string, unknown>;

function s(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? (v as Date).toISOString() : String(v);
}

function mapKey(row: Row): DeveloperKey {
  return {
    id: s(row["id"]),
    name: s(row["name"]),
    keyPrefix: s(row["key_prefix"]),
    // pg returns text[] as a JS array; a non-array is coerced to [] rather than
    // assumed, so a malformed row cannot inflate a caller's apparent scopes.
    scopes: Array.isArray(row["scopes"]) ? (row["scopes"] as unknown[]).map(String) : [],
    rateLimitPerMin: Number(row["rate_limit_per_min"] ?? DEFAULT_RATE_LIMIT),
    lastUsedAt: isoOrNull(row["last_used_at"]),
    createdAt: s(row["created_at"]),
  };
}

export class PgDeveloperStore implements DeveloperStore {
  constructor(private readonly q: QueryFn) {}

  async listKeys(userId: string): Promise<DeveloperKey[]> {
    const rows = await this.q(
      `SELECT id::text, name, key_prefix, scopes, rate_limit_per_min, last_used_at, created_at
         FROM developer_api_keys
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    return rows.map(mapKey);
  }

  async createKey(input: {
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    rateLimitPerMin: number;
  }): Promise<DeveloperKey> {
    const rows = await this.q(
      `INSERT INTO developer_api_keys (user_id, name, key_prefix, key_hash, scopes, rate_limit_per_min)
       VALUES ($1, $2, $3, $4, $5::text[], $6)
       RETURNING id::text, name, key_prefix, scopes, rate_limit_per_min, last_used_at, created_at`,
      [input.userId, input.name, input.keyPrefix, input.keyHash, input.scopes, input.rateLimitPerMin],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("key creation returned no row");
    return mapKey(row);
  }

  async revokeKey(userId: string, id: string): Promise<boolean> {
    const rows = await this.q(
      "UPDATE developer_api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
      [id, userId],
    );
    return rows.length > 0;
  }

  async listPredictions(userId: string, limit: number): Promise<Prediction[]> {
    const rows = await this.q(
      `SELECT id::text, model_name, model_version, trade_id::text, probability::text, prediction, created_at
         FROM ml_model_predictions
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, limit],
    );
    return rows.map((row: Row) => ({
      id: s(row["id"]),
      modelName: s(row["model_name"]),
      modelVersion: s(row["model_version"]),
      tradeId: row["trade_id"] === null ? null : s(row["trade_id"]),
      probability: row["probability"] === null ? null : s(row["probability"]),
      prediction:
        row["prediction"] !== null && typeof row["prediction"] === "object"
          ? (row["prediction"] as Record<string, unknown>)
          : {},
      createdAt: s(row["created_at"]),
    }));
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryDeveloperStore implements DeveloperStore {
  #seq = 0;
  readonly #keys = new Map<string, DeveloperKey & { userId: string; hash: string; revoked: boolean }>();
  readonly #predictions = new Map<string, Prediction[]>();

  async listKeys(userId: string): Promise<DeveloperKey[]> {
    return [...this.#keys.values()]
      .filter((k) => k.userId === userId && !k.revoked)
      .map(({ userId: _u, hash: _h, revoked: _r, ...rest }) => rest);
  }

  async createKey(input: {
    userId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: string[];
    rateLimitPerMin: number;
  }): Promise<DeveloperKey> {
    this.#seq += 1;
    const id = String(this.#seq);
    const record = {
      id,
      name: input.name,
      keyPrefix: input.keyPrefix,
      scopes: input.scopes,
      rateLimitPerMin: input.rateLimitPerMin,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      userId: input.userId,
      hash: input.keyHash,
      revoked: false,
    };
    this.#keys.set(id, record);
    const { userId: _u, hash: _h, revoked: _r, ...rest } = record;
    return rest;
  }

  async revokeKey(userId: string, id: string): Promise<boolean> {
    const k = this.#keys.get(id);
    if (k === undefined || k.userId !== userId || k.revoked) return false;
    this.#keys.set(id, { ...k, revoked: true });
    return true;
  }

  async listPredictions(userId: string, limit: number): Promise<Prediction[]> {
    return (this.#predictions.get(userId) ?? []).slice(0, limit);
  }

  addPredictions(userId: string, entries: Prediction[]): void {
    this.#predictions.set(userId, entries);
  }
}

/** Generate a key: `<prefix>_<secret>`. Only the hash is stored. */
export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex").slice(0, 8); // ^[A-Za-z0-9]{6,12}$
  const secret = randomBytes(24).toString("base64url");
  const full = `${prefix}_${secret}`;
  return { secret: full, prefix, hash: createHash("sha256").update(full).digest("hex") };
}

const MAX_LIMIT = 100;

export async function handleDeveloperRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const keyMatch = KEY_ID.exec(ctx.path);
  if (ctx.path !== KEYS && ctx.path !== PREDICTIONS && keyMatch === null) return null;
  const store: DeveloperStore | null = ctx.config.developer ?? null;
  if (store === null) return capabilityAbsent(ctx, "developer API");
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return unauthenticated(ctx);

  if (ctx.path === KEYS) {
    if (ctx.method === "GET") {
      return { status: 200, body: ok({ keys: await store.listKeys(claims.sub) }) };
    }
    if (ctx.method !== "POST") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const body = await ctx.readBody(ctx.req);
    const name = typeof body["name"] === "string" ? body["name"].trim() : "";
    if (name === "" || name.length > 120) return validation(ctx, { name: "required, max 120 characters" });
    const rawScopes = body["scopes"];
    const scopes = rawScopes === undefined || rawScopes === null ? ["trades:read"] : rawScopes;
    if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((x) => typeof x === "string")) {
      return validation(ctx, { scopes: "must be a non-empty array of scope strings" });
    }
    const unknown = (scopes as string[]).filter((x) => !SCOPES.includes(x));
    if (unknown.length > 0) return validation(ctx, { scopes: `unknown scope(s): ${unknown.join(", ")}` });
    const rawLimitValue = body["rate_limit_per_min"];
    const rateLimit = rawLimitValue === undefined || rawLimitValue === null ? DEFAULT_RATE_LIMIT : Number(rawLimitValue);
    if (!Number.isInteger(rateLimit) || rateLimit < 1 || rateLimit > MAX_RATE_LIMIT) {
      return validation(ctx, { rate_limit_per_min: `1..${MAX_RATE_LIMIT}` });
    }
    const generated = generateApiKey();
    const created = await store.createKey({
      userId: claims.sub,
      name,
      keyPrefix: generated.prefix,
      keyHash: generated.hash,
      scopes: scopes as string[],
      rateLimitPerMin: rateLimit,
    });
    // The ONLY moment the secret exists outside the caller's hands.
    return { status: 201, body: ok({ ...created, secret: generated.secret, secret_shown_once: true }) };
  }

  if (keyMatch !== null) {
    if (ctx.method !== "DELETE") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
    const revoked = await store.revokeKey(claims.sub, decodeURIComponent(keyMatch[1] ?? ""));
    if (!revoked) return { status: 404, body: fail("NOT_FOUND", "API key not found.", ctx.requestId) };
    return { status: 204, body: null };
  }

  if (ctx.method !== "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  const rawLimit = ctx.url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return validation(ctx, { limit: `1..${MAX_LIMIT}` });
  return { status: 200, body: ok({ predictions: await store.listPredictions(claims.sub, limit) }) };
}
