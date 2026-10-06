// PG adapters for the notification stores (MG-EMAIL-TYPES, AC-33).
//
// Mapping notes (Legacy → Modern, mechanical deltas only):
//   - email_notifications: Legacy truncated to column caps before insert
//     (mb_substr); the migration CHECKs REJECT over-length instead — loud,
//     not silent. sent_at/failed_at set from status exactly like Legacy's
//     repository. The users FK replaces Legacy's manual SELECT-1 owner check.
//   - user_devices: Legacy checked existence with SELECT then INSERT/UPDATE —
//     a race two concurrent logins could turn into two "new device" rows.
//     Modern inserts with ON CONFLICT DO UPDATE: the row-count/fingerprint
//     constraint decides, so exactly one winner reports "new".
//   - user_achievements: UNIQUE(user_id, achievement_key) makes unlock
//     idempotent at the boundary; the exists() probe stays (cheap, and the
//     domain decision needs it) but ON CONFLICT DO NOTHING closes the race.
//
// Write policy mirrors the ports: log() and recordAndCheckNewDevice() never
// throw (fail-open); achievements surface errors to the domain's fail-silent
// unlock.

import type { Pool } from "pg";
import type { AchievementStore, UnlockedAchievement } from "@velora/domain";
import {
  deviceFingerprint,
  type DeviceRegistry,
  type EmailNotificationLog,
  type EmailNotificationLogEntry,
  type EmailNotificationLogRow,
} from "./notificationStores.js";

function pgIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class PgEmailNotificationLog implements EmailNotificationLog {
  constructor(private readonly pool: Pool) {}

  async log(entry: EmailNotificationLogEntry, now: Date): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO email_notifications
           (user_id, event_type, recipient_email, subject, payload_json, status, sent_at, failed_at, error_message, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          entry.userId,
          entry.eventType,
          entry.recipientEmail,
          entry.subject,
          entry.payload === null || entry.payload === undefined
            ? null
            : JSON.stringify(entry.payload),
          entry.status,
          entry.status === "sent" ? now : null,
          entry.status === "failed" ? now : null,
          entry.errorMessage,
          now,
        ],
      );
    } catch (err) {
      // Fail-open: the delivery already happened (or failed) — the log must
      // never break the flow that produced it. Legacy swallowed the same way.
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "email_notification.log_failed",
          eventType: entry.eventType,
          status: entry.status,
        }),
      );
      void err;
    }
  }

  async recentForUser(
    userId: string,
    limit = 25,
  ): Promise<EmailNotificationLogRow[]> {
    const res = await this.pool.query(
      `SELECT id, user_id, event_type, recipient_email, subject, status, error_message, created_at
         FROM email_notifications WHERE user_id = $1
         ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return res.rows.map(
      (r: Record<string, unknown>): EmailNotificationLogRow => ({
        id: String(r["id"]),
        userId: String(r["user_id"]),
        eventType: r["event_type"] as EmailNotificationLogRow["eventType"],
        recipientEmail: String(r["recipient_email"]),
        subject: String(r["subject"]),
        status: r["status"] as EmailNotificationLogRow["status"],
        errorMessage: r["error_message"] === null ? null : String(r["error_message"]),
        createdAt: pgIso(r["created_at"] as Date | string),
      }),
    );
  }
}

export class PgDeviceRegistry implements DeviceRegistry {
  constructor(private readonly pool: Pool) {}

  async recordAndCheckNewDevice(
    userId: string,
    ip: string | null | undefined,
    userAgent: string | null | undefined,
  ): Promise<boolean> {
    try {
      const ipStr = (ip ?? "0.0.0.0").trim().slice(0, 45) || "0.0.0.0";
      const uaStr =
        ((userAgent ?? "").trim() || "Unknown Device").slice(0, 250);
      const fingerprint = deviceFingerprint(ipStr, uaStr);

      // INSERT ... ON CONFLICT DO NOTHING: a returned row ⇔ first sighting
      // (new device). No row ⇔ fingerprint known — update last_seen after.
      // This replaces Legacy's racy SELECT-then-INSERT with a single atomic
      // decision per fingerprint.
      const inserted = await this.pool.query(
        `INSERT INTO user_devices (user_id, fingerprint, ip_address, user_agent, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, now(), now())
         ON CONFLICT (user_id, fingerprint) DO NOTHING
         RETURNING 1`,
        [userId, fingerprint, ipStr, uaStr],
      );
      if (inserted.rows.length > 0) return true;

      await this.pool.query(
        `UPDATE user_devices SET last_seen_at = now(), ip_address = $2, user_agent = $3
          WHERE user_id = $1 AND fingerprint = $4`,
        [userId, ipStr, uaStr, fingerprint],
      );
      return false;
    } catch {
      return false; // Legacy parity: never block login on tracking failure.
    }
  }
}

export class PgAchievementStore implements AchievementStore {
  constructor(private readonly pool: Pool) {}

  async exists(userId: string, achievementKey: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM user_achievements WHERE user_id = $1 AND achievement_key = $2 LIMIT 1`,
      [userId, achievementKey],
    );
    return res.rows.length > 0;
  }

  async insert(entry: UnlockedAchievement): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_achievements (user_id, achievement_key, achieved_at, metadata_json)
       VALUES ($1, $2, $3::timestamptz, $4::jsonb)
       ON CONFLICT (user_id, achievement_key) DO NOTHING`,
      [
        entry.userId,
        entry.achievementKey,
        entry.achievedAt.replace(" ", "T") + "Z", // 'YYYY-MM-DD HH:MM:SS' UTC → timestamptz
        entry.metadataJson,
      ],
    );
  }

  async list(userId: string): Promise<UnlockedAchievement[]> {
    const res = await this.pool.query(
      `SELECT user_id, achievement_key, achieved_at, metadata_json
         FROM user_achievements WHERE user_id = $1
         ORDER BY achieved_at DESC`,
      [userId],
    );
    return res.rows.map(
      (r: Record<string, unknown>): UnlockedAchievement => ({
        userId: String(r["user_id"]),
        achievementKey: String(r["achievement_key"]),
        achievedAt: pgIso(r["achieved_at"] as Date | string).slice(0, 19).replace("T", " "),
        metadataJson:
          r["metadata_json"] === null || r["metadata_json"] === undefined
            ? ""
            : JSON.stringify(r["metadata_json"]),
      }),
    );
  }
}
