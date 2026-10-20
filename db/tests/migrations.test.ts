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
    // OPEN: this fixture proves the idempotency key, not financial completeness
    // (0025_trade_financial_guards refuses a CLOSED row with no exit/PnL/close).
    await engine.query(`INSERT INTO trades(user_id, account_id, external_deal_id, symbol,
        direction, status, entry_price, volume, occurred_at)
      VALUES($1,$2,'D-1','XAUUSD','buy','OPEN',$3,$4, now())`, [u.id, a.id, "2350.50000000", "1.00000000"]);
    // duplicate (account, external_deal_id) converges instead of double-counting
    await assert.rejects(
      engine.query(`INSERT INTO trades(user_id, account_id, external_deal_id, symbol,
          direction, status, entry_price, volume, occurred_at)
        VALUES($1,$2,'D-1','XAUUSD','buy','OPEN',$3,$4, now())`, [u.id, a.id, "2350.00000000", "1.00000000"]),
      /duplicate key|unique/i,
    );
  } finally { await engine.close(); }
});

test("exit over-allocation is rejected at the DB level (ADR-002)", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const u = (await engine.query("INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id", ["a@a.ir","x"])).rows[0]!;
    const t = (await engine.query(`INSERT INTO trades(user_id, symbol, direction, status, entry_price,
        volume, occurred_at) VALUES($1,'EURUSD','buy','OPEN',$2,$3, now()) RETURNING id`,
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

// --- 0010 user_credentials -------------------------------------------------
// These assert the ENCRYPTION ENVELOPE invariants at the database level, so a
// future change cannot quietly relax them. NOTE: this is PGlite (the existing
// convention for this file); the same constraints were additionally verified
// against real PostgreSQL 17.10 in db/tests/credentialStore.pg.test.ts.

const IV12 = "decode('000102030405060708090a0b','hex')";
const TAG16 = "decode('000102030405060708090a0b0c0d0e0f','hex')";
const CT = "decode('deadbeef','hex')";

async function seedCredUser(engine: Awaited<ReturnType<typeof createEngine>>, email: string) {
  await engine.query(`INSERT INTO users(email, password_hash, role) VALUES ('${email}','x','user')`);
  const got = await engine.query("SELECT id FROM users WHERE email = $1", [email]);
  const rows = got.rows as { id: string | number }[];
  assert.equal(rows.length, 1, "seed user must exist before the constraint is exercised");
  return String(rows[0]!.id);
}

test("0010 credentials: the DB refuses any row that is not a well-formed AES-256-GCM envelope", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await seedCredUser(engine, "cred@enc.example");
    const ins = (cols: string, vals: string) =>
      engine.query(`INSERT INTO user_credentials(user_id, ${cols}) VALUES (${uid}, ${vals})`);

    // A correct envelope is accepted.
    await ins("provider, key_version, iv, auth_tag, secret_ciphertext",
      `'METAAPI', 1, ${IV12}, ${TAG16}, ${CT}`);

    // A 12-byte IV is mandatory: GCM nonce misuse is catastrophic, so a
    // short/long nonce must be impossible to persist at all.
    await assert.rejects(
      ins("provider, key_version, iv, auth_tag, secret_ciphertext",
        `'METAAPI', 1, decode('0001','hex'), ${TAG16}, ${CT}`),
      /violates check constraint/i, "IV must be exactly 12 bytes");

    // A truncated auth tag would weaken forgery resistance.
    await assert.rejects(
      ins("provider, key_version, iv, auth_tag, secret_ciphertext",
        `'METAAPI', 1, ${IV12}, decode('0001','hex'), ${CT}`),
      /violates check constraint/i, "auth tag must be exactly 16 bytes");

    // Empty ciphertext would mean "a credential row holding no secret".
    await assert.rejects(
      ins("provider, key_version, iv, auth_tag, secret_ciphertext",
        `'METAAPI', 1, ${IV12}, ${TAG16}, decode('','hex')`),
      /violates check constraint/i, "ciphertext must be non-empty");

    // The algorithm is pinned: no downgrade to a weaker/unauthenticated cipher.
    await assert.rejects(
      ins("provider, key_version, iv, auth_tag, secret_ciphertext, algorithm",
        `'METAAPI', 1, ${IV12}, ${TAG16}, ${CT}, 'aes-256-cbc'`),
      /violates check constraint/i, "algorithm must stay aes-256-gcm");

    // key_version must be a real key generation (>= 1).
    await assert.rejects(
      ins("provider, key_version, iv, auth_tag, secret_ciphertext",
        `'METAAPI', 0, ${IV12}, ${TAG16}, ${CT}`),
      /violates check constraint/i, "key_version must be >= 1");

    // Unknown providers cannot be stored.
    await assert.rejects(
      ins("provider, key_version, iv, auth_tag, secret_ciphertext",
        `'SOMETHING_ELSE', 1, ${IV12}, ${TAG16}, ${CT}`),
      /violates check constraint/i, "provider is constrained to the known set");
  } finally { await engine.close(); }
});

test("0010 credentials: nonce reuse, duplicate provider rows, and owner deletion are all rejected", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const a = await seedCredUser(engine, "a@nonce.example");
    const b = await seedCredUser(engine, "b@nonce.example");
    await engine.query(
      `INSERT INTO user_credentials(user_id, provider, key_version, iv, auth_tag, secret_ciphertext)
       VALUES (${a}, 'METAAPI', 1, ${IV12}, ${TAG16}, ${CT})`);

    // Reusing an (iv, key_version) pair breaks AES-GCM's security proof. The DB
    // makes it impossible even ACROSS users, not merely within one account.
    await assert.rejects(
      engine.query(
        `INSERT INTO user_credentials(user_id, provider, key_version, iv, auth_tag, secret_ciphertext)
         VALUES (${b}, 'METAAPI', 1, ${IV12}, ${TAG16}, ${CT})`),
      /duplicate key|unique/i, "the same nonce must never be reused under one key");

    // One credential per (user, provider).
    await assert.rejects(
      engine.query(
        `INSERT INTO user_credentials(user_id, provider, key_version, iv, auth_tag, secret_ciphertext)
         VALUES (${a}, 'METAAPI', 1, decode('0f0e0d0c0b0a09080706050403','hex'), ${TAG16}, ${CT})`),
      /duplicate key|unique|violates check constraint/i, "one credential per user+provider");

    // RESTRICT: a user holding stored credentials cannot be deleted out from
    // under them, which would otherwise orphan undecryptable secret material.
    await assert.rejects(
      engine.query(`DELETE FROM users WHERE id = ${a}`),
      /violates RESTRICT setting|violates foreign key constraint|still referenced/i,
      "a user with stored credentials must not be deletable");
  } finally { await engine.close(); }
});

// --- 0011: audit contract extended for credential lifecycle events (B-2) ----

test("0011 audit: credential actions and both outcomes are accepted; invalid values are rejected", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await seedCredUser(engine, "audit0011@example.com");

    // The three pre-existing actions must remain valid after the CHECK swap.
    for (const action of ["OWNERSHIP_CLAIMED", "USER_ROLE_CHANGED", "USER_STATUS_CHANGED"]) {
      await engine.query(
        `INSERT INTO audit_log(action, actor_user_id) VALUES ('${action}', ${uid})`);
    }
    // The two new credential actions, with metadata.
    for (const action of ["CREDENTIAL_CREATED", "CREDENTIAL_DELETED"]) {
      await engine.query(
        `INSERT INTO audit_log(action, actor_user_id, credential_id, provider)
         VALUES ('${action}', ${uid}, 4242, 'METAAPI')`);
    }
    // Both outcomes.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, outcome) VALUES ('CREDENTIAL_CREATED', ${uid}, 'success')`);
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, outcome) VALUES ('CREDENTIAL_DELETED', ${uid}, 'denied')`);

    // Rejections: an unknown action, the deliberately-excluded reveal event,
    // an unknown outcome, and an unsupported provider.
    for (const [sql, label] of [
      [`INSERT INTO audit_log(action, actor_user_id) VALUES ('NOPE', ${uid})`, "unknown action"],
      [`INSERT INTO audit_log(action, actor_user_id) VALUES ('CREDENTIAL_REVEALED', ${uid})`, "reveal is not in the vocabulary"],
      [`INSERT INTO audit_log(action, actor_user_id, outcome) VALUES ('CREDENTIAL_CREATED', ${uid}, 'maybe')`, "unknown outcome"],
      [`INSERT INTO audit_log(action, actor_user_id, provider) VALUES ('CREDENTIAL_CREATED', ${uid}, 'BINANCE')`, "unknown provider"],
    ] as Array<[string, string]>) {
      await assert.rejects(engine.query(sql), /violates check constraint|check constraint/i, label);
    }
  } finally { await engine.close(); }
});

test("0011 audit: credential_id is a historical id with no FK, so history outlives the credential", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await seedCredUser(engine, "audit0011fk@example.com");

    // An id that never existed is accepted: there is no referential constraint.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, credential_id, provider)
       VALUES ('CREDENTIAL_DELETED', ${uid}, 999999999, 'METAAPI')`);

    // A real credential can be hard-deleted while its audit row survives.
    const ins = await engine.query(
      `INSERT INTO user_credentials(user_id, provider, key_version, iv, auth_tag, secret_ciphertext)
       VALUES (${uid}, 'METAAPI', 1, ${IV12}, ${TAG16}, ${CT}) RETURNING id`);
    const cid = String((ins.rows[0] as { id: string | number }).id);
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, credential_id, provider)
       VALUES ('CREDENTIAL_CREATED', ${uid}, ${cid}, 'METAAPI')`);
    await engine.query(`DELETE FROM user_credentials WHERE id = ${cid}`);

    const rows = await engine.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE credential_id = ${cid}`);
    assert.equal((rows.rows[0] as { n: number }).n, 1,
      "the audit row must survive deletion of the credential it describes");
  } finally { await engine.close(); }
});

// --- 0014: provisioning + binding contract (OD-MP-1 / OD-MP-2) --------------
// Same convention as the 0010/0011 blocks: these are PGlite assertions on the
// migration's own guarantees. The concurrency, cross-connection and
// hard-delete-durability proofs that PGlite cannot give are in
// db/tests/metaapiProvisioning.pg.test.ts against real PostgreSQL 17.10.

test("0014 audit: the two authorized actions are accepted and CREDENTIAL_REVEALED is still refused", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await seedCredUser(engine, "audit0014@example.com");

    // Every pre-0014 action must survive the CHECK swap — an additive
    // migration may not invalidate history it did not write.
    for (const action of [
      "OWNERSHIP_CLAIMED", "USER_ROLE_CHANGED", "USER_STATUS_CHANGED",
      "CREDENTIAL_CREATED", "CREDENTIAL_DELETED",
    ]) {
      await engine.query(
        `INSERT INTO audit_log(action, actor_user_id) VALUES ('${action}', ${uid})`);
    }

    // OD-MP-2 vocabulary: authorized use, both outcomes.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, credential_id, provider, outcome)
       VALUES ('CREDENTIAL_USED', ${uid}, 77, 'METAAPI', 'success')`);
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, credential_id, provider, outcome)
       VALUES ('CREDENTIAL_USED', ${uid}, 77, 'METAAPI', 'denied')`);
    // Binding direction travels in before_state/after_state, not in the name.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, trading_account_id, before_state, after_state, outcome)
       VALUES ('ACCOUNT_BINDING_CHANGED', ${uid}, 4242, 'unbound', 'bound', 'success')`);

    // The reveal action stays OUT of the vocabulary: 0014 widened the CHECK
    // for authorized USE, and must not have smuggled in a disclosure event.
    await assert.rejects(
      engine.query(`INSERT INTO audit_log(action, actor_user_id) VALUES ('CREDENTIAL_REVEALED', ${uid})`),
      /violates check constraint|check constraint/i,
      "CREDENTIAL_REVEALED must remain rejected by the database");
    await assert.rejects(
      engine.query(`INSERT INTO audit_log(action, actor_user_id) VALUES ('ACCOUNT_BOUND', ${uid})`),
      /violates check constraint|check constraint/i,
      "an unauthorized binding action name must be rejected");
  } finally { await engine.close(); }
});

test("0014 audit: trading_account_id is a historical id with no FK, so binding history outlives the account", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await seedCredUser(engine, "audit0014fk@example.com");

    // An account id that never existed is accepted: no referential constraint.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, trading_account_id, outcome)
       VALUES ('ACCOUNT_BINDING_CHANGED', ${uid}, 999999999, 'success')`);
    const orphan = await engine.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE trading_account_id = 999999999`);
    assert.equal((orphan.rows[0] as { n: number }).n, 1);

    // The column is nullable, so every pre-0014 row and every non-binding
    // event remains writable without it.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id) VALUES ('USER_ROLE_CHANGED', ${uid})`);
    const nulls = await engine.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE trading_account_id IS NULL`);
    assert.ok((nulls.rows[0] as { n: number }).n >= 1,
      "trading_account_id must be optional for events that are not about an account");
  } finally { await engine.close(); }
});

test("0014 provisioning_operations: the database enforces idempotency and refuses malformed identifiers", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await seedCredUser(engine, "prov0014@example.com");
    // Minimal insert: every column added after 0001 carries a DEFAULT.
    const acc = await engine.query(
      `INSERT INTO trading_accounts(user_id, external_account_id)
       VALUES (${uid}, 'acct-0014') RETURNING id`);
    const aid = String((acc.rows[0] as { id: string | number }).id);

    const KEY = "a".repeat(64);
    const MARKER = `velora-${"b".repeat(32)}`;
    await engine.query(
      `INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker)
       VALUES (${uid}, ${aid}, '${KEY}', '${MARKER}')`);

    // THE convergence invariant: the same operation key cannot exist twice for
    // a user, so a double-submitted connect collides in the DB rather than
    // provisioning a second provider account.
    await assert.rejects(
      engine.query(
        `INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker)
         VALUES (${uid}, ${aid}, '${KEY}', 'velora-${"c".repeat(32)}')`),
      /duplicate key|unique/i, "one operation per (user, operation_key)");

    // The reconciliation marker must be globally unique, or a provider search
    // could match two different operations.
    await assert.rejects(
      engine.query(
        `INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker)
         VALUES (${uid}, ${aid}, '${"d".repeat(64)}', '${MARKER}')`),
      /duplicate key|unique/i, "the provider marker must be unique");

    // Shape constraints: each of these would otherwise let a non-derived (and
    // possibly secret-bearing) string into the table.
    for (const [sql, label] of [
      [`INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker)
        VALUES (${uid}, ${aid}, 'not-hex', 'velora-${"e".repeat(32)}')`, "operation_key must be hex sha-256"],
      [`INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker)
        VALUES (${uid}, ${aid}, '${"f".repeat(64)}', 'arbitrary-name')`, "provider_marker must be the derived form"],
      [`INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker, transaction_id)
        VALUES (${uid}, ${aid}, '${"1".repeat(64)}', 'velora-${"1".repeat(32)}', 'too-short')`, "transaction_id must be 32 chars"],
      [`INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker, status)
        VALUES (${uid}, ${aid}, '${"2".repeat(64)}', 'velora-${"2".repeat(32)}', 'WHATEVER')`, "status is a closed vocabulary"],
      [`INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker, provider_account_id)
        VALUES (${uid}, ${aid}, '${"3".repeat(64)}', 'velora-${"3".repeat(32)}', 'has space')`, "provider account id charset"],
      [`INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker, last_error_code)
        VALUES (${uid}, ${aid}, '${"4".repeat(64)}', 'velora-${"4".repeat(32)}', 'provider said: bad password')`, "error code is a code, never a message"],
      [`INSERT INTO provisioning_operations(user_id, account_id, operation_key, provider_marker, attempts)
        VALUES (${uid}, ${aid}, '${"5".repeat(64)}', 'velora-${"5".repeat(32)}', -1)`, "attempts cannot go negative"],
    ] as Array<[string, string]>) {
      await assert.rejects(engine.query(sql), /violates check constraint|check constraint/i, label);
    }
  } finally { await engine.close(); }
});

test("0036 daily checklist: one row per (user, day), coherence enforced, no float, no silent completion", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const u = await engine.query(
      "INSERT INTO users(email, password_hash) VALUES ('checklist@0036.example','x') RETURNING id",
    );
    const uid = (u.rows as { id: string | number }[])[0]!.id;
    const ITEM = '{"dailyBias":{"state":"CONFIRMED","value":"BULLISH","normalised":true}}';
    // The store never writes `unreviewed_items`: it is generated as 11 - confirmed - unknown.
    const ins = (
      items: string,
      confirmed: number,
      unreviewed: number,
      unknown: number,
      state: string,
      reviewedAt: string | null,
      riskUnit = "UNSPECIFIED",
      risk: string | null = null,
      notes: string | null = null,
      date = "2026-10-18",
    ) =>
      engine.query(
        `INSERT INTO journal_daily_checklists
           (user_id, report_date, items, confirmed_items, unknown_items,
            review_state, reviewed_at, risk_unit, risk_value, notes)
         VALUES ($1, $2::date, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)`,
        [uid, date, items, confirmed, unknown, state, reviewedAt, riskUnit, risk, notes],
      );

    // The ordinary write works, and decimals come back as strings at ledger scale — never a float.
    await ins(ITEM, 1, 10, 0, "PARTIAL", null, "PERCENT", "0.50");
    const back = await engine.query(
      "SELECT risk_value, stop_loss, review_state FROM journal_daily_checklists WHERE user_id = $1",
      [uid],
    );
    const row = (back.rows as Record<string, unknown>[])[0]!;
    assert.equal(row["review_state"], "PARTIAL");
    assert.equal(typeof row["risk_value"], "string", "numeric must not arrive as a JS number");
    assert.match(String(row["risk_value"]), /^0\.50000000$/, "scale is part of the contract");

    // One row per (user, day): a Telegram retry, a double-tapped confirm or a re-sent voice note
    // all collide with the idempotency key instead of creating a second review.
    await assert.rejects(
      ins('{"dailyBias":{"state":"UNKNOWN","value":null,"normalised":false}}', 0, 10, 1, "UNREVIEWED", null),
      /duplicate key|violates unique constraint/i,
      "the same day must not be insertable twice",
    );
    // ...while a different day for the same user is a separate, legitimate report.
    await ins(ITEM, 1, 10, 0, "PARTIAL", null, "UNSPECIFIED", null, null, "2026-10-19");

    // Counts cannot disagree: the unreviewed figure is generated, and a writer cannot even name it.
    await assert.rejects(
      engine.query(
        `INSERT INTO journal_daily_checklists (user_id, report_date, items, unreviewed_items)
         VALUES ($1, '2026-10-20'::date, '{}'::jsonb, 3)`,
        [uid],
      ),
      /generated column|non-DEFAULT value into column/i,
      "unreviewed_items is derived, never supplied",
    );
    const derived = await engine.query(
      `SELECT unreviewed_items FROM journal_daily_checklists
        WHERE user_id = $1 AND report_date = '2026-10-19'::date`,
      [uid],
    );
    assert.equal(String((derived.rows as { unreviewed_items: string }[])[0]!.unreviewed_items), "10");
    // "Complete" is not a label a writer may apply at will.
    await assert.rejects(
      ins(ITEM, 1, 10, 0, "CONFIRMED", "2026-10-18T12:00:00Z"),
      /violates check constraint/i,
      "CONFIRMED requires every item confirmed",
    );
    await assert.rejects(
      ins(ITEM, 11, 0, 0, "CONFIRMED", null),
      /violates check constraint/i,
      "a completed review carries its stamp",
    );
    // A unit claim about an absent number is refused rather than stored as noise.
    await assert.rejects(
      ins(ITEM, 1, 10, 0, "PARTIAL", null, "PERCENT", null),
      /violates check constraint/i,
      "risk_unit without a value",
    );
    // The JSONB gate is a shape gate only — it does not pretend to judge trading content.
    await assert.rejects(
      ins("[]", 0, 11, 0, "UNREVIEWED", null),
      /violates check constraint/i,
      "items must be a JSON object",
    );
    await assert.rejects(
      ins(ITEM, 1, 10, 0, "PARTIAL", null, "UNSPECIFIED", null, "x".repeat(2001)),
      /value too long|violates check constraint/i,
      "notes are bounded",
    );

    // The audit vocabulary was widened, not loosened: the new action is allowed, and a
    // free-text action is still rejected by the database.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, target_user_id, request_id)
       VALUES ('JOURNAL_CHECKLIST_SAVED', $1, $1, '0036-test')`,
      [uid],
    );
    await assert.rejects(
      engine.query(
        `INSERT INTO audit_log(action, actor_user_id, target_user_id, request_id)
         VALUES ('JOURNAL_CHECKLIST_YOLO', $1, $1, '0036-test')`,
        [uid],
      ),
      /violates check constraint/i,
      "audit actions remain a closed set",
    );
    // `outcome` is still the single permitted value, and 0023's provider vocabulary is intact:
    // widening one CHECK must not have quietly relaxed its neighbours.
    await assert.rejects(
      engine.query(
        `INSERT INTO audit_log(action, actor_user_id, target_user_id, outcome)
         VALUES ('JOURNAL_CHECKLIST_SAVED', $1, $1, 'failure')`,
        [uid],
      ),
      /violates check constraint/i,
      "audit outcome vocabulary unchanged",
    );
    await assert.rejects(
      engine.query(
        `INSERT INTO audit_log(action, actor_user_id, target_user_id, provider)
         VALUES ('JOURNAL_CHECKLIST_SAVED', $1, $1, 'STRIPES')`,
        [uid],
      ),
      /violates check constraint/i,
      "audit provider vocabulary unchanged",
    );
  } finally {
    await engine.close();
  }
});

test("0040 audit vocabulary: the two restored actions are writable again, and publishing has a name", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await seedCredUser(engine, "audit0040@example.com");

    // PART 1 — the defect. These two were dropped by 0036's rewrite of the same constraint and had been
    // unwritable ever since. Asserting them HERE (rather than trusting the list in the migration file) is
    // the only thing that catches the next migration that rewrites the CHECK and forgets someone.
    for (const action of [
      "OWNERSHIP_CLAIMED", "USER_ROLE_CHANGED", "USER_STATUS_CHANGED",
      "CREDENTIAL_CREATED", "CREDENTIAL_DELETED", "CREDENTIAL_USED", "ACCOUNT_BINDING_CHANGED",
      "TELEGRAM_LINK_STARTED", "TELEGRAM_LINK_COMPLETED", "TELEGRAM_LINK_FAILED", "TELEGRAM_UNLINKED",
      "TELEGRAM_CHANNEL_BOUND", "TELEGRAM_CHANNEL_UNBOUND",
      "USER_SESSIONS_REVOKED", "USER_EMAIL_VERIFIED",
      "JOURNAL_CHECKLIST_SAVED",
    ]) {
      await engine.query(`INSERT INTO audit_log(action, actor_user_id) VALUES ('${action}', ${uid})`);
    }

    // PART 2 — the addition. `after_state` carries the post and the Telegram message id: enough to
    // correlate, and no copy of the content, which already has a row of its own.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, outcome, after_state)
       VALUES ('TELEGRAM_POST_PUBLISHED', ${uid}, 'success', 'post:41 message:9031')`,
    );
    const rows = await engine.query(
      `SELECT action, after_state FROM audit_log WHERE action = 'TELEGRAM_POST_PUBLISHED'`,
    );
    assert.equal((rows.rows as unknown[]).length, 1);

    // The vocabulary is still a vocabulary: an action nobody declared is refused, and the outcome set is
    // unchanged. A widening that let `NOPE` or `maybe` through would mean the constraint was replaced by
    // a column comment.
    await assert.rejects(
      engine.query(`INSERT INTO audit_log(action, actor_user_id) VALUES ('TELEGRAM_POST_SENT_TO_WORLD', ${uid})`),
      /audit_log_action_check/i,
      "an undescribed publish action must not be inventable at runtime",
    );
    await assert.rejects(
      engine.query(`INSERT INTO audit_log(action, actor_user_id, outcome) VALUES ('TELEGRAM_POST_PUBLISHED', ${uid}, 'maybe')`),
      /audit_log_outcome_check/i,
    );

    // And the constraint is exactly one object, not a leftover plus a new one: two live CHECKs would let a
    // future migration satisfy the wrong one.
    const constraints = await engine.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'audit_log'::regclass AND contype = 'c' AND conname LIKE 'audit\_log\_action%'`,
    );
    assert.equal((constraints.rows as unknown[]).length, 1, "one action CHECK, replaced rather than stacked");
  } finally {
    await engine.close();
  }
});

test("0039 admin-managed tool secrets: the vocabulary widened, the envelope rules did not", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const cols = await engine.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_platform_secrets' ORDER BY ordinal_position`,
    );
    const names = (cols.rows as { column_name: string }[]).map((r) => r.column_name);
    for (const required of ["secret_key", "enc_version", "key_version", "algorithm", "iv", "auth_tag", "secret_ciphertext"]) {
      assert.ok(names.includes(required), `the envelope columns must survive the widening: ${required}`);
    }
    const enc = (v: string) => Buffer.from(v, "utf8");
    // 0010's `ai_platform_secrets_nonce_unique` is UNIQUE (key_version, iv): a GCM nonce may never be
    // reused under one key. Every write below therefore carries its own 12-byte IV, and the LAST
    // assertion is what proves that rule still binds the new keys.
    let nonce = 0;
    const freshIv = () => enc(`iv-${String(++nonce).padStart(9, "0")}`); // "iv-" + 9 chars = 12 bytes
    const ins = (key: string, over: Partial<Record<string, unknown>> = {}) =>
      engine.query(
        `INSERT INTO ai_platform_secrets (secret_key, enc_version, key_version, algorithm, iv, auth_tag, secret_ciphertext)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          key,
          over["enc_version"] ?? 1,
          over["key_version"] ?? 1,
          over["algorithm"] ?? "aes-256-gcm",
          over["iv"] ?? freshIv(),
          over["auth_tag"] ?? enc("0000000000000000"),
          over["secret_ciphertext"] ?? enc("ciphertext"),
        ],
      );

    // FIRST: the refusals. They are run before any happy-path write on purpose — a rejected insert
    // leaves no row, so a key used here is still free for the writes below, and none of these can be
    // mistaken for a primary-key collision (which would look the same and prove nothing).
    await assert.rejects(ins("TOOL_CONFIG"), /violates check constraint/i, "no arbitrary secret names");
    await assert.rejects(ins("OPENAI_API_KEY_2"), /violates check constraint/i, "no prefixed variants");
    await assert.rejects(ins("BRAVE_SEARCH_API_KEY", { iv: enc("tooshort") }), /iv_check/i, "the GCM nonce stays exactly 12 bytes");
    await assert.rejects(ins("SERPER_API_KEY", { auth_tag: enc("nope") }), /auth_tag_check/i, "the tag stays 16 bytes");
    await assert.rejects(ins("BROWSERLESS_URL", { algorithm: "aes-256-cbc" }), /algorithm_check/i, "no algorithm downgrade for a tool key either");
    await assert.rejects(ins("BROWSERLESS_TOKEN", { secret_ciphertext: enc("") }), /secret_ciphertext_check/i, "an empty ciphertext is not a secret");
    await assert.rejects(ins("GEMINI_RELAY_TOKEN", { key_version: 0 }), /key_version_check/i, "key_version starts at 1");
    await assert.rejects(ins("TAVILY_API_KEY", { enc_version: 2 }), /enc_version_check/i, "the envelope format version is pinned");

    // THEN: every key writes — the four that already existed (a widening must not break a stored
    // secret) and the five tools added by 0039 (each ONE credential, never a combined blob).
    for (const key of [
      "GEMINI_API_KEY", "OPENAI_API_KEY", "GEMINI_RELAY_URL", "GEMINI_RELAY_TOKEN",
      "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "SERPER_API_KEY", "BROWSERLESS_URL", "BROWSERLESS_TOKEN",
    ]) {
      await ins(key);
    }
    // One envelope per name: rotation replaces, it does not accumulate history in the secret table.
    await assert.rejects(ins("TAVILY_API_KEY"), /ai_platform_secrets_pkey/i, "one row per secret key");

    // And the nonce pair is enforced for the NEW keys exactly as for the old ones — proved with an
    // UPDATE so it cannot be confused with a fresh insert colliding on the primary key.
    // The comparison is done entirely in SQL. Reading a BYTEA through a driver and handing it back can
    // change its encoding (hex string vs Buffer), and a test that fails on an encoding artefact would
    // prove nothing about the constraint.
    await assert.rejects(
      engine.query(
        `UPDATE ai_platform_secrets
            SET iv = (SELECT iv FROM ai_platform_secrets WHERE secret_key = 'GEMINI_API_KEY')
          WHERE secret_key = 'TAVILY_API_KEY'`,
      ),
      /nonce_unique/i,
      "the same (key_version, iv) may never carry a second secret",
    );
  } finally {
    await engine.close();
  }
});
test("0038 channel standby: a second verified channel can be kept without revoking the first", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const u = await engine.query("INSERT INTO users(email, password_hash) VALUES ('standby@0038.example','x') RETURNING id");
    const uid = (u.rows as { id: string | number }[])[0]!.id;
    const ins = (chatId: number, status: string, revokedAt: string | null = null) =>
      engine.query(
        `INSERT INTO telegram_channels (user_id, chat_id, title, chat_type, status, can_post, verified_at, revoked_at)
         VALUES ($1, $2, 'C', 'channel', $3, true, now(), $4)`,
        [uid, chatId, status, revokedAt],
      );

    await ins(-1001, "ACTIVE");
    // STANDBY is the state that lets a second verified binding exist without pretending the first
    // was revoked — and exactly one ACTIVE per user still holds.
    await ins(-1002, "STANDBY");
    await assert.rejects(ins(-1003, "ACTIVE"), /violates unique constraint|violates unique index/i,
      "one active mirror per user is unchanged by 0038");
    // A STANDBY row that also claims a revocation is a contradiction, and the pair is refused.
    await assert.rejects(ins(-1004, "STANDBY", "2026-10-19T00:00:00Z"), /violates check constraint/i,
      "standby is not revoked");
    // The old lifecycle rule still bites REVOKED, i.e. 0038 relaxed nothing beside the value list.
    await assert.rejects(ins(-1005, "REVOKED"), /violates check constraint/i, "REVOKED needs revoked_at");
    // And the vocabulary is still closed: an invented state is not accepted.
    await assert.rejects(ins(-1006, "PAUSED"), /violates check constraint/i, "statuses remain a closed set");

    // Re-selecting the standby channel is a state change, not a new binding: same row, same
    // verification facts, and the previously active one moves the other way.
    await engine.query(`UPDATE telegram_channels SET status = 'STANDBY' WHERE user_id = $1 AND chat_id = -1001`, [uid]);
    await engine.query(`UPDATE telegram_channels SET status = 'ACTIVE' WHERE user_id = $1 AND chat_id = -1002`, [uid]);
    const active = await engine.query(
      `SELECT chat_id FROM telegram_channels WHERE user_id = $1 AND status = 'ACTIVE'`,
      [uid],
    );
    // `String(...)` because an int8 comes back as a string from `pg` and as a number from PGlite;
    // the assertion is about WHICH chat is active, not about the driver's numeric mapping.
    assert.equal(String((active.rows as { chat_id: string | number }[])[0]!.chat_id), "-1002");
    const kept = await engine.query(
      `SELECT can_post, verified_at IS NOT NULL AS verified FROM telegram_channels WHERE user_id = $1 AND chat_id = -1001`,
      [uid],
    );
    const row = (kept.rows as { can_post: boolean; verified: boolean }[])[0]!;
    assert.equal(row.can_post, true, "a demotion must not erase the server-observed capability");
    assert.equal(row.verified, true, "…nor the fact that it was verified");
  } finally {
    await engine.close();
  }
});

test("0037 templates and outbox posts: one current version per name, approval bound to content, publication bound to a message id", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const u = await engine.query(
      "INSERT INTO users(email, password_hash) VALUES ('templates@0037.example','x') RETURNING id",
    );
    const uid = (u.rows as { id: string | number }[])[0]!.id;
    const other = await engine.query(
      "INSERT INTO users(email, password_hash) VALUES ('other@0037.example','x') RETURNING id",
    );
    const otherUid = (other.rows as { id: string | number }[])[0]!.id;
    const ch = await engine.query(
      `INSERT INTO telegram_channels (user_id, chat_id, title, chat_type, status, can_post, verified_at)
       VALUES ($1, -100123, 'Velora Test', 'channel', 'ACTIVE', true, now()) RETURNING id`,
      [uid],
    );
    const channelId = (ch.rows as { id: string }[])[0]!.id;

    const tpl = (name: string, body: string, version = 1, supersededAt: string | null = null) =>
      engine.query(
        `INSERT INTO telegram_post_templates (user_id, name, body, version, superseded_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [uid, name, body, version, supersededAt],
      );

    await tpl("morning", "Bias {{checklist.dailyBias}}");
    // A name addresses ONE live template…
    await assert.rejects(tpl("morning", "different body"), /duplicate key|violates unique constraint/i,
      "two current rows for one name must be unrepresentable");
    // …and the safe update is an append: the old version stays readable, the bump is unique.
    // The safe update is an APPEND: bump the version and stamp the row it replaces, atomically.
    // Doing it in one transaction is what makes "two current rows" impossible to observe, and a
    // lost update (two writers both believing they are version 2) has to surface as a violation.
    await engine.query("BEGIN");
    await engine.query(
      `UPDATE telegram_post_templates SET superseded_at = now()
        WHERE user_id = $1 AND name = 'morning' AND superseded_at IS NULL`,
      [uid],
    );
    await tpl("morning", "Bias {{checklist.dailyBias}} v2", 2);
    await engine.query("COMMIT");
    await assert.rejects(tpl("morning", "dup version", 2), /duplicate key|violates unique constraint/i,
      "version (user,name,2) already exists");
    // Half the append — a new current row while the old one is still current — is the lost update,
    // and the partial unique index is what refuses it.
    await assert.rejects(tpl("morning", "racing", 3), /duplicate key|violates unique constraint/i,
      "two current versions of one name must be unrepresentable");
    const current = await engine.query(
      `SELECT version, body FROM telegram_post_templates
        WHERE user_id = $1 AND name = 'morning' AND superseded_at IS NULL`,
      [uid],
    );
    const cur = (current.rows as { version: string; body: string }[])[0]!;
    assert.equal(String(cur.version), "2");
    assert.match(cur.body, /v2$/u);
    // and the row that was replaced is still readable — "what did the post say yesterday?"
    const history = await engine.query(
      `SELECT version, body FROM telegram_post_templates
        WHERE user_id = $1 AND name = 'morning' AND superseded_at IS NOT NULL ORDER BY version`,
      [uid],
    );
    assert.deepEqual((history.rows as { version: string }[]).map((r) => String(r.version)), ["1"]);
    // A name is addressed case-insensitively by the domain, but the two spellings stay distinct
    // rows here — folding them in the schema would make them unaddressable apart.
    await tpl("Morning", "another");
    // Empty, whitespace-only and oversized bodies are refused at the door, not truncated in.
    await assert.rejects(tpl("blank", ""), /violates check constraint/i, "empty body");
    await assert.rejects(tpl("huge", "x".repeat(8001)), /violates check constraint/i, "oversized body");
    await assert.rejects(tpl(" ", "x"), /violates check constraint/i, "blank name");
    // Zero and negative versions would make "append" meaningless.
    await assert.rejects(tpl("zero", "x", 0), /violates check constraint/i, "version > 0");
    // Another user may keep the same name: the key is (user, name), never name alone.
    await engine.query(
      `INSERT INTO telegram_post_templates (user_id, name, body) VALUES ($1, 'morning', 'theirs')`,
      [otherUid],
    );

    const H = (n: number) => n.toString(16).padStart(64, "0").slice(0, 64);
    const post = (over: Record<string, string | number | null> = {}) => {
      const hash = String(over["content_hash"] ?? H(1));
      const cols: Record<string, string | number | null> = {
        user_id: uid,
        channel_id: channelId,
        chat_id: -100123,
        body: "Bias bullish",
        content_hash: hash,
        approved_hash: hash,
        approved_at: "2026-10-19T09:00:00Z",
        dedupe_key: `update-${Math.floor(Math.random() * 1e9)}`,
        status: "APPROVED",
        ...over,
      };
      const names = Object.keys(cols).join(", ");
      const params = Object.keys(cols).map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO telegram_outbox_posts (${names}) VALUES (${params})`;
      return engine.query(sql, Object.values(cols)).catch((err: unknown) => {
        // Without this, a rejection at 4 a.m. says "violates check constraint" and nothing else.
        throw new Error(`${(err as Error).message} :: ${names}`);
      });
    };

    // The duplicate guard is per user: the same re-delivered update cannot post twice, while two
    // users addressing the same channel stay independent rows.
    await post({ dedupe_key: "update-1" });
    await assert.rejects(post({ dedupe_key: "update-1" }), /duplicate key|violates unique constraint/i,
      "the same dedupe key must never become a second publication");
    // …while ANOTHER user with the same dedupe key is a separate row. Note this user gets their OWN
    // channel: the composite owner FK makes "the same key on someone else's binding" impossible, and
    // the cross-user insert below is the test that says so.
    const ch2 = await engine.query(
      `INSERT INTO telegram_channels (user_id, chat_id, title, chat_type, status, can_post, verified_at)
       VALUES ($1, -100456, 'Other Test', 'channel', 'ACTIVE', true, now()) RETURNING id`,
      [otherUid],
    );
    await engine.query(
      `INSERT INTO telegram_outbox_posts (user_id, channel_id, chat_id, body, content_hash, approved_hash, approved_at, dedupe_key, status)
       VALUES ($1, $2, -100456, 'other', $3, $3, now(), 'fixed-key', 'APPROVED')`,
      [otherUid, (ch2.rows as { id: string }[])[0]!.id, H(1)],
    );
    // Approval is bound to the exact bytes: editing the content while approved is unrepresentable.
    await assert.rejects(
      engine.query(
        `UPDATE telegram_outbox_posts SET body = 'edited after approval', content_hash = $2
          WHERE user_id = $1 AND status = 'APPROVED'`,
        [uid, H(2)],
      ),
      /violates check constraint/i,
      "approved_hash must equal content_hash — an edit revokes the approval",
    );
    // A half-approval (a stamp with no hash, or a hash with no stamp) is refused.
    await assert.rejects(post({ approved_hash: null }), /violates check constraint/i, "approved_at without approved_hash");
    await assert.rejects(post({ approved_at: null }), /violates check constraint/i, "approved_hash without approved_at");
    // DRAFT is the state that has not been approved at all, and it needs neither column.
    await post({ status: "DRAFT", approved_hash: null, approved_at: null });
    // Publication cannot be claimed without naming the message, nor claimed without approval.
    await assert.rejects(
      post({ status: "PUBLISHED", telegram_message_id: null, published_at: null }),
      /violates check constraint/i,
      "PUBLISHED requires a message id and a timestamp",
    );
    await assert.rejects(
      post({ status: "CANCELLED", telegram_message_id: "12", published_at: "2026-10-19T09:01:00Z" }),
      /violates check constraint/i,
      "a message id means PUBLISHED and nothing else",
    );
    await assert.rejects(
      post({ status: "PUBLISHED", telegram_message_id: "12", published_at: "2026-10-19T09:01:00Z", approved_hash: null, approved_at: null }),
      /violates check constraint/i,
      "nothing reaches a channel that its owner did not approve",
    );
    // A send in flight is a state, so "Publish" can be claimed exactly once — and an unapproved
    // body still cannot sit in it.
    await assert.rejects(
      post({ status: "PUBLISHING", approved_hash: null, approved_at: null, dedupe_key: "publishing-no-approval" }),
      /violates check constraint/i,
      "nothing may enter PUBLISHING without covering its own bytes",
    );
    await post({ status: "PUBLISHING", dedupe_key: "publishing-ok" });
    await assert.rejects(post({ status: "FAILED", error_code: null }), /violates check constraint/i, "FAILED requires a code");
    await assert.rejects(post({ status: "FAILED", error_code: "Bad Request: chat not found" }), /violates check constraint/i,
      "error_code must be a code, not a message");
    await post({ status: "FAILED", error_code: "SEND_FAILED" });
    // A hash that is not a sha256 is not a hash.
    await assert.rejects(post({ content_hash: "1234" }), /violates check constraint/i, "content_hash shape");
    // Artwork is bounded and a file id is a reference, not a token-bearing URL.
    await assert.rejects(post({ banner_svg: "x".repeat(65537) }), /violates check constraint/i, "banner_svg bounded");
    await assert.rejects(post({ image_file_id: "" }), /violates check constraint/i, "empty file id is not a reference");
    // Retries are bounded, and the destination must belong to a channel row.
    await assert.rejects(post({ attempts: 6 }), /violates check constraint/i, "attempts are bounded");
    // A NEGATIVE destination must be storable (that is what a channel id is), and zero is not a
    // destination at all.
    await post({ chat_id: -100999, dedupe_key: "negative-chat-id" });
    await assert.rejects(post({ chat_id: 0, dedupe_key: "zero-chat-id" }), /violates check constraint/i,
      "chat_id 0 is not a destination");
    await assert.rejects(
      engine.query(
        `INSERT INTO telegram_outbox_posts (user_id, channel_id, chat_id, body, content_hash, dedupe_key, status)
         VALUES ($1, 999999, -1, 'x', $2, 'orphan', 'DRAFT')`,
        [uid, H(3)],
      ),
      /violates foreign key constraint/i,
      "a post must point at a channel this database knows",
    );
    // A foreign user cannot borrow this user's channel binding.
    await assert.rejects(
      engine.query(
        `INSERT INTO telegram_outbox_posts (user_id, channel_id, chat_id, body, content_hash, dedupe_key, status)
         VALUES ($1, $2, -100123, 'x', $3, 'cross-user', 'DRAFT')`,
        [otherUid, channelId, H(4)],
      ),
      /violates foreign key constraint/i,
      "the (channel, user) pair is the ownership anchor — the composite FK, not a filter",
    );
  } finally {
    await engine.close();
  }
});

test("0041 audit vocabulary: an operator's tool validation is writable, and nothing older was lost", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const uid = await seedCredUser(engine, "audit0041@example.com");

    // The full list, replayed against the FINAL schema. 0036's lesson is that a rewrite of this constraint
    // can drop names silently, so the test for a widening is not "the new name works" — it is "every name
    // the platform has ever recognised still works". A row for each is cheap; a lost action is a runtime
    // error in front of an admin.
    const everyAction = [
      "OWNERSHIP_CLAIMED", "USER_ROLE_CHANGED", "USER_STATUS_CHANGED",
      "CREDENTIAL_CREATED", "CREDENTIAL_DELETED", "CREDENTIAL_USED", "ACCOUNT_BINDING_CHANGED",
      "TELEGRAM_LINK_STARTED", "TELEGRAM_LINK_COMPLETED", "TELEGRAM_LINK_FAILED", "TELEGRAM_UNLINKED",
      "TELEGRAM_CHANNEL_BOUND", "TELEGRAM_CHANNEL_UNBOUND",
      "USER_SESSIONS_REVOKED", "USER_EMAIL_VERIFIED",
      "JOURNAL_CHECKLIST_SAVED",
      "TELEGRAM_POST_PUBLISHED",
      "AI_TOOL_VALIDATED",
    ];
    for (const action of everyAction) {
      await engine.query(`INSERT INTO audit_log(action, actor_user_id) VALUES ('${action}', ${uid})`);
    }
    const written = await engine.query(`SELECT count(*)::int AS n FROM audit_log`);
    assert.equal((written.rows as { n: number }[])[0]?.n, everyAction.length, "one row per action, none refused");

    // The verdict shape the route writes: correlation only. A tool name and a fixed code are low
    // cardinality; an endpoint or a provider body is not this column's business.
    await engine.query(
      `INSERT INTO audit_log(action, actor_user_id, outcome, after_state)
       VALUES ('AI_TOOL_VALIDATED', ${uid}, 'success', 'tool:web_search verdict:ok')`,
    );
    const verdicts = await engine.query(
      `SELECT after_state FROM audit_log WHERE action = 'AI_TOOL_VALIDATED' ORDER BY id DESC LIMIT 1`,
    );
    assert.match(String((verdicts.rows as { after_state: string | null }[])[0]?.after_state), /verdict:ok/u);

    // `provider` is NOT widened by this migration: the search vendors are not in that vocabulary, and the
    // row leaves it NULL. A migration that quietly accepted 'TAVILY' here would be putting a third-party
    // name in the column that carries broker credential lifecycle.
    await assert.rejects(
      engine.query(`INSERT INTO audit_log(action, actor_user_id, provider) VALUES ('AI_TOOL_VALIDATED', ${uid}, 'TAVILY')`),
      /audit_log_provider_check/i,
      "the provider vocabulary belongs to 0023 and stays there",
    );

    // Still a closed set, and still exactly one live action CHECK.
    await assert.rejects(
      engine.query(`INSERT INTO audit_log(action, actor_user_id) VALUES ('AI_TOOL_SECRET_READ', ${uid})`),
      /audit_log_action_check/i,
    );
    const constraints = await engine.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'audit_log'::regclass AND contype = 'c' AND conname LIKE 'audit\\_log\\_action%'`,
    );
    assert.equal((constraints.rows as unknown[]).length, 1, "one action CHECK, replaced rather than stacked");
  } finally {
    await engine.close();
  }
});

// ── 0042: the menu's persisted settings ──────────────────────────────────────
//
// The table exists so the menu's choices survive a restart, and the constraints exist so a half-open
// guided prompt cannot be stored. Both halves are asserted here against real PostgreSQL semantics:
// a CHECK that is never exercised is a comment.
test("0042: one preferences row per user, with defaults by absence and a coherent flow cursor", async () => {
  const engine = await createEngine();
  try {
    await migrate(engine, MIGRATIONS);
    const userId = (await engine.query(
      "INSERT INTO users(email, password_hash) VALUES ($1,$2) RETURNING id",
      ["prefs@velora.ir", "x"],
    )).rows[0]?.id;
    assert.ok(userId !== undefined);

    // Absence is the default: no row is a valid state, not a missing one.
    assert.equal((await engine.query("SELECT * FROM telegram_post_preferences WHERE user_id = $1", [userId])).rows.length, 0);

    await engine.query(
      `INSERT INTO telegram_post_preferences (user_id, default_template_name, banner_enabled, banner_title)
       VALUES ($1, $2, TRUE, $3)`,
      [userId, "morning", "عنوان"],
    );
    // One row per user, enforced by the primary key rather than by a caller's discipline.
    await assert.rejects(
      engine.query("INSERT INTO telegram_post_preferences (user_id) VALUES ($1)", [userId]),
      /duplicate key|unique/i,
    );

    // A banner title the renderer would silently truncate is refused by the database.
    await assert.rejects(
      engine.query("UPDATE telegram_post_preferences SET banner_title = $2 WHERE user_id = $1", [userId, "x".repeat(61)]),
      /check constraint/i,
    );
    // An empty name is not a name.
    await assert.rejects(
      engine.query("UPDATE telegram_post_preferences SET default_template_name = $2 WHERE user_id = $1", [userId, "  "]),
      /check constraint/i,
    );

    // The coherence rule: a kind with no start time would never expire, so it cannot be written…
    await assert.rejects(
      engine.query("UPDATE telegram_post_preferences SET flow_kind = 'tpl_new_name' WHERE user_id = $1", [userId]),
      /check constraint/i,
    );
    // …the body step cannot exist without its name…
    await assert.rejects(
      engine.query(
        "UPDATE telegram_post_preferences SET flow_kind = 'tpl_new_body', flow_started_at = now() WHERE user_id = $1",
        [userId],
      ),
      /check constraint/i,
    );
    // …and the name step must not carry a body (that would be two stages at once).
    await assert.rejects(
      engine.query(
        "UPDATE telegram_post_preferences SET flow_kind = 'tpl_new_name', flow_started_at = now(), flow_body = 'x' WHERE user_id = $1",
        [userId],
      ),
      /check constraint/i,
    );

    // The step the bot actually opens is accepted, and clearing it in one statement is accepted too.
    await engine.query(
      "UPDATE telegram_post_preferences SET flow_kind = 'tpl_new_name', flow_started_at = now() WHERE user_id = $1",
      [userId],
    );
    await engine.query(
      "UPDATE telegram_post_preferences SET flow_kind = NULL, flow_started_at = NULL WHERE user_id = $1",
      [userId],
    );
    // An unknown kind is not a future step; it is a typo, and the vocabulary is closed.
    await assert.rejects(
      engine.query(
        "UPDATE telegram_post_preferences SET flow_kind = 'something_else', flow_started_at = now() WHERE user_id = $1",
        [userId],
      ),
      /check constraint/i,
    );
  } finally {
    await engine.close();
  }
});
