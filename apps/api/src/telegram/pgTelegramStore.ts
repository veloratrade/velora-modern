// PostgreSQL adapter for the Telegram port — direct `pg`, no ORM (ADR-010/OD-6).
//
// TWO STATEMENTS IN THIS FILE ARE SECURITY-CRITICAL AND ARE THE ONLY SANCTIONED
// WAY TO DO THEIR JOBS:
//   1. `claimUpdate`      — INSERT ... ON CONFLICT DO NOTHING RETURNING. The
//      primary key decides which delivery of an update may act.
//   2. `consumeLinkToken` — UPDATE ... WHERE status='PENDING' AND expires_at>now()
//      RETURNING. Single-use and expiry are decided by the engine inside one
//      statement, so no interleaving of two callers can spend one token twice.
// Neither may be rewritten as read-then-write.
import type { Pool } from "pg";
import { isUniqueViolation, poolQuery, withTransaction, type QueryFn } from "../persistence/pg.js";
import type {
  IdentityInsert,
  LinkConsumption,
  TelegramChannelRecord,
  TelegramChannelStatus,
  TelegramDraftKind,
  TelegramDraftRecord,
  TelegramDraftState,
  TelegramIdentityRecord,
  TelegramStore,
  TelegramTokenRecord,
} from "./telegramStore.js";

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}
function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toIdentity(row: Row): TelegramIdentityRecord {
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    telegramUserId: String(row["telegram_user_id"]),
    username: textOrNull(row["username"]),
    status: row["status"] === "REVOKED" ? "REVOKED" : "LINKED",
    linkedAt: iso(row["linked_at"]),
    revokedAt: isoOrNull(row["revoked_at"]),
    lastSeenAt: isoOrNull(row["last_seen_at"]),
  };
}

function toToken(row: Row): TelegramTokenRecord {
  const status = row["status"];
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    status: status === "CONSUMED" || status === "EXPIRED" || status === "REVOKED" ? status : "PENDING",
    createdAt: iso(row["created_at"]),
    expiresAt: iso(row["expires_at"]),
    consumedAt: isoOrNull(row["consumed_at"]),
    revokedAt: isoOrNull(row["revoked_at"]),
    consumedByTelegramUserId: textOrNull(row["consumed_by_telegram_user_id"]),
  };
}

function toDraft(row: Row): TelegramDraftRecord {
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    telegramUserId: String(row["telegram_user_id"]),
    chatId: String(row["chat_id"]),
    sourceMessageId: String(row["source_message_id"]),
    sourceKind: (row["source_kind"] as TelegramDraftKind | null) ?? "TEXT",
    state: (row["state"] as TelegramDraftState | null) ?? "AWAITING_CONFIRMATION",
    draft: (row["draft"] as TelegramDraftRecord["draft"]) ?? ({} as TelegramDraftRecord["draft"]),
    missingFields: Array.isArray(row["missing_fields"]) ? (row["missing_fields"] as string[]) : [],
    transcript: textOrNull(row["transcript"]),
    media: (row["media"] as Record<string, unknown> | null) ?? {},
    createdAt: iso(row["created_at"]),
    expiresAt: iso(row["expires_at"]),
    confirmedTradeId: textOrNull(row["confirmed_trade_id"]),
  };
}

function toChannel(row: Row): TelegramChannelRecord {
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    chatId: String(row["chat_id"]),
    title: textOrNull(row["title"]),
    chatType: (row["chat_type"] as TelegramChannelRecord["chatType"] | null) ?? "channel",
    status: (row["status"] as TelegramChannelStatus | null) ?? "PENDING_VERIFICATION",
    canPost: row["can_post"] === true,
    verifiedAt: isoOrNull(row["verified_at"]),
    revokedAt: isoOrNull(row["revoked_at"]),
  };
}

export class PgTelegramStore implements TelegramStore {
  private readonly q: QueryFn;

  /**
   * Takes the POOL, not a bare QueryFn. One operation here needs a real
   * transaction (`createLinkToken`), and a multi-statement "transaction" issued
   * through a pooled executor would silently run its statements on DIFFERENT
   * connections — the same reason `PgAccountStore` takes the pool for its quota
   * guard. Single-statement methods use the derived `q`.
   */
  constructor(private readonly pool: Pool) {
    this.q = poolQuery(pool);
  }

  // ── Update idempotency ────────────────────────────────────────────────────

  async claimUpdate(claim: {
    updateId: string;
    telegramUserId: string | null;
    chatId: string | null;
    kind: string;
    at: Date;
  }): Promise<boolean> {
    const rows = await this.q(
      `INSERT INTO telegram_updates (update_id, telegram_user_id, chat_id, update_kind, received_at)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5::timestamptz)
       ON CONFLICT (update_id) DO NOTHING
       RETURNING update_id`,
      [claim.updateId, claim.telegramUserId, claim.chatId, claim.kind, claim.at.toISOString()],
    );
    return rows.length > 0;
  }

  async finishUpdate(updateId: string, outcome: "handled" | "ignored" | "rejected" | "failed", errorCode: string | null, at: Date): Promise<void> {
    await this.q(
      `UPDATE telegram_updates SET processed_at = $2::timestamptz, outcome = $3, error_code = $4 WHERE update_id = $1::bigint`,
      [updateId, at.toISOString(), outcome, errorCode],
    );
  }

  // ── Identities ────────────────────────────────────────────────────────────

  async findLiveIdentityByTelegramUserId(telegramUserId: string): Promise<TelegramIdentityRecord | null> {
    const rows = await this.q(
      `SELECT * FROM telegram_identities WHERE telegram_user_id = $1::bigint AND status = 'LINKED' LIMIT 1`,
      [telegramUserId],
    );
    return rows[0] === undefined ? null : toIdentity(rows[0]);
  }

  async findLiveIdentityByUserId(userId: string): Promise<TelegramIdentityRecord | null> {
    const rows = await this.q(
      `SELECT * FROM telegram_identities WHERE user_id = $1::bigint AND status = 'LINKED' LIMIT 1`,
      [userId],
    );
    return rows[0] === undefined ? null : toIdentity(rows[0]);
  }

  async findLatestIdentityByUserId(userId: string): Promise<TelegramIdentityRecord | null> {
    const rows = await this.q(
      `SELECT * FROM telegram_identities WHERE user_id = $1::bigint ORDER BY linked_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    return rows[0] === undefined ? null : toIdentity(rows[0]);
  }

  async insertLiveIdentity(input: {
    userId: string;
    telegramUserId: string;
    username: string | null;
    at: Date;
  }): Promise<IdentityInsert> {
    try {
      const rows = await this.q(
        `INSERT INTO telegram_identities (user_id, telegram_user_id, username, status, linked_at, created_at, updated_at)
         VALUES ($1::bigint, $2::bigint, $3, 'LINKED', $4::timestamptz, $4::timestamptz, $4::timestamptz)
         RETURNING *`,
        [input.userId, input.telegramUserId, input.username, input.at.toISOString()],
      );
      const row = rows[0];
      if (row === undefined) return { ok: false, reason: "IDENTITY_TAKEN" };
      return { ok: true, identity: toIdentity(row) };
    } catch (err) {
      // The partial unique indexes are the collision guard, and their NAMES are
      // the only thing inspected — never the driver message, which can quote SQL.
      if (isUniqueViolation(err)) {
        if (isUniqueViolation(err, "telegram_identities_live_tg_unique")) return { ok: false, reason: "IDENTITY_TAKEN" };
        if (isUniqueViolation(err, "telegram_identities_live_user_unique")) return { ok: false, reason: "ACCOUNT_TAKEN" };
        // A unique violation this method does not name is still a collision: fail
        // closed towards "taken" rather than reporting a successful link.
        return { ok: false, reason: "IDENTITY_TAKEN" };
      }
      throw err;
    }
  }

  async revokeIdentity(userId: string, identityId: string, at: Date): Promise<boolean> {
    const rows = await this.q(
      `UPDATE telegram_identities
          SET status = 'REVOKED', revoked_at = $3::timestamptz, updated_at = $3::timestamptz
        WHERE id = $1::bigint AND user_id = $2::bigint AND status = 'LINKED'
        RETURNING id`,
      [identityId, userId, at.toISOString()],
    );
    return rows.length > 0;
  }

  async touchIdentity(identityId: string, at: Date): Promise<void> {
    await this.q(
      `UPDATE telegram_identities SET last_seen_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1::bigint`,
      [identityId, at.toISOString()],
    );
  }

  // ── Linking transactions ──────────────────────────────────────────────────

  async createLinkToken(input: { userId: string; tokenHash: string; expiresAt: Date; at: Date }): Promise<void> {
    // ONE transaction on ONE checked-out client (`withTransaction`): close out the
    // previous pending transaction, then insert the new one. Splitting these two
    // statements would let the partial unique index reject the insert instead of
    // being satisfied by the supersede — i.e. a user could not start a second
    // linking flow while an abandoned one was pending.
    await withTransaction(this.pool, async (tx) => {
      await tx(
        `UPDATE telegram_link_tokens
            SET status = CASE WHEN expires_at <= $2::timestamptz THEN 'EXPIRED' ELSE 'REVOKED' END,
                revoked_at = CASE WHEN expires_at <= $2::timestamptz THEN NULL ELSE $2::timestamptz END
          WHERE user_id = $1::bigint AND status = 'PENDING'`,
        [input.userId, input.at.toISOString()],
      );
      await tx(
        `INSERT INTO telegram_link_tokens (user_id, purpose, token_hash, status, created_at, expires_at)
         VALUES ($1::bigint, 'TELEGRAM_LINK', $2, 'PENDING', $3::timestamptz, $4::timestamptz)`,
        [input.userId, input.tokenHash, input.at.toISOString(), input.expiresAt.toISOString()],
      );
    });
  }

  async consumeLinkToken(input: { tokenHash: string; telegramUserId: string; at: Date }): Promise<LinkConsumption> {
    const rows = await this.q(
      `UPDATE telegram_link_tokens
          SET status = 'CONSUMED', consumed_at = $3::timestamptz, consumed_by_telegram_user_id = $2::bigint
        WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > $3::timestamptz
        RETURNING id::text AS id, user_id::text AS user_id`,
      [input.tokenHash, input.telegramUserId, input.at.toISOString()],
    );
    const row = rows[0];
    if (row !== undefined) {
      return { ok: true, userId: String(row["user_id"]), tokenId: String(row["id"]) };
    }
    // The loser of a race, an expired token and an unknown token all land here.
    // The diagnosis is server-side only; the caller decides what, if anything, to
    // tell the Telegram user (see telegramCopy.ts — never "already used by X").
    const existing = await this.q(
      `SELECT status, expires_at FROM telegram_link_tokens WHERE token_hash = $1 LIMIT 1`,
      [input.tokenHash],
    );
    const current = existing[0];
    if (current === undefined) return { ok: false, reason: "UNKNOWN" };
    const status = String(current["status"]);
    if (status === "CONSUMED") return { ok: false, reason: "CONSUMED" };
    if (status === "REVOKED") return { ok: false, reason: "REVOKED" };
    if (status === "EXPIRED") return { ok: false, reason: "EXPIRED" };
    const expiresAt = current["expires_at"];
    const expired = expiresAt instanceof Date ? expiresAt.getTime() <= input.at.getTime() : true;
    return { ok: false, reason: expired ? "EXPIRED" : "UNKNOWN" };
  }

  async attachConsumedIdentity(tokenId: string, identityId: string): Promise<void> {
    await this.q(
      `UPDATE telegram_link_tokens SET consumed_identity_id = $2::bigint WHERE id = $1::bigint AND consumed_identity_id IS NULL`,
      [tokenId, identityId],
    );
  }

  async findLatestTokenByUserId(userId: string): Promise<TelegramTokenRecord | null> {
    const rows = await this.q(
      `SELECT * FROM telegram_link_tokens WHERE user_id = $1::bigint ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId],
    );
    return rows[0] === undefined ? null : toToken(rows[0]);
  }

  // ── Journal drafts ────────────────────────────────────────────────────────

  async createDraft(input: {
    userId: string;
    telegramUserId: string;
    chatId: string;
    sourceMessageId: string;
    sourceKind: TelegramDraftKind;
    draft: TelegramDraftRecord["draft"];
    missingFields: readonly string[];
    transcript: string | null;
    media: Record<string, unknown>;
    expiresAt: Date;
    at: Date;
  }): Promise<TelegramDraftRecord> {
    const state: TelegramDraftState = input.missingFields.length > 0 ? "NEEDS_DETAIL" : "AWAITING_CONFIRMATION";
    const rows = await this.q(
      `INSERT INTO telegram_journal_drafts
         (user_id, telegram_user_id, chat_id, source_message_id, source_kind, state, draft, missing_fields,
          transcript, media, created_at, updated_at, expires_at)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4::bigint, $5, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb,
               $11::timestamptz, $11::timestamptz, $12::timestamptz)
       ON CONFLICT (telegram_user_id, source_message_id) DO UPDATE
         SET updated_at = excluded.updated_at
       RETURNING *`,
      [
        input.userId, input.telegramUserId, input.chatId, input.sourceMessageId, input.sourceKind, state,
        JSON.stringify(input.draft), JSON.stringify(input.missingFields), input.transcript,
        JSON.stringify(input.media), input.at.toISOString(), input.expiresAt.toISOString(),
      ],
    );
    return toDraft(rows[0] ?? {});
  }

  async findOpenDraft(telegramUserId: string, at: Date): Promise<TelegramDraftRecord | null> {
    const rows = await this.q(
      `SELECT * FROM telegram_journal_drafts
        WHERE telegram_user_id = $1::bigint
          AND state IN ('AWAITING_CONFIRMATION', 'NEEDS_DETAIL')
          AND expires_at > $2::timestamptz
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [telegramUserId, at.toISOString()],
    );
    return rows[0] === undefined ? null : toDraft(rows[0]);
  }

  async findDraftById(draftId: string): Promise<TelegramDraftRecord | null> {
    if (!/^\d+$/.test(draftId)) return null;
    const rows = await this.q(`SELECT * FROM telegram_journal_drafts WHERE id = $1::bigint LIMIT 1`, [draftId]);
    return rows[0] === undefined ? null : toDraft(rows[0]);
  }

  async updateDraft(
    draftId: string,
    patch: { draft?: TelegramDraftRecord["draft"]; missingFields?: readonly string[]; state?: TelegramDraftState },
    at: Date,
  ): Promise<TelegramDraftRecord | null> {
    const sets: string[] = ["updated_at = $2::timestamptz"];
    const params: unknown[] = [draftId, at.toISOString()];
    if (patch.draft !== undefined) {
      params.push(JSON.stringify(patch.draft));
      sets.push(`draft = $${params.length}::jsonb`);
    }
    if (patch.missingFields !== undefined) {
      params.push(JSON.stringify(patch.missingFields));
      sets.push(`missing_fields = $${params.length}::jsonb`);
    }
    if (patch.state !== undefined) {
      params.push(patch.state);
      sets.push(`state = $${params.length}`);
    }
    const rows = await this.q(
      `UPDATE telegram_journal_drafts SET ${sets.join(", ")} WHERE id = $1::bigint RETURNING *`,
      params,
    );
    return rows[0] === undefined ? null : toDraft(rows[0]);
  }

  async claimDraftForConfirmation(draftId: string, at: Date): Promise<boolean> {
    const rows = await this.q(
      `UPDATE telegram_journal_drafts
          SET state = 'CONFIRMING', updated_at = $2::timestamptz
        WHERE id = $1::bigint AND state IN ('AWAITING_CONFIRMATION', 'NEEDS_DETAIL')
        RETURNING id`,
      [draftId, at.toISOString()],
    );
    return rows.length > 0;
  }

  async markDraftConfirmed(draftId: string, tradeId: string, at: Date): Promise<boolean> {
    const rows = await this.q(
      `UPDATE telegram_journal_drafts
          SET state = 'CONFIRMED', confirmed_trade_id = $2::bigint, updated_at = $3::timestamptz
        WHERE id = $1::bigint AND state = 'CONFIRMING'
        RETURNING id`,
      [draftId, tradeId, at.toISOString()],
    );
    return rows.length > 0;
  }

  async releaseConfirmationClaim(draftId: string, restoreState: TelegramDraftState, at: Date): Promise<void> {
    await this.q(
      `UPDATE telegram_journal_drafts SET state = $2, updated_at = $3::timestamptz
        WHERE id = $1::bigint AND state = 'CONFIRMING'`,
      [draftId, restoreState, at.toISOString()],
    );
  }

  async expireStaleDrafts(at: Date): Promise<number> {
    const rows = await this.q(
      `UPDATE telegram_journal_drafts
          SET state = 'EXPIRED', updated_at = $1::timestamptz
        WHERE state IN ('AWAITING_CONFIRMATION', 'NEEDS_DETAIL') AND expires_at <= $1::timestamptz
        RETURNING id`,
      [at.toISOString()],
    );
    return rows.length;
  }

  // ── Journal channel ───────────────────────────────────────────────────────

  async upsertChannel(input: {
    userId: string;
    chatId: string;
    title: string | null;
    chatType: TelegramChannelRecord["chatType"];
    status: TelegramChannelStatus;
    canPost: boolean;
    at: Date;
  }): Promise<TelegramChannelRecord> {
    // A revoked row is reopened rather than duplicated (the owner+chat unique
    // constraint makes the row per-pair, not per-episode).
    const rows = await this.q(
      `INSERT INTO telegram_channels (user_id, chat_id, title, chat_type, status, can_post, verified_at, revoked_at, created_at, updated_at)
       VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7::timestamptz, NULL, $7::timestamptz, $7::timestamptz)
       ON CONFLICT (user_id, chat_id) DO UPDATE
         SET title = excluded.title,
             chat_type = excluded.chat_type,
             status = excluded.status,
             can_post = excluded.can_post,
             verified_at = excluded.verified_at,
             revoked_at = NULL,
             updated_at = excluded.updated_at
       RETURNING *`,
      [input.userId, input.chatId, input.title, input.chatType, input.status, input.canPost, input.at.toISOString()],
    );
    return toChannel(rows[0] ?? {});
  }

  async findActiveChannel(userId: string): Promise<TelegramChannelRecord | null> {
    const rows = await this.q(
      `SELECT * FROM telegram_channels WHERE user_id = $1::bigint AND status = 'ACTIVE' LIMIT 1`,
      [userId],
    );
    return rows[0] === undefined ? null : toChannel(rows[0]);
  }

  async findChannel(userId: string, chatId: string): Promise<TelegramChannelRecord | null> {
    const rows = await this.q(
      `SELECT * FROM telegram_channels WHERE user_id = $1::bigint AND chat_id = $2::bigint LIMIT 1`,
      [userId, chatId],
    );
    return rows[0] === undefined ? null : toChannel(rows[0]);
  }

  async revokeChannel(userId: string, chatId: string, at: Date): Promise<boolean> {
    const rows = await this.q(
      `UPDATE telegram_channels SET status = 'REVOKED', revoked_at = $3::timestamptz, updated_at = $3::timestamptz
        WHERE user_id = $1::bigint AND chat_id = $2::bigint AND status <> 'REVOKED' RETURNING id`,
      [userId, chatId, at.toISOString()],
    );
    return rows.length > 0;
  }

  async claimChannelPost(input: { channelId: string; userId: string; tradeId: string; at: Date }): Promise<{ claimed: boolean; postId: string | null }> {
    const rows = await this.q(
      `INSERT INTO telegram_channel_posts (channel_id, user_id, trade_id, status, created_at)
       VALUES ($1::bigint, $2::bigint, $3::bigint, 'PENDING', $4::timestamptz)
       ON CONFLICT (channel_id, trade_id) DO NOTHING
       RETURNING id::text AS id`,
      [input.channelId, input.userId, input.tradeId, input.at.toISOString()],
    );
    const row = rows[0];
    return row === undefined ? { claimed: false, postId: null } : { claimed: true, postId: String(row["id"]) };
  }

  async finishChannelPost(postId: string, status: "PUBLISHED" | "FAILED", messageId: string | null, errorCode: string | null, at: Date): Promise<void> {
    await this.q(
      `UPDATE telegram_channel_posts
          SET status = $2, message_id = $3::bigint, error_code = $4,
              published_at = CASE WHEN $2 = 'PUBLISHED' THEN $5::timestamptz ELSE NULL END
        WHERE id = $1::bigint`,
      [postId, status, messageId, errorCode, at.toISOString()],
    );
  }

  async listPublishedTradeIds(channelId: string): Promise<readonly string[]> {
    const rows = await this.q(
      `SELECT trade_id::text AS trade_id FROM telegram_channel_posts WHERE channel_id = $1::bigint AND status = 'PUBLISHED'`,
      [channelId],
    );
    return rows.map((r) => String(r["trade_id"]));
  }
}
