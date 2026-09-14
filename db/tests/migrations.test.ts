// Migration execution test — runs the real migration files against a
// DISPOSABLE PGlite instance (real PostgreSQL semantics in-wasm).
// This is dev/test evidence ONLY — it is NOT production hosting evidence
// (Gate 3B stays BLOCKED 0/20; ADR-010; governance 2026-08-31).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createEngine, migrate } from "../migrate.ts";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

test("migrations apply cleanly and are idempotent (forward-only)", async () => {
  const engine = await createEngine();
  try {
    const ran = await migrate(engine, MIGRATIONS);
    assert.ok(ran.includes("0001_core.sql"));
    const reran = await migrate(engine, MIGRATIONS);
    assert.deepEqual(reran, []); // nothing reapplied
  } finally { await engine.close(); }
});

test("canonical email: write-time canonicalization + plain UNIQUE (ADR-003/D-02)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    await engine.query(
      "INSERT INTO users(email, password_hash) VALUES ($1,$2)", ["owner@velora.ir", "x"]);
    // exact duplicates are rejected by the DB constraint…
    await assert.rejects(
      engine.query("INSERT INTO users(email, password_hash) VALUES ($1,$2)", ["owner@velora.ir", "y"]),
      /duplicate key|unique/i,
    );
    // …mixed-case input converges to the canonical form BEFORE the write,
    // so it must also collide (application-layer canonicalization is the gate).
    const { canonicalEmail } = await import("@velora/contracts");
    const canonical = canonicalEmail("  Owner@Velora.IR ");
    assert.equal(canonical, "owner@velora.ir");
    await assert.rejects(
      engine.query("INSERT INTO users(email, password_hash) VALUES ($1,$2)", [canonical, "y"]),
      /duplicate key|unique/i,
    );
  } finally { await engine.close(); }
});

test("trades: timestamptz + ADR-001 scales + external-id idempotency (ADR-002)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const { rows } = await engine.query(`SELECT
        data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_name='trades' AND column_name='entry_price'`);
    assert.equal(rows[0]!.data_type, "numeric");
    assert.equal(String(rows[0]!.numeric_precision), "20");
    assert.equal(String(rows[0]!.numeric_scale), "8");
    const ts = (await engine.query(`SELECT data_type FROM information_schema.columns
      WHERE table_name='trades' AND column_name='occurred_at'`)).rows[0]!;
    assert.equal(ts.data_type, "timestamp with time zone"); // ADR-004

    const u = (await engine.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id", ["t@t.ir","x"])).rows[0]!;
    const a = (await engine.query(
      "INSERT INTO trading_accounts(user_id, external_account_id) VALUES($1,$2) RETURNING id",
      [u.id, "ACC-1"])).rows[0]!;
    await engine.query(`INSERT INTO trades(user_id, account_id, external_deal_id, symbol,
        direction, entry_price, volume, occurred_at)
      VALUES($1,$2,'D-1','XAUUSD','buy',$3,$4, now())`, [u.id, a.id, "2350.50000000", "1.00000000"]);
    // duplicate (account, external_deal_id) converges instead of double-counting
    await assert.rejects(
      engine.query(`INSERT INTO trades(user_id, account_id, external_deal_id, symbol,
          direction, entry_price, volume, occurred_at)
        VALUES($1,$2,'D-1','XAUUSD','buy',$3,$4, now())`, [u.id, a.id, "2350.00000000", "1.00000000"]),
      /duplicate key|unique/i,
    );
  } finally { await engine.close(); }
});

test("exit over-allocation is rejected at the DB level (ADR-002)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const u = (await engine.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id", ["a@a.ir","x"])).rows[0]!;
    const t = (await engine.query(`INSERT INTO trades(user_id, symbol, direction, entry_price,
        volume, occurred_at) VALUES($1,'EURUSD','buy',$2,$3, now()) RETURNING id`,
      [u.id, "1.08500000", "2.00000000"])).rows[0]!;
    await engine.query("INSERT INTO trade_exits(trade_id, volume, price) VALUES($1,$2,$3)",
      [t.id, "1.50000000", "1.08800000"]);
    await assert.rejects(
      engine.query("INSERT INTO trade_exits(trade_id, volume, price) VALUES($1,$2,$3)",
        [t.id, "0.50000001", "1.09000000"]),
      /over-allocation/i,
    );
  } finally { await engine.close(); }
});

test("webhook_events dedupe on (source, event_id) (ADR-008)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    await engine.query("INSERT INTO webhook_events(source, event_id, payload) VALUES($1,$2,$3)",
      ["metaapi", "evt-1", JSON.stringify({ a: 1 })]);
    await assert.rejects(
      engine.query("INSERT INTO webhook_events(source, event_id, payload) VALUES($1,$2,$3)",
        ["metaapi", "evt-1", JSON.stringify({ a: 1 })]),
      /duplicate key|unique/i,
    );
  } finally { await engine.close(); }
});

test("0006 RBAC: users.role CHECK admits the three OD-9 roles, rejects anything else", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    // Every frozen application role is storable…
    for (const role of ["user", "admin", "super_admin"]) {
      await engine.query(
        "INSERT INTO users(email, password_hash, role) VALUES ($1,'x',$2)",
        [`${role}@rbac.example`, role],
      );
    }
    const rows = await engine.query("SELECT role FROM users ORDER BY role");
    assert.deepEqual((rows.rows as { role: string }[]).map((r) => r.role),
      ["admin", "super_admin", "user"]);

    // …and anything outside the frozen set is rejected by the DATABASE,
    // independently of application-layer validation (defence in depth).
    for (const bad of ["root", "owner", "guest", "SUPER_ADMIN", "velora_owner", ""]) {
      await assert.rejects(
        engine.query("INSERT INTO users(email, password_hash, role) VALUES ($1,'x',$2)",
          [`bad-${bad}@rbac.example`, bad]),
        /violates check constraint|users_role_check/i,
        `role '${bad}' must be rejected by the CHECK`,
      );
    }

    // The default is unchanged — a new row without an explicit role is 'user'.
    await engine.query("INSERT INTO users(email, password_hash) VALUES ('default@rbac.example','x')");
    const def = await engine.query("SELECT role FROM users WHERE email = 'default@rbac.example'");
    assert.equal((def.rows as { role: string }[])[0]!.role, "user");
  } finally { await engine.close(); }
});

test("0006 RBAC: pre-existing user/admin rows survive the CHECK widening", async () => {
  const engine = await createEngine();
  try {
    // Apply 0001 ONLY (the narrow CHECK), seed rows exactly as they would
    // already exist in a database predating Phase 3B-3...
    await engine.exec(readFileSync(join(MIGRATIONS, "0001_core.sql"), "utf8"));
    await engine.query("INSERT INTO users(email, password_hash, role) VALUES ('legacy-user@rbac.example','x','user')");
    await engine.query("INSERT INTO users(email, password_hash, role) VALUES ('legacy-admin@rbac.example','x','admin')");
    // ...the narrow CHECK genuinely rejects super_admin at this point:
    await assert.rejects(
      engine.query("INSERT INTO users(email, password_hash, role) VALUES ('pre@rbac.example','x','super_admin')"),
      /violates check constraint/i,
      "0001 must reject super_admin (this is the gap 0006 closes)",
    );

    // ...now apply ONLY the widening statement from 0006.
    await engine.exec(readFileSync(join(MIGRATIONS, "0006_rbac_roles.sql"), "utf8"));

    // Existing rows are untouched and still valid.
    const rows = await engine.query(
      "SELECT email, role FROM users WHERE email LIKE 'legacy-%' ORDER BY email");
    assert.deepEqual((rows.rows as { email: string; role: string }[]).map((r) => r.role),
      ["admin", "user"], "pre-existing rows must remain exactly as they were");
    // And the previously-rejected value is now accepted.
    await engine.query("INSERT INTO users(email, password_hash, role) VALUES ('post@rbac.example','x','super_admin')");
    const after = await engine.query("SELECT role FROM users WHERE email = 'post@rbac.example'");
    assert.equal((after.rows as { role: string }[])[0]!.role, "super_admin");
  } finally { await engine.close(); }
});

test("0007 status: the CHECK constrains account state and preserves existing rows", async () => {
  const engine = await createEngine();
  try {
    // Apply the full stack; 0007 is part of it.
    await migrate(engine, MIGRATIONS);

    // Both frozen states are accepted...
    for (const good of ["active", "suspended"]) {
      await engine.query(
        "INSERT INTO users(email, password_hash, status) VALUES ($1,'x',$2)",
        [`ok-${good}@status.example`, good],
      );
    }
    // ...and everything else is rejected by the DATABASE. This column gates
    // authentication (login and refresh both require 'active'), so a typo must
    // not be silently storable.
    for (const bad of ["deleted", "banned", "Active", "ACTIVE", "pending", ""]) {
      await assert.rejects(
        engine.query("INSERT INTO users(email, password_hash, status) VALUES ($1,'x',$2)",
          [`bad-${bad}@status.example`, bad]),
        /violates check constraint|users_status_check/i,
        `status '${bad}' must be rejected by the CHECK`,
      );
    }

    // The default is unchanged — a new row without an explicit status is active.
    await engine.query("INSERT INTO users(email, password_hash) VALUES ('default@status.example','x')");
    const def = await engine.query("SELECT status FROM users WHERE email = 'default@status.example'");
    assert.equal((def.rows as { status: string }[])[0]!.status, "active");
  } finally { await engine.close(); }
});

test("0007 status: rows predating the constraint survive it", async () => {
  const engine = await createEngine();
  try {
    // Apply 0001 + 0002 only: `status` exists but is UNCONSTRAINED.
    await engine.exec(readFileSync(join(MIGRATIONS, "0001_core.sql"), "utf8"));
    await engine.exec(readFileSync(join(MIGRATIONS, "0002_identity_capability.sql"), "utf8"));
    await engine.query("INSERT INTO users(email, password_hash, status) VALUES ('pre-active@status.example','x','active')");
    await engine.query("INSERT INTO users(email, password_hash) VALUES ('pre-default@status.example','x')");
    // At this point an arbitrary value IS storable — the gap 0007 closes.
    await engine.query("INSERT INTO users(email, password_hash, status) VALUES ('pre-bogus@status.example','x','whatever')");
    await engine.query("DELETE FROM users WHERE email = 'pre-bogus@status.example'");

    await engine.exec(readFileSync(join(MIGRATIONS, "0007_user_status.sql"), "utf8"));

    const rows = await engine.query(
      "SELECT email, status FROM users WHERE email LIKE 'pre-%' ORDER BY email");
    assert.deepEqual((rows.rows as { email: string; status: string }[]).map((r) => r.status),
      ["active", "active"], "pre-existing rows must remain exactly as they were");

    // Re-running the migration is idempotent.
    await engine.exec(readFileSync(join(MIGRATIONS, "0007_user_status.sql"), "utf8"));
    await assert.rejects(
      engine.query("INSERT INTO users(email, password_hash, status) VALUES ('after@status.example','x','deleted')"),
      /violates check constraint/i,
    );
  } finally { await engine.close(); }
});

test("0008 ownership: the installation ownership row is a DATABASE-enforced singleton", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    await engine.query("INSERT INTO users(email, password_hash, role) VALUES ('owner@own.example','x','admin')");
    await engine.query("INSERT INTO users(email, password_hash, role) VALUES ('other@own.example','x','admin')");
    const ids = await engine.query("SELECT id FROM users WHERE email LIKE '%@own.example' ORDER BY id");
    const [a, b] = (ids.rows as { id: string | number }[]).map((r) => String(r.id));

    // First claim succeeds.
    await engine.query(
      "INSERT INTO installation_ownership(owner_user_id, claimed_by_user_id) VALUES ($1,$1)", [a]);

    // A SECOND claim is impossible — the singleton PK rejects it. This is the
    // guarantee the application relies on for concurrent claims.
    await assert.rejects(
      engine.query("INSERT INTO installation_ownership(owner_user_id, claimed_by_user_id) VALUES ($1,$1)", [b]),
      /duplicate key|unique/i,
      "a second ownership row must be impossible",
    );

    // Even explicitly forcing id=FALSE is rejected by the CHECK.
    await assert.rejects(
      engine.query("INSERT INTO installation_ownership(id, owner_user_id, claimed_by_user_id) VALUES (FALSE,$1,$1)", [b]),
      /violates check constraint/i,
      "the singleton key must be pinned to TRUE",
    );

    const rows = await engine.query("SELECT owner_user_id FROM installation_ownership");
    assert.equal(rows.rows.length, 1, "exactly one ownership row may exist");
  } finally { await engine.close(); }
});

test("0008 ownership: the owner's user row cannot be deleted (ON DELETE RESTRICT)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    await engine.query("INSERT INTO users(email, password_hash, role) VALUES ('keep@own.example','x','admin')");
    const got = await engine.query("SELECT id FROM users WHERE email = 'keep@own.example'");
    const id = String((got.rows as { id: string | number }[])[0]!.id);
    await engine.query(
      "INSERT INTO installation_ownership(owner_user_id, claimed_by_user_id) VALUES ($1,$1)", [id]);

    // RESTRICT guarantees the referenced ROW cannot be deleted while referenced.
    // NOTE: this says nothing about suspension or role change, which remain
    // ordinary account-state operations.
    await assert.rejects(
      engine.query("DELETE FROM users WHERE id = $1", [id]),
      /violates RESTRICT setting|violates foreign key constraint|still referenced/i,
      "the owner's user row must not be deletable while ownership references it",
    );
    const still = await engine.query("SELECT COUNT(*)::int AS n FROM installation_ownership");
    assert.equal((still.rows as { n: number }[])[0]!.n, 1);
  } finally { await engine.close(); }
});

test("0008 ownership: ownership does NOT widen the RBAC role constraint", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    // 'system_owner' is NOT a role. The 0006 CHECK must still reject it, which
    // is what makes ownership unreachable through role assignment.
    await assert.rejects(
      engine.query("INSERT INTO users(email, password_hash, role) VALUES ('so@own.example','x','system_owner')"),
      /violates check constraint|users_role_check/i,
      "system_owner must never be a valid users.role value",
    );
  } finally { await engine.close(); }
});
