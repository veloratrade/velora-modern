// Real-PostgreSQL evidence battery — the CF hasher's pgcrypto prerequisite (D2).
//
// The local structural battery (pgcryptoProvisioning.test.ts) pins WHERE the
// extension comes from; this battery runs against a REAL PostgreSQL (the
// postgres-evidence workflow's disposable server, DATABASE_URL) and proves the
// provisioned prerequisite actually answers the exact SQL PgCryptoHasher sends:
//   hash()   → SELECT crypt($1, gen_salt('bf', $2)) AS hash
//   verify() → SELECT (crypt($1, $2) = $2) AS ok
//
// Excluded from the local dev battery by the runner (*.pg.test.ts); wired into
// .github/workflows/postgres-evidence.yml via run_battery pgcryptoProvisioning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Client } from "pg";
import { PGCRYPTO_BCRYPT_COST } from "../../apps/api-cf/src/pgCryptoHasher.ts";

const DATABASE_URL = process.env.DATABASE_URL;
const PGCRYPTO_SQL = "CREATE EXTENSION IF NOT EXISTS pgcrypto";

async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

test("the pgcrypto extension is present after the idempotent provision statement", async () => {
  await withClient(async (client) => {
    await client.query(PGCRYPTO_SQL); // same statement db/provision.ts runs; re-run is a no-op
    const { rows } = await client.query("SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'");
    assert.equal(rows.length, 1, "pgcrypto installed");
  });
});

test("hash() contract: crypt + gen_salt('bf', cost 12) returns the $2a$12$ family", async () => {
  await withClient(async (client) => {
    const { rows } = await client.query("SELECT crypt($1, gen_salt('bf', $2)) AS hash", [
      "velora-battery-password",
      PGCRYPTO_BCRYPT_COST,
    ]);
    const hash = rows[0]?.["hash"];
    assert.equal(typeof hash, "string");
    assert.match(String(hash), /^\$2a\$12\$/, "the family the Node host verifies");
  });
});

test("verify() contract: crypt(input, stored) = stored round-trips true and false", async () => {
  await withClient(async (client) => {
    const made = await client.query("SELECT crypt($1, gen_salt('bf', $2)) AS hash", [
      "velora-battery-password",
      PGCRYPTO_BCRYPT_COST,
    ]);
    const stored = made.rows[0]!["hash"] as string;
    const yes = await client.query("SELECT (crypt($1, $2) = $2) AS ok", ["velora-battery-password", stored]);
    const no = await client.query("SELECT (crypt($1, $2) = $2) AS ok", ["velora-battery-password-wrong", stored]);
    assert.equal(yes.rows[0]!["ok"], true);
    assert.equal(no.rows[0]!["ok"], false);
  });
});
