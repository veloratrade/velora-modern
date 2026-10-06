// PGlite tests — the MG-EMAIL-TYPES stores against real PostgreSQL semantics
// (migration 0030). Dev/test evidence only (ADR-010).
//
// Guards:
//   - email_notifications: sent/failed rows round-trip; the CHECK list holds;
//     recentForUser orders newest-first
//   - user_devices: first sighting inserts (new device), repeat updates
//     last_seen without a second row (the Legacy race closed by constraint)
//   - user_achievements: UNIQUE makes unlock idempotent at the boundary;
//     listForUser ordering matches the domain port

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
import {
  PgEmailNotificationLog,
  PgDeviceRegistry,
  PgAchievementStore,
} from "../../apps/api/src/notifications/pgNotificationStores.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

async function freshUser(engine: Awaited<ReturnType<typeof createEngine>>, n: number): Promise<string> {
  await engine.query(
    "INSERT INTO users(email, password_hash, full_name) VALUES ($1,$2,$3)",
    [`u${n}@velora.test`, "x", `User ${n}`],
  );
  const res = await engine.query(`SELECT id FROM users WHERE email = $1`, [`u${n}@velora.test`]);
  return String((res.rows[0] as Record<string, unknown>)["id"]);
}

test("email_notifications: outcomes round-trip; event-type CHECK holds; newest-first", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await freshUser(engine, 1);
    const log = new PgEmailNotificationLog(engine as never);

    await log.log(
      { userId: uid, eventType: "VERIFICATION_EMAIL", recipientEmail: "u1@velora.test",
        subject: "s1", status: "sent", errorMessage: null },
      new Date("2026-10-06T10:00:00Z"),
    );
    await log.log(
      { userId: uid, eventType: "PASSWORD_CHANGED", recipientEmail: "u1@velora.test",
        subject: "s2", status: "failed", errorMessage: "rejected" },
      new Date("2026-10-06T11:00:00Z"),
    );

    const rows = await log.recentForUser(uid);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.subject, "s2"); // newest first
    assert.equal(rows[0]!.status, "failed");
    assert.equal(rows[0]!.errorMessage, "rejected");
    assert.equal(rows[1]!.status, "sent");
    assert.equal(rows[1]!.eventType, "VERIFICATION_EMAIL");

    // The log is FAIL-OPEN by contract (a bookkeeping failure must never
    // break the flow that sent the mail), so invalid writes are swallowed —
    // the proof is the table state, not a rejection:
    //   - an unknown event type is rejected by the CHECK (closed legacy list)
    //   - a row for a non-existent user is rejected by the FK
    await log.log(
      { userId: uid, eventType: "NOT_A_LEGACY_TYPE" as never, recipientEmail: "x@x.test",
        subject: "s", status: "sent", errorMessage: null },
      new Date(),
    );
    await log.log(
      { userId: "999999", eventType: "WELCOME_EMAIL", recipientEmail: "x@x.test",
        subject: "s", status: "sent", errorMessage: null },
      new Date(),
    );
    const still = await log.recentForUser(uid);
    assert.equal(still.length, 2, "invalid writes landed nowhere");
    const ghost = await log.recentForUser("999999");
    assert.equal(ghost.length, 0);
  } finally {
    await engine.close();
  }
});

test("user_devices: first sighting = new device, repeat = same row updated", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await freshUser(engine, 2);
    const reg = new PgDeviceRegistry(engine as never);

    assert.equal(await reg.recordAndCheckNewDevice(uid, "5.6.7.8", "Firefox/1.0"), true);
    assert.equal(await reg.recordAndCheckNewDevice(uid, "5.6.7.8", "Firefox/1.0"), false);
    assert.equal(await reg.recordAndCheckNewDevice(uid, "9.9.9.9", "Firefox/1.0"), true);

    const rows = await engine.query(
      "SELECT fingerprint, ip_address FROM user_devices WHERE user_id = $1 ORDER BY id",
      [uid],
    );
    assert.equal(rows.rows.length, 2, "exactly one row per fingerprint");
    // a null IP degrades to the legacy 0.0.0.0 convention
    assert.equal(await reg.recordAndCheckNewDevice(uid, null, "UA"), true);
    const fp = await engine.query(
      "SELECT ip_address FROM user_devices WHERE user_id = $1 AND ip_address = '0.0.0.0'",
      [uid],
    );
    assert.equal(fp.rows.length, 1);
  } finally {
    await engine.close();
  }
});

test("user_achievements: UNIQUE closes the double-unlock race; list is newest-first", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await freshUser(engine, 3);
    const store = new PgAchievementStore(engine as never);

    assert.equal(await store.exists(uid, "FIRST_TRADE"), false);
    await store.insert({
      userId: uid, achievementKey: "FIRST_TRADE",
      achievedAt: "2026-10-06 10:00:00",
      metadataJson: JSON.stringify({ titleKey: "achievements.firstTrade.title", descriptionKey: "achievements.firstTrade.description", unlockedAt: "2026-10-06T10:00:00+00:00" }),
    });
    assert.equal(await store.exists(uid, "FIRST_TRADE"), true);
    // the race-closing re-insert is a no-op, not an error
    await store.insert({
      userId: uid, achievementKey: "FIRST_TRADE",
      achievedAt: "2026-10-06 12:00:00", metadataJson: "{}",
    });
    await store.insert({
      userId: uid, achievementKey: "EMAIL_VERIFIED",
      achievedAt: "2026-10-06 11:00:00", metadataJson: "{}",
    });
    const list = await store.list(uid);
    assert.equal(list.length, 2);
    assert.equal(list[0]!.achievementKey, "EMAIL_VERIFIED"); // 11:00 > 10:00
    // metadata survives the JSONB round-trip
    assert.ok(list[1]!.metadataJson.includes("firstTrade"));
  } finally {
    await engine.close();
  }
});
