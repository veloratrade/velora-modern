// PGlite battery for AC-46 — effectiveConfig, diagnostics, activity, refresh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
import { PgAdminConsoleStore } from "../../apps/api/src/admin/adminConsoleStore.js";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

test("PGlite: adminDiagnostics (effectiveConfig + diagnostics + refresh + activity)", async () => {
  const engine = await createEngine();
  await migrate(engine, MIGRATIONS);
  const q = async (sql: string, params?: unknown[]) => (await engine.query(sql, params)).rows as Record<string, unknown>[];
  try {
    const store = new PgAdminConsoleStore(q as never, null);
    const cfg = await store.effectiveConfig();
    assert.ok(Array.isArray(cfg.providers));
    assert.equal(cfg.globalRoute.effective, "direct");
    assert.equal(cfg.globalRoute.source, "default");
    assert.ok(typeof cfg.precedence.credential === "string");

    const snap = await store.diagnostics();
    assert.equal(snap.components.length, 8);
    const db = snap.components.find((c) => c.component === "database")!;
    assert.equal(db.status, "HEALTHY");

    await store.refreshIntegrationHealth("metaapi", "HEALTHY", 42, null, null);
    await store.refreshIntegrationHealth("email", "NOT_CONFIGURED", 0, "NOT_CONFIGURED", "not configured");
    const snap2 = await store.diagnostics();
    const meta = snap2.components.find((c) => c.component === "metaapi")!;
    assert.equal(meta.status, "HEALTHY");
    assert.equal(meta.latencyMs, 42);

    const rows = await q("INSERT INTO users (email, password_hash) VALUES ($1,'hash') RETURNING id", [
      `pglite-activity-${Date.now()}@velora.test`,
    ]);
    const uid = String(rows[0]!.id);
    await q("INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1,'h1','1.1.1.1','UA/1', now() + interval '1 day')", [uid]);
    await q("INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1,'h2','2.2.2.2','UA/2', now() + interval '1 day')", [uid]);
    const rev = await q("INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1,'h3','3.3.3.3','UA/3', now() + interval '1 day') RETURNING id", [uid]);
    const rid = String(rev[0]!.id);
    await q("UPDATE user_sessions SET revoked_at = now() WHERE id = $1", [rid]);
    const p1 = await store.userActivity(uid, 2, 0);
    assert.equal(p1.total, 3);
    assert.equal(p1.items.length, 2);
    assert.equal(p1.items[0]!.event, "session.revoked");
    const p2 = await store.userActivity(uid, 2, 2);
    assert.equal(p2.items.length, 1);
  } finally {
    await engine.close();
  }
});
