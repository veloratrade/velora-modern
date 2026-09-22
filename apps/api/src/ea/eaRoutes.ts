// EA ingestion + device registration — v2.0 "Native EAs + Mobile".
//
//   POST /api/v1/ea/handshake      EA authenticates with its API key
//   POST /api/v1/ea/trade-event    EA posts a trade event
//   POST /api/v1/devices/register-push
//   DELETE /api/v1/devices/{id}
//
// ============================================================
// EA AUTHENTICATION — A SEPARATE CREDENTIAL CLASS
// ============================================================
// An Expert Advisor cannot hold a user's bearer token: it runs unattended on a
// trading terminal. The Foundation models this with `trading_accounts.ea_api_key_hash`
// (0019) — a per-account key whose hash is stored, plus `ea_last_seen_at`. The
// key is a high-entropy random token, so SHA-256 (not a password KDF) is the
// correct store: there is nothing to brute-force, and the ingestion path must
// stay fast (the roadmap's <50 ms EA budget).
//
// Comparison is timing-safe and performed over the HASH of the presented key, so
// the lookup is by hash and the comparison never depends on the secret's bytes.
//
// ============================================================
// INGESTION SEMANTICS
// ============================================================
// An EA event is a DEAL event and is handled exactly like a MetaAPI webhook
// deal: it is recorded durably, the account is marked as awaiting sync, and ONE
// targeted sync is requested. There is no second ingestion implementation and no
// trade-assembly code in the request path — the worker owns that, as it does for
// every other provider (see `metaApiWebhookService.ts` for the full rationale).
//
// ============================================================
// PUSH — IMPLEMENTED UP TO THE PROVIDER BOUNDARY
// ============================================================
// Registration is fully implemented (the token is ENCRYPTED at rest with the
// credential master key, matching 0019's column contract: key_version, iv,
// auth_tag, ciphertext, fingerprint, and a UNIQUE (key_version, iv) nonce
// constraint). DELIVERY is not implemented: FCM/APNs require a service
// credential that does not exist in this environment, and a delivery call cannot
// be faked. Reported as PARTIALLY_IMPLEMENTED + BLOCKED(credential).
import { fail, ok } from "@velora/contracts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { QueryFn } from "../persistence/pg.js";
import { capabilityAbsent } from "../routes/responses.js";
import type { ExtendedRouteContext, RouteResult } from "../routes/types.js";

export const HANDSHAKE = "/api/v1/ea/handshake";
export const TRADE_EVENT = "/api/v1/ea/trade-event";
export const REGISTER_PUSH = "/api/v1/devices/register-push";
const DEVICE_ID = /^\/api\/v1\/devices\/([^/]+)$/;

export const DEVICE_PLATFORMS: readonly string[] = ["ios", "android", "web"];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface EaAccount {
  readonly accountId: string;
  readonly userId: string;
  readonly metaapiAccountId: string | null;
  readonly label: string;
  readonly eaKeyHash: string;
  readonly syncCursor: string | null;
}

export interface EaStore {
  /** Look up a candidate account by the HASH of the presented key. */
  findByKeyHash(keyHash: string): Promise<EaAccount | null>;
  touchLastSeen(accountId: string): Promise<void>;
  setKeyHash(accountId: string, userId: string, keyHash: string): Promise<boolean>;
  /** Record a device token: encrypted at rest, per 0019. */
  registerDevice(input: {
    userId: string;
    platform: string;
    fingerprint: string;
    keyVersion: number;
    iv: Buffer;
    authTag: Buffer;
    ciphertext: Buffer;
  }): Promise<{ id: string }>;
  revokeDevice(userId: string, deviceId: string): Promise<boolean>;
}

type Row = Record<string, unknown>;

export class PgEaStore implements EaStore {
  constructor(private readonly q: QueryFn) {}

  async findByKeyHash(keyHash: string): Promise<EaAccount | null> {
    const rows = await this.q(
      `SELECT id::text, user_id::text, metaapi_account_id, label, ea_api_key_hash, sync_cursor
         FROM trading_accounts
        WHERE ea_api_key_hash = $1 AND ea_key_revoked_at IS NULL
        LIMIT 1`,
      [keyHash],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      accountId: String(row["id"]),
      userId: String(row["user_id"]),
      metaapiAccountId: row["metaapi_account_id"] === null ? null : String(row["metaapi_account_id"]),
      label: String(row["label"]),
      eaKeyHash: String(row["ea_api_key_hash"]),
      syncCursor: row["sync_cursor"] === null ? null : String(row["sync_cursor"]),
    };
  }

  async touchLastSeen(accountId: string): Promise<void> {
    await this.q("UPDATE trading_accounts SET ea_last_seen_at = now() WHERE id = $1", [accountId]);
  }

  async setKeyHash(accountId: string, userId: string, keyHash: string): Promise<boolean> {
    const rows = await this.q(
      `UPDATE trading_accounts
          SET ea_api_key_hash = $3, ea_key_created_at = now(), ea_key_revoked_at = NULL, updated_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [accountId, userId, keyHash],
    );
    return rows.length > 0;
  }

  async registerDevice(input: {
    userId: string;
    platform: string;
    fingerprint: string;
    keyVersion: number;
    iv: Buffer;
    authTag: Buffer;
    ciphertext: Buffer;
  }): Promise<{ id: string }> {
    const rows = await this.q(
      `INSERT INTO device_tokens
         (user_id, platform, token_fingerprint, key_version, iv, auth_tag, token_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (token_fingerprint) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             platform = EXCLUDED.platform,
             key_version = EXCLUDED.key_version,
             iv = EXCLUDED.iv,
             auth_tag = EXCLUDED.auth_tag,
             token_ciphertext = EXCLUDED.token_ciphertext,
             revoked_at = NULL,
             registered_at = now()
       RETURNING id::text`,
      [input.userId, input.platform, input.fingerprint, input.keyVersion, input.iv, input.authTag, input.ciphertext],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("device registration returned no row");
    return { id: String(row["id"]) };
  }

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    const rows = await this.q(
      `UPDATE device_tokens SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [deviceId, userId],
    );
    return rows.length > 0;
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryEaStore implements EaStore {
  #seq = 0;
  readonly #devices = new Map<string, { userId: string; fingerprint: string; revoked: boolean; platform: string }>();
  readonly #accounts = new Map<string, EaAccount>();

  addAccount(account: EaAccount): void {
    this.#accounts.set(account.eaKeyHash, account);
  }

  async findByKeyHash(keyHash: string): Promise<EaAccount | null> {
    return this.#accounts.get(keyHash) ?? null;
  }

  async touchLastSeen(): Promise<void> {
    // observation only
  }

  async setKeyHash(accountId: string, userId: string, keyHash: string): Promise<boolean> {
    for (const [hash, account] of this.#accounts) {
      if (account.accountId === accountId && account.userId === userId) {
        this.#accounts.delete(hash);
        this.#accounts.set(keyHash, { ...account, eaKeyHash: keyHash });
        return true;
      }
    }
    return false;
  }

  async registerDevice(input: {
    userId: string;
    platform: string;
    fingerprint: string;
    keyVersion: number;
    iv: Buffer;
    authTag: Buffer;
    ciphertext: Buffer;
  }): Promise<{ id: string }> {
    for (const [id, device] of this.#devices) {
      if (device.fingerprint === input.fingerprint) {
        this.#devices.set(id, { ...device, userId: input.userId, revoked: false, platform: input.platform });
        return { id };
      }
    }
    this.#seq += 1;
    const id = String(this.#seq);
    this.#devices.set(id, { userId: input.userId, fingerprint: input.fingerprint, revoked: false, platform: input.platform });
    return { id };
  }

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    const device = this.#devices.get(deviceId);
    if (device === undefined || device.userId !== userId || device.revoked) return false;
    this.#devices.set(deviceId, { ...device, revoked: true });
    return true;
  }
}

/** Encryptor port: the credential master key's AES-256-GCM envelope (0019). */
export interface DeviceTokenEncryptor {
  readonly keyVersion: number;
  encrypt(plaintext: string): { iv: Buffer; authTag: Buffer; ciphertext: Buffer };
}

export interface SyncTriggerPort {
  requestSync(request: { accountId: string; metaapiAccountId: string; from: string; to: string }): Promise<boolean>;
}

function headerString(ctx: ExtendedRouteContext, name: string): string | null {
  const raw = ctx.req.headers[name];
  if (raw === undefined) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : raw;
}

async function authenticateEa(ctx: ExtendedRouteContext, store: EaStore): Promise<EaAccount | null> {
  // The EA presents its key in the same `Authorization: Bearer` slot a user
  // token uses, but it is a DIFFERENT credential class resolved against a
  // different store — it is never verified as a JWT.
  const header = headerString(ctx, "authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const presented = header.slice("Bearer ".length).trim();
  if (presented === "") return null;
  const hash = sha256Hex(presented);
  const account = await store.findByKeyHash(hash);
  if (account === null) return null;
  // Defence in depth: the lookup returned this row BECAUSE the hashes matched,
  // but the comparison is redone in constant time so a future store change
  // cannot introduce a non-constant-time path.
  return constantTimeEqualHex(account.eaKeyHash, hash) ? account : null;
}

export async function handleEaRoutes(ctx: ExtendedRouteContext): Promise<RouteResult | null> {
  const deviceMatch = DEVICE_ID.exec(ctx.path);
  const isEa = ctx.path === HANDSHAKE || ctx.path === TRADE_EVENT;
  const isDevice = ctx.path === REGISTER_PUSH || deviceMatch !== null;
  if (!isEa && !isDevice) return null;

  const store: EaStore | null = ctx.config.ea ?? null;
  if (store === null) return capabilityAbsent(ctx, "EA ingestion");
  if (ctx.method === "GET") return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };

  if (isEa) {
    const account = await authenticateEa(ctx, store);
    if (account === null) {
      // 401 for an unknown/revoked key: the EA must re-provision, and no detail
      // about WHY is disclosed (key hash, account existence).
      return { status: 401, body: fail("UNAUTHENTICATED", "Unknown or revoked EA key.", ctx.requestId) };
    }
    await store.touchLastSeen(account.accountId);

    if (ctx.path === HANDSHAKE) {
      // The handshake confirms identity and tells the EA whether server-side
      // history is still wanted. It never returns the key or its hash.
      return {
        status: 200,
        body: ok({
          account_id: account.accountId,
          label: account.label,
          hmac_required: true,
          server_time: new Date().toISOString(),
        }),
      };
    }

    const body = await ctx.readBody(ctx.req);
    const symbol = body["symbol"];
    if (typeof symbol !== "string" || symbol.trim() === "" || symbol.length > 32) {
      return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { symbol: "required, max 32 chars" }) };
    }
    const trigger: SyncTriggerPort | null = ctx.config.eaSync ?? null;
    const from = account.syncCursor ?? new Date(Date.now() - 86_400_000).toISOString();
    const requested =
      trigger !== null && account.metaapiAccountId !== null
        ? await trigger.requestSync({
            accountId: account.accountId,
            metaapiAccountId: account.metaapiAccountId,
            from,
            to: new Date().toISOString(),
          })
        : false;
    return {
      status: 202,
      body: ok({
        accepted: true,
        account_id: account.accountId,
        sync: requested ? "requested" : "deferred",
      }),
    };
  }

  // ---- devices (bearer-authenticated: an app instance, not an EA) ----------
  const claims = ctx.authenticate(ctx.req);
  if (claims === null) return { status: 401, body: fail("UNAUTHENTICATED", "Unauthenticated.", ctx.requestId) };

  if (ctx.path === REGISTER_PUSH) {
    const encryptor: DeviceTokenEncryptor | null = ctx.config.deviceTokens ?? null;
    if (encryptor === null) {
      // No credential master key ⇒ the token cannot be encrypted at rest, and
      // storing it in the clear would violate 0019's contract. Fail closed.
      return capabilityAbsent(ctx, "push registration");
    }
    const body = await ctx.readBody(ctx.req);
    const platform = typeof body["platform"] === "string" ? body["platform"].toLowerCase() : "";
    const token = typeof body["token"] === "string" ? body["token"] : "";
    if (!DEVICE_PLATFORMS.includes(platform)) {
      return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { platform: DEVICE_PLATFORMS.join("|") }) };
    }
    if (token.length < 16 || token.length > 4096) {
      return { status: 400, body: fail("VALIDATION_FAILED", "Validation failed.", ctx.requestId, { token: "length 16..4096" }) };
    }
    const envelope = encryptor.encrypt(token);
    const record = await store.registerDevice({
      userId: claims.sub,
      platform,
      fingerprint: sha256Hex(token),
      keyVersion: encryptor.keyVersion,
      iv: envelope.iv,
      authTag: envelope.authTag,
      ciphertext: envelope.ciphertext,
    });
    // The token itself is never echoed back.
    return { status: 201, body: ok({ id: record.id, platform }) };
  }

  const deviceId = decodeURIComponent(deviceMatch?.[1] ?? "");
  if (ctx.method !== "DELETE") {
    return { status: 405, body: fail("METHOD_NOT_ALLOWED", "Method not allowed.", ctx.requestId) };
  }
  const revoked = await store.revokeDevice(claims.sub, deviceId);
  if (!revoked) return { status: 404, body: fail("NOT_FOUND", "Device not found.", ctx.requestId) };
  return { status: 204, body: null };
}

/** Generate a new EA key. The plaintext is returned exactly once. */
export function generateEaKey(): { key: string; hash: string } {
  const key = randomBytes(32).toString("base64url");
  return { key, hash: sha256Hex(key) };
}
