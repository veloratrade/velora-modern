// Real-PostgreSQL battery for AC-46 — effectiveConfig, diagnostics, activity, refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { prepareDatabase } from "./support/pgTestDb.ts";
import { PgAdminConsoleStore } from "../../apps/api/src/admin/adminConsoleStore.js";
import type { QueryFn } from "../../apps/api/src/persistence/pg.js";

const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)" : false;

const q = (pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }): QueryFn =>
  (async (sql: string, params?: unknown[]) => (await pool.query(sql, params as unknown[] | undefined)).rows) as unknown as QueryFn;

test("PG: effectiveConfig returns secret-free inventory with precedence", { skip: SKIP as never }, async () => {
  const db = await prepareDatabase(PG_URL!);
  try {
    const store = new PgAdminConsoleStore(q(db.pool), null);
    const cfg = await store.effectiveConfig();
    assert.ok(Array.isArray(cfg.providers));
    assert.ok(Array.isArray(cfg.features));
    // globalRoute must be direct by default
    assert.equal(cfg.globalRoute.effective, "direct");
    assert.equal(cfg.globalRoute.source, "default");
    assert.ok(cfg.precedence.credential.includes("encrypted"));
    // integrations defaults
    assert.equal(typeof cfg.integrations.metaapi.configured, "boolean");
    assert.equal(typeof cfg.integrations.email.configured, "boolean");
  } finally {
    await db.close();
  }
});

test("PG: diagnostics returns 8 components with latency and checkedAt", { skip: SKIP as never }, async () => {
  const db = await prepareDatabase(PG_URL!);
  try {
    const store = new PgAdminConsoleStore(q(db.pool), null);
    const snap = await store.diagnostics();
    assert.ok(typeof snap.checkedAt === "string");
    assert.equal(snap.components.length, 8);
    const names = snap.components.map((c) => c.component);
    for (const n of ["api", "database", "redis", "workers", "metaapi", "n8n_relay", "ai", "email"]) assert.ok(names.includes(n));
    const dbComp = snap.components.find((c) => c.component === "database")!;
    assert.equal(dbComp.status, "HEALTHY");
    assert.ok(typeof dbComp.latencyMs === "number");
    assert.ok(dbComp.latencyMs! >= 0);
    const redis = snap.components.find((c) => c.component === "redis")!;
    assert.equal(redis.status, "NOT_APPLICABLE");
  } finally {
    await db.close();
  }
});

test("PG: refreshIntegrationHealth persists and diagnostics reflects it", { skip: SKIP as never }, async () => {
  const db = await prepareDatabase(PG_URL!);
  try {
    const store = new PgAdminConsoleStore(q(db.pool), null);
    await store.refreshIntegrationHealth("metaapi", "HEALTHY", 42, null, null);
    await store.refreshIntegrationHealth("email", "NOT_CONFIGURED", 0, "NOT_CONFIGURED", "Email not configured.");
    const snap = await store.diagnostics();
    const meta = snap.components.find((c) => c.component === "metaapi")!;
    assert.equal(meta.status, "HEALTHY");
    assert.equal(meta.latencyMs, 42);
    const email = snap.components.find((c) => c.component === "email")!;
    assert.equal(email.status, "NOT_CONFIGURED");
    assert.equal(email.errorCode, "NOT_CONFIGURED");
  } finally {
    await db.close();
  }
});

test("PG: userActivity paginates revoked vs active correctly", { skip: SKIP as never }, async () => {
  const db = await prepareDatabase(PG_URL!);
  try {
    const pool = db.pool;
    const userRes = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1,'hash') RETURNING id", [
      `activity-${process.pid}-${Date.now()}@velora.test`,
    ]);
    const uid = String(userRes.rows[0]!.id);
    // create 3 sessions: 2 active, 1 revoked
    await pool.query("INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1,'h1','1.1.1.1','UA/1', now() + interval '1 day')", [uid]);
    await pool.query("INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1,'h2','2.2.2.2','UA/2', now() + interval '1 day')", [uid]);
    const revokedRes = await pool.query(
      "INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1,'h3','3.3.3.3','UA/3', now() + interval '1 day') RETURNING id",
      [uid],
    );
    const revokedId = String(revokedRes.rows[0]!.id);
    await pool.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", [revokedId]);
    const store = new PgAdminConsoleStore(q(pool), null);
    const page1 = await store.userActivity(uid, 2, 0);
    assert.equal(page1.total, 3);
    assert.equal(page1.items.length, 2);
    // most recent is revoked one (id desc)
    assert.equal(page1.items[0]!.event, "session.revoked");
    assert.equal(page1.items[0]!.result, "revoked");
    assert.equal(page1.items[0]!.ip, "3.3.3.3");
    const page2 = await store.userActivity(uid, 2, 2);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0]!.event, "session.created");
  } finally {
    await db.close();
  }
});
