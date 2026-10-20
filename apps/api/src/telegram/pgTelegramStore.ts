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
import { isTerminalTelegramDraftState } from "./telegramStore.js";
import type {
  ChecklistUpsertInput,
  PostClaimInput,
  PostClaimResult,
  TelegramPostRecord,
  TelegramTemplateRecord,
  TemplateSaveInput,
  TemplateSaveResult,
  ChecklistUpsertResult,
  IdentityInsert,
  LinkConsumption,
  TelegramChannelRecord,
  TelegramChecklistRecord,
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
  const state = (row["state"] as TelegramDraftState | null) ?? "AWAITING_CONFIRMATION";
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    telegramUserId: String(row["telegram_user_id"]),
    chatId: String(row["chat_id"]),
    sourceMessageId: String(row["source_message_id"]),
    sourceKind: (row["source_kind"] as TelegramDraftKind | null) ?? "TEXT",
    state,
    draft: (row["draft"] as TelegramDraftRecord["draft"]) ?? ({} as TelegramDraftRecord["draft"]),
    missingFields: Array.isArray(row["missing_fields"]) ? (row["missing_fields"] as string[]) : [],
    transcript: isTerminalTelegramDraftState(state) ? null : textOrNull(row["transcript"]),
    media: (row["media"] as Record<string, unknown> | null) ?? {},
    createdAt: iso(row["created_at"]),
    expiresAt: iso(row["expires_at"]),
    confirmedTradeId: textOrNull(row["confirmed_trade_id"]),
  };
}

function toChecklist(row: Row): TelegramChecklistRecord {
  const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(String(v)).toISOString());
  const items = row["items"];
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    reportDate: String(row["report_date"]).slice(0, 10),
    timezone: String(row["timezone"] ?? "UTC"),
    items:
      typeof items === "string" ? (JSON.parse(items) as Record<string, unknown>) : ((items ?? {}) as Record<string, unknown>),
    confirmedItems: Number(row["confirmed_items"] ?? 0),
    unreviewedItems: Number(row["unreviewed_items"] ?? 0),
    unknownItems: Number(row["unknown_items"] ?? 0),
    // Decimals come back as strings. Running them through Number() here would put a float into a
    // financial record, and ADR-001 forbids that at every layer, not only in the arithmetic.
    stopLoss: row["stop_loss"] === null || row["stop_loss"] === undefined ? null : String(row["stop_loss"]),
    riskValue: row["risk_value"] === null || row["risk_value"] === undefined ? null : String(row["risk_value"]),
    riskUnit: (row["risk_unit"] ?? "UNSPECIFIED") as TelegramChecklistRecord["riskUnit"],
    notes: row["notes"] === null || row["notes"] === undefined ? null : String(row["notes"]),
    reviewState: (row["review_state"] ?? "UNREVIEWED") as TelegramChecklistRecord["reviewState"],
    sourceKind: (row["source_kind"] ?? "TEXT") as TelegramChecklistRecord["sourceKind"],
    reviewedAt: iso(row["reviewed_at"]),
    createdAt: String(iso(row["created_at"]) ?? ""),
    updatedAt: String(iso(row["updated_at"]) ?? ""),
  };
}

/**
 * A template row. `version` and `superseded_at` are read together and never reconciled here: the
 * partial unique index in 0037 is what guarantees one current row per name, so the record simply
 * reports what the database says.
 */
function toTemplate(row: Row): TelegramTemplateRecord {
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    name: String(row["name"]),
    body: String(row["body"]),
    version: Number(row["version"]),
    supersededAt: isoOrNull(row["superseded_at"]),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
  };
}

function toPost(row: Row): TelegramPostRecord {
  const status = String(row["status"]);
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    channelId: String(row["channel_id"]),
    chatId: String(row["chat_id"]),
    body: String(row["body"]),
    contentHash: String(row["content_hash"]),
    approvedHash: textOrNull(row["approved_hash"]),
    approvedAt: isoOrNull(row["approved_at"]),
    bannerSvg: textOrNull(row["banner_svg"]),
    imageFileId: textOrNull(row["image_file_id"]),
    templateKey: textOrNull(row["template_key"]),
    templateVersion: row["template_version"] === null || row["template_version"] === undefined ? null : Number(row["template_version"]),
    status: (["DRAFT", "APPROVED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED"].includes(status)
      ? status
      : "DRAFT") as TelegramPostRecord["status"],
    dedupeKey: String(row["dedupe_key"]),
    telegramMessageId: textOrNull(row["telegram_message_id"]),
    publishedAt: isoOrNull(row["published_at"]),
    errorCode: textOrNull(row["error_code"]),
    attempts: Number(row["attempts"]),
    createdAt: iso(row["created_at"]),
    updatedAt: iso(row["updated_at"]),
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

  async beginUpdateProcessing(updateId: string, at: Date): Promise<boolean> {
    const rows = await this.q(
      `UPDATE telegram_updates
          SET processing_started_at = $2::timestamptz
        WHERE update_id = $1::bigint
          AND processed_at IS NULL
          AND processing_started_at IS NULL
        RETURNING update_id`,
      [updateId, at.toISOString()],
    );
    return rows.length > 0;
  }

  async finishUpdate(updateId: string, outcome: "handled" | "ignored" | "rejected" | "failed", errorCode: string | null, at: Date): Promise<void> {
    await this.q(
      `UPDATE telegram_updates
          SET processed_at = $2::timestamptz, outcome = $3, error_code = $4
        WHERE update_id = $1::bigint
          AND processing_started_at IS NOT NULL
          AND processed_at IS NULL`,
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
      if (isTerminalTelegramDraftState(patch.state)) sets.push("transcript = NULL");
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
          SET state = 'CONFIRMED', confirmed_trade_id = $2::bigint, transcript = NULL, updated_at = $3::timestamptz
        WHERE id = $1::bigint AND state = 'CONFIRMING'
        RETURNING id`,
      [draftId, tradeId, at.toISOString()],
    );
    return rows.length > 0;
  }

  async releaseConfirmationClaim(draftId: string, restoreState: TelegramDraftState, at: Date): Promise<void> {
    await this.q(
      `UPDATE telegram_journal_drafts
          SET state = $2,
              transcript = CASE WHEN $2 IN ('CONFIRMED', 'CANCELLED', 'EXPIRED') THEN NULL ELSE transcript END,
              updated_at = $3::timestamptz
        WHERE id = $1::bigint AND state = 'CONFIRMING'`,
      [draftId, restoreState, at.toISOString()],
    );
  }

  async expireStaleDrafts(at: Date): Promise<number> {
    const rows = await this.q(
      `UPDATE telegram_journal_drafts
          SET state = 'EXPIRED', transcript = NULL, updated_at = $1::timestamptz
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

  async listChannels(userId: string): Promise<readonly TelegramChannelRecord[]> {
    const rows = await this.q(
      `SELECT * FROM telegram_channels
        WHERE user_id = $1::bigint
        ORDER BY (status = 'ACTIVE') DESC, COALESCE(verified_at, created_at) DESC, id DESC`,
      [userId],
    );
    return rows.map((r) => toChannel(r));
  }

  /**
   * The swap in one transaction, in the order that cannot fail: demote the current ACTIVE row
   * FIRST, then promote. Reversed, the partial unique index `telegram_channels_one_active_per_user`
   * would reject the promotion — the index is the invariant, so the statements have to respect it
   * rather than assume a deferred check.
   */
  async activateChannel(
    userId: string,
    chatId: string,
    at: Date,
  ): Promise<
    | { readonly ok: true; readonly activated: TelegramChannelRecord; readonly demoted: TelegramChannelRecord | null }
    | { readonly ok: false; readonly reason: "NOT_FOUND" | "NOT_VERIFIED" }
  > {
    return withTransaction(this.pool, async (tx) => {
      const target = await tx(`SELECT * FROM telegram_channels WHERE user_id = $1::bigint AND chat_id = $2::bigint LIMIT 1`, [userId, chatId]);
      const row = target[0] as Row | undefined;
      if (row === undefined) return { ok: false, reason: "NOT_FOUND" } as const;
      // Verification is a fact about the past, so re-selecting is not re-verifying: `can_post` and
      // `verified_at` must both still say yes, and a PENDING_VERIFICATION row never gets promoted.
      if (row["can_post"] !== true || row["verified_at"] === null || row["status"] === "PENDING_VERIFICATION" || row["status"] === "REVOKED") {
        return { ok: false, reason: "NOT_VERIFIED" } as const;
      }
      const demoted = await tx(
        `UPDATE telegram_channels SET status = 'STANDBY', updated_at = $2::timestamptz
          WHERE user_id = $1::bigint AND status = 'ACTIVE' AND chat_id::text <> $3::text
          RETURNING *`,
        [userId, at.toISOString(), chatId],
      );
      const activated = await tx(
        `UPDATE telegram_channels SET status = 'ACTIVE', revoked_at = NULL, updated_at = $2::timestamptz
          WHERE user_id = $1::bigint AND chat_id = $3::bigint
          RETURNING *`,
        [userId, at.toISOString(), chatId],
      );
      return {
        ok: true,
        activated: toChannel(activated[0] as Row),
        demoted: demoted[0] === undefined ? null : toChannel(demoted[0] as Row),
      } as const;
    });
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

  // ── Daily checklist (0036) ──────────────────────────────────────────────
  //
  // ONE STATEMENT, AND THAT IS THE POINT. `journal_daily_checklists.items || excluded.items`
  // merges the sparse report over the stored row inside the UPSERT, so two writers on the same day
  // cannot lose each other's answers, and the counts are recomputed FROM the merged value in the
  // same statement instead of trusted from the caller. A client that sent `confirmed_items: 11`
  // would be writing a claim, not a fact.
  async upsertDailyChecklist(input: ChecklistUpsertInput): Promise<ChecklistUpsertResult> {
    const items = JSON.stringify(input.items);
    const at = input.at.toISOString();
    const rows = await this.q(
      `INSERT INTO journal_daily_checklists
         (user_id, telegram_user_id, report_date, timezone, items, confirmed_items, unknown_items,
          stop_loss, risk_value, risk_unit, notes, review_state, reviewed_at, source_kind, created_at, updated_at)
       SELECT $1::bigint, $2::bigint, $3::date, $4, $5::jsonb,
              (SELECT count(*) FROM jsonb_each_text($5::jsonb) e WHERE (e.value::jsonb)->>'state' = 'CONFIRMED'),
              (SELECT count(*) FROM jsonb_each_text($5::jsonb) e WHERE (e.value::jsonb)->>'state' = 'UNKNOWN'),
              $6, $7, $8, $9,
              CASE WHEN (SELECT count(*) FROM jsonb_each_text($5::jsonb) e WHERE (e.value::jsonb)->>'state' = 'CONFIRMED') = 11
                     THEN 'CONFIRMED'
                   WHEN (SELECT count(*) FROM jsonb_each_text($5::jsonb) e WHERE (e.value::jsonb)->>'state' = 'CONFIRMED') > 0
                     THEN 'PARTIAL' ELSE 'UNREVIEWED' END,
              CASE WHEN (SELECT count(*) FROM jsonb_each_text($5::jsonb) e WHERE (e.value::jsonb)->>'state' = 'CONFIRMED') = 11
                     THEN $10::timestamptz END,
              $11, $10::timestamptz, $10::timestamptz
       ON CONFLICT (user_id, report_date) DO UPDATE SET
         items            = journal_daily_checklists.items || EXCLUDED.items,
         confirmed_items  = (SELECT count(*) FROM jsonb_each_text(journal_daily_checklists.items || EXCLUDED.items) e
                             WHERE (e.value::jsonb)->>'state' = 'CONFIRMED'),
         unknown_items    = (SELECT count(*) FROM jsonb_each_text(journal_daily_checklists.items || EXCLUDED.items) e
                             WHERE (e.value::jsonb)->>'state' = 'UNKNOWN'),
         stop_loss        = COALESCE(EXCLUDED.stop_loss, journal_daily_checklists.stop_loss),
         risk_value       = COALESCE(EXCLUDED.risk_value, journal_daily_checklists.risk_value),
         risk_unit        = CASE WHEN EXCLUDED.risk_value IS NULL THEN journal_daily_checklists.risk_unit
                                 ELSE EXCLUDED.risk_unit END,
         notes            = COALESCE(EXCLUDED.notes, journal_daily_checklists.notes),
         source_kind      = EXCLUDED.source_kind,
         telegram_user_id = COALESCE(EXCLUDED.telegram_user_id, journal_daily_checklists.telegram_user_id),
         review_state     = CASE
                              WHEN (SELECT count(*) FROM jsonb_each_text(journal_daily_checklists.items || EXCLUDED.items) e
                                    WHERE (e.value::jsonb)->>'state' = 'CONFIRMED') = 11 THEN 'CONFIRMED'
                              WHEN (SELECT count(*) FROM jsonb_each_text(journal_daily_checklists.items || EXCLUDED.items) e
                                    WHERE (e.value::jsonb)->>'state' = 'CONFIRMED') > 0  THEN 'PARTIAL'
                              ELSE 'UNREVIEWED' END,
         reviewed_at      = CASE
                              WHEN (SELECT count(*) FROM jsonb_each_text(journal_daily_checklists.items || EXCLUDED.items) e
                                    WHERE (e.value::jsonb)->>'state' = 'CONFIRMED') = 11
                                -- NOT EXCLUDED.reviewed_at: the inserted row's stamp is derived from the SPARSE
                                -- item map, which is almost never complete on its own, so a partial report would
                                -- stamp CONFIRMED with a NULL review time and the CHECK would reject the whole
                                -- merge (found by the real-PostgreSQL harness, not by the in-memory mirror).
                                -- $10 is this statement's own instant, which is the moment the day became complete.
                                THEN COALESCE(journal_daily_checklists.reviewed_at, $10::timestamptz)
                              ELSE NULL END,
         updated_at       = EXCLUDED.updated_at
       RETURNING *, (xmax = 0) AS is_new`,
      [
        input.userId, input.telegramUserId, input.reportDate, input.timezone, items,
        input.stopLoss, input.riskValue, input.riskUnit, input.notes, at, input.sourceKind,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("telegram.checklist_upsert_no_row");
    const flag = row["is_new"];
    return {
      created: flag === true || flag === "t" || flag === 1,
      record: toChecklist(row),
    };
  }

  async findDailyChecklist(userId: string, reportDate: string): Promise<TelegramChecklistRecord | null> {
    const rows = await this.q(
      `SELECT * FROM journal_daily_checklists WHERE user_id = $1::bigint AND report_date = $2::date LIMIT 1`,
      [userId, reportDate],
    );
    return rows[0] === undefined ? null : toChecklist(rows[0]);
  }

  async listDailyChecklists(userId: string, limit: number): Promise<readonly TelegramChecklistRecord[]> {
    const bound = Math.max(1, Math.min(60, Math.floor(limit) || 1));
    const rows = await this.q(
      `SELECT * FROM journal_daily_checklists WHERE user_id = $1::bigint
        ORDER BY report_date DESC, id DESC LIMIT $2`,
      [userId, bound],
    );
    return rows.map((r) => toChecklist(r));
  }

  // ── Post templates (0037) ─────────────────────────────────────────────────

  /**
   * Append a version. The read of the current row is `FOR UPDATE`, and the supersede + insert run in
   * ONE transaction on ONE client for the same reason `createLinkToken` does: split across two
   * connections, the partial unique index would reject the insert instead of being satisfied by the
   * supersede, and a concurrent double-save would surface as a 23505 the user cannot act on.
   */
  async saveTemplate(input: TemplateSaveInput): Promise<TemplateSaveResult> {
    const name = input.name.trim();
    const body = input.body;
    return withTransaction<TemplateSaveResult>(this.pool, async (tx) => {
      const current = await tx(
        `SELECT * FROM telegram_post_templates
          WHERE user_id = $1::bigint AND name = $2 AND superseded_at IS NULL
          FOR UPDATE`,
        [input.userId, name],
      );
      const row = current[0];
      if (input.expectedVersion === null) {
        // Creating: a CURRENT row under that name is a conflict, never a silent replace of someone
        // else's template. A RETIRED name is reusable — the user asked for it back — but the new
        // row continues the version sequence (below) so no two rows for one name ever share a
        // version, which is what makes "the version I approved" a stable reference.
        if (row !== undefined) return { status: "conflict", current: toTemplate(row) };
      } else {
        if (String(row?.["version"] ?? "") !== String(input.expectedVersion)) {
          return { status: "conflict", current: row === undefined ? null : toTemplate(row) };
        }
        await tx(
          `UPDATE telegram_post_templates SET superseded_at = $3::timestamptz, updated_at = $3::timestamptz
            WHERE user_id = $1::bigint AND name = $2 AND superseded_at IS NULL`,
          [input.userId, name, input.at.toISOString()],
        );
      }
      let nextVersion = row === undefined ? 1 : Number(row["version"]) + 1;
      if (row === undefined) {
        const seen = await tx(
          `SELECT COALESCE(MAX(version), 0)::int AS top FROM telegram_post_templates
            WHERE user_id = $1::bigint AND name = $2`,
          [input.userId, name],
        );
        nextVersion = Number((seen[0] as Row)["top"]) + 1;
      }
      const inserted = await tx(
        `INSERT INTO telegram_post_templates (user_id, name, body, version, created_at, updated_at)
         VALUES ($1::bigint, $2, $3, $4, $5::timestamptz, $5::timestamptz)
         RETURNING *`,
        [input.userId, name, body, nextVersion, input.at.toISOString()],
      );
      return { status: "saved", record: toTemplate(inserted[0] as Row) };
    }).catch((err: unknown) => {
      // A unique violation here is the SAME fact as a version mismatch — somebody else appended
      // first — and the caller must see a conflict, not a 500.
      if (isUniqueViolation(err)) {
        return { status: "conflict", current: null };
      }
      throw err;
    });
  }

  async findCurrentTemplate(userId: string, name: string): Promise<TelegramTemplateRecord | null> {
    const rows = await this.q(
      `SELECT * FROM telegram_post_templates
        WHERE user_id = $1::bigint AND name = $2 AND superseded_at IS NULL LIMIT 1`,
      [userId, name.trim()],
    );
    return rows[0] === undefined ? null : toTemplate(rows[0]);
  }

  async listTemplates(userId: string): Promise<readonly TelegramTemplateRecord[]> {
    const rows = await this.q(
      `SELECT DISTINCT ON (name) * FROM telegram_post_templates
        WHERE user_id = $1::bigint AND superseded_at IS NULL
        ORDER BY name, version DESC`,
      [userId],
    );
    return rows.map((r) => toTemplate(r));
  }

  async retireTemplate(userId: string, name: string, at: Date): Promise<boolean> {
    const rows = await this.q(
      `UPDATE telegram_post_templates SET superseded_at = $3::timestamptz, updated_at = $3::timestamptz
        WHERE user_id = $1::bigint AND name = $2 AND superseded_at IS NULL
        RETURNING id`,
      [userId, name.trim(), at.toISOString()],
    );
    return rows.length > 0;
  }

  // ── Prepared posts (0037) ─────────────────────────────────────────────────

  /**
   * INSERT-or-find in ONE statement. The `ON CONFLICT (user_id, dedupe_key) DO NOTHING` is the whole
   * duplicate-post guarantee: no read happens first, so two deliveries of one update cannot both
   * decide they are the first. The follow-up SELECT only runs for the loser.
   */
  async claimPost(input: PostClaimInput): Promise<PostClaimResult> {
    const inserted = await this.q(
      `INSERT INTO telegram_outbox_posts
         (user_id, channel_id, chat_id, body, content_hash, dedupe_key, banner_svg, image_file_id,
          template_key, template_version, status, created_at, updated_at)
       VALUES ($1::bigint, $2::bigint, $3::bigint, $4, $5, $6, $7, $8, $9, $10, 'DRAFT', $11::timestamptz, $11::timestamptz)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING *`,
      [
        input.userId,
        input.channelId,
        input.chatId,
        input.body,
        input.contentHash,
        input.dedupeKey,
        input.bannerSvg,
        input.imageFileId,
        input.templateKey,
        input.templateVersion,
        input.at.toISOString(),
      ],
    );
    if (inserted[0] !== undefined) return { status: "claimed", post: toPost(inserted[0] as Row) };
    const existing = await this.q(
      `SELECT * FROM telegram_outbox_posts WHERE user_id = $1::bigint AND dedupe_key = $2 LIMIT 1`,
      [input.userId, input.dedupeKey],
    );
    // The conflict tells us a row exists; a read that then finds nothing means it was removed
    // between statements. Refusing to guess is cheaper than re-inserting a second publication.
    if (existing[0] === undefined) throw new Error("post_claim_lost");
    return { status: "duplicate", post: toPost(existing[0]) };
  }

  async revisePost(input: {
    userId: string;
    postId: string;
    body: string;
    contentHash: string;
    bannerSvg: string | null;
    at: Date;
  }): Promise<TelegramPostRecord | null> {
    // One statement, and the approval columns are nulled in the same write that changes the bytes:
    // 0037's `approval_matches_content` would reject "new body, old approval" anyway, so clearing
    // them here is what makes the UPDATE succeed instead of throwing from a constraint.
    const rows = await this.q(
      `UPDATE telegram_outbox_posts
          SET body = $3, content_hash = $4, banner_svg = $5,
              approved_hash = NULL, approved_at = NULL, status = 'DRAFT', updated_at = $6::timestamptz
        WHERE id = $1::bigint AND user_id = $2::bigint AND status IN ('DRAFT', 'APPROVED', 'FAILED', 'CANCELLED')
        RETURNING *`,
      [input.postId, input.userId, input.body, input.contentHash, input.bannerSvg, input.at.toISOString()],
    );
    return rows[0] === undefined ? null : toPost(rows[0]);
  }

  async findPost(userId: string, postId: string): Promise<TelegramPostRecord | null> {
    const rows = await this.q(`SELECT * FROM telegram_outbox_posts WHERE id = $1::bigint AND user_id = $2::bigint LIMIT 1`, [postId, userId]);
    return rows[0] === undefined ? null : toPost(rows[0]);
  }

  async listRecentPosts(userId: string, limit: number): Promise<readonly TelegramPostRecord[]> {
    const bound = Math.max(1, Math.min(50, Math.floor(limit) || 1));
    const rows = await this.q(
      `SELECT * FROM telegram_outbox_posts WHERE user_id = $1::bigint ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, bound],
    );
    return rows.map((r) => toPost(r));
  }

  /**
   * Approval as a conditional write: `content_hash = $3` is IN the WHERE clause, so a post whose
   * bytes changed after the preview cannot be approved by a stale tap — it returns null and the
   * caller re-renders. Ownership is in the same clause, never in a follow-up check.
   */
  async approvePost(input: { userId: string; postId: string; contentHash: string; at: Date }): Promise<TelegramPostRecord | null> {
    const rows = await this.q(
      `UPDATE telegram_outbox_posts
          SET status = 'APPROVED', approved_hash = $3, approved_at = $4::timestamptz, updated_at = $4::timestamptz
        WHERE id = $1::bigint AND user_id = $2::bigint AND content_hash = $3
          AND status IN ('DRAFT', 'APPROVED', 'FAILED')
        RETURNING *`,
      [input.postId, input.userId, input.contentHash, input.at.toISOString()],
    );
    return rows[0] === undefined ? null : toPost(rows[0]);
  }

  async claimPublish(input: { userId: string; postId: string; maxAttempts: number; at: Date }): Promise<boolean> {
    const rows = await this.q(
      `UPDATE telegram_outbox_posts SET status = 'PUBLISHING', attempts = attempts + 1, updated_at = $3::timestamptz
        WHERE id = $1::bigint AND user_id = $2::bigint AND status IN ('APPROVED', 'FAILED') AND attempts < $4
        RETURNING id`,
      [input.postId, input.userId, input.at.toISOString(), Math.max(1, Math.min(5, Math.floor(input.maxAttempts) || 1))],
    );
    return rows.length > 0;
  }

  async finishPost(input: {
    userId: string;
    postId: string;
    status: "PUBLISHED" | "FAILED";
    message_id?: string | null;
    errorCode: string | null;
    at: Date;
    imageFileId?: string | null | undefined;
  }): Promise<TelegramPostRecord | null> {
    // A FAILED row must carry a code (0037's CHECK), so an unlabelled failure is labelled rather
    // than rejected mid-recovery. A code for a success is dropped: it would be a contradiction.
    const code = input.status === "FAILED" ? (input.errorCode ?? "SEND_FAILED") : null;
    const messageId = input.status === "PUBLISHED" ? (input.message_id ?? null) : null;
    const rows = await this.q(
      `UPDATE telegram_outbox_posts
          SET status = $3,
              telegram_message_id = $4,
              published_at = CASE WHEN $3 = 'PUBLISHED' THEN $5::timestamptz ELSE NULL END,
              error_code = $6,
              image_file_id = COALESCE($7, image_file_id),
              updated_at = $5::timestamptz
        WHERE id = $1::bigint AND user_id = $2::bigint AND status = 'PUBLISHING'
        RETURNING *`,
      [input.postId, input.userId, input.status, messageId, input.at.toISOString(), code, input.imageFileId ?? null],
    );
    return rows[0] === undefined ? null : toPost(rows[0]);
  }

}
