// Notification stores — ports + in-memory adapters (MG-EMAIL-TYPES, AC-33).
//
// Three persistence concerns back the transactional-email capability:
//   EmailNotificationLog — the delivery log (Legacy email_notifications via
//                          EmailNotificationRepository::log; every attempt
//                          recorded with its honest outcome)
//   DeviceRegistry       — Legacy UserDeviceRepository::recordAndCheckNewDevice
//                          (sha256(ip|ua) fingerprint; first sighting ⇒ alert)
//   AchievementStore     — the IO port the DOMAIN achievements engine already
//                          defines (packages/domain/src/achievements.ts) —
//                          implemented here, never re-modeled.
//
// Ports are minimal; PG adapters live in pgNotificationStores.ts; memory
// adapters here keep services testable with zero infrastructure. Write
// policies follow Legacy: the LOG and DEVICE writes are fail-open (a
// notification bookkeeping failure must never break the business flow that
// triggered the email), and the achievement unlock is fail-silent IN THE
// DOMAIN (unlockAchievement catch) — the store itself surfaces errors.

import { createHash } from "node:crypto";
import type { AchievementStore, UnlockedAchievement } from "@velora/domain";

/** Legacy's ten event types — the CHECK list of migration 0030, verbatim. */
export type EmailEventType =
  | "VERIFICATION_EMAIL"
  | "WELCOME_EMAIL"
  | "PASSWORD_RESET_LINK"
  | "ADMIN_INVITE"
  | "PASSWORD_CHANGED"
  | "NEW_DEVICE_DETECTED"
  | "FIRST_TRADE_RECORDED"
  | "ACHIEVEMENT_UNLOCKED"
  | "SUPPORT_NEW_TICKET"
  | "SUPPORT_FIRST_REPLY";

export interface EmailNotificationLogEntry {
  readonly userId: string;
  readonly eventType: EmailEventType;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly status: "sent" | "failed";
  readonly errorMessage: string | null;
  readonly payload?: Readonly<Record<string, unknown>> | null;
}

export interface EmailNotificationLog {
  /** Record one delivery attempt. MUST NOT throw (fail-open, Legacy parity). */
  log(entry: EmailNotificationLogEntry, now: Date): Promise<void>;
}

/** One row of the delivery log (read side — admin/diagnostics). */
export interface EmailNotificationLogRow {
  readonly id: string;
  readonly userId: string;
  readonly eventType: EmailEventType;
  readonly recipientEmail: string;
  readonly subject: string;
  readonly status: "sent" | "failed" | "queued";
  readonly errorMessage: string | null;
  readonly createdAt: string;
}

export interface DeviceRegistry {
  /**
   * Record (ip, userAgent) for the user; true when this is the FIRST sighting
   * of the fingerprint (new device), false when known (updates last_seen).
   * MUST NOT throw — Legacy returned false on any storage failure, so a
   * device-tracking hiccup can never block login.
   */
  recordAndCheckNewDevice(
    userId: string,
    ip: string | null | undefined,
    userAgent: string | null | undefined,
  ): Promise<boolean>;
}

/** sha256(ip|ua) — Legacy UserDeviceRepository's exact fingerprint. */
export function deviceFingerprint(ip: string, userAgent: string): string {
  return createHash("sha256").update(`${ip}|${userAgent}`, "utf8").digest("hex");
}

// --- in-memory adapters (tests + offline boot) -------------------------------

export class MemoryEmailNotificationLog implements EmailNotificationLog {
  private readonly rows: EmailNotificationLogEntry[] = [];
  /** Surfaces unexpected adapter failures in tests; production PG adapter logs. */
  public failureCount = 0;

  async log(entry: EmailNotificationLogEntry, _now: Date): Promise<void> {
    this.rows.push(entry);
  }

  get entries(): readonly EmailNotificationLogEntry[] {
    return this.rows;
  }

  count(eventType?: EmailEventType): number {
    return this.rows.filter((r) => eventType === undefined || r.eventType === eventType).length;
  }
}

export class MemoryDeviceRegistry implements DeviceRegistry {
  private readonly seen = new Map<string, { ip: string; ua: string }>();

  async recordAndCheckNewDevice(
    userId: string,
    ip: string | null | undefined,
    userAgent: string | null | undefined,
  ): Promise<boolean> {
    const ipStr = (ip ?? "0.0.0.0").trim().slice(0, 45);
    const uaStr = ((userAgent ?? "Unknown Device").trim() || "Unknown Device").slice(0, 250);
    const fingerprint = deviceFingerprint(ipStr, uaStr);
    const key = `${userId}:${fingerprint}`;
    if (this.seen.has(key)) {
      this.seen.set(key, { ip: ipStr, ua: uaStr });
      return false;
    }
    this.seen.set(key, { ip: ipStr, ua: uaStr });
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export class MemoryAchievementStore implements AchievementStore {
  private readonly rows = new Map<string, UnlockedAchievement>();

  async exists(userId: string, achievementKey: string): Promise<boolean> {
    return this.rows.has(`${userId}:${achievementKey}`);
  }

  async insert(entry: UnlockedAchievement): Promise<void> {
    const key = `${entry.userId}:${entry.achievementKey}`;
    if (this.rows.has(key)) throw new Error("duplicate achievement unlock");
    this.rows.set(key, entry);
  }

  async list(userId: string): Promise<UnlockedAchievement[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => (a.achievedAt < b.achievedAt ? 1 : -1));
  }
}
