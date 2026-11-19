// Demo-data seeder for the Velora Modern Codespaces / local test environment.
//
// ⚠️ TEST-ONLY. Seeds a small, deterministic set of demo users, accounts and
// trades into the test Postgres so the stack is usable immediately after
// Codespaces provisioning. Idempotent: safe to re-run (ON CONFLICT upserts /
// DO NOTHING). Never run against staging or production; real secrets are
// never used here (all credentials are dev placeholders).
//
// Run:   npx tsx tools/seed-demo.ts
// Needs: DATABASE_URL (or MIGRATION_DATABASE_URL) pointing at a Postgres that
//        has already been migrated (db/migrate.ts).
import { Pool } from "pg";

const DATABASE_URL =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("seed-demo: DATABASE_URL / MIGRATION_DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // --- demo user (idempotent by unique email) ---------------------------
    const userEmail = "demo@velora-demo.test";
    const { rows: userRows } = await client.query(
      `INSERT INTO users (email, password_hash, role, locale)
       VALUES ($1, $2, 'user', 'fa')
       ON CONFLICT (email) DO UPDATE
         SET role = EXCLUDED.role, locale = EXCLUDED.locale, updated_at = now()
       RETURNING id, email`,
      [userEmail, "$2y$demo_test_hash_not_real"],
    );
    // NOTE: password_hash column is NOT NULL; we store a clearly-fake bcrypt
    // prefix value. No real credential ever enters this script.
    const userId = userRows[0].id;

    // --- demo trading account (idempotent by (user_id, external_account_id)) ---
    const { rows: acctRows } = await client.query(
      `INSERT INTO trading_accounts
         (user_id, external_account_id, broker_server, provider, platform,
          label, currency, balance, equity, status, sync_status)
       VALUES ($1, $2, 'demo-server.velora-demo.test', 'MT4', 'MANUAL',
          'Demo Trading Account', 'USD', 10000.00, 10250.50, 'connected', 'CONNECTED')
       ON CONFLICT (user_id, external_account_id) DO UPDATE
         SET balance = EXCLUDED.balance, equity = EXCLUDED.equity,
             status = EXCLUDED.status, updated_at = now()
       RETURNING id`,
      [userId, "DEMO-MT4-001"],
    );
    const accountId = acctRows[0].id;

    // --- demo trades (idempotent by (account_id, external_deal_id)) -------
    const now = new Date().toISOString();
    const trades = [
      { deal: "DEMO-DEAL-001", symbol: "XAUUSD", dir: "buy", vol: "0.10",
        entry: "2350.00", exit: "2365.50", comm: "3.50", swap: "-1.25",
        pnl: "151.75", strategy: "Price Action" },
      { deal: "DEMO-DEAL-002", symbol: "EURUSD", dir: "sell", vol: "0.50",
        entry: "1.0850", exit: "1.0780", comm: "2.00", swap: "-0.75",
        pnl: "34.25", strategy: "Support/Resistance" },
      { deal: "DEMO-DEAL-003", symbol: "GBPJPY", dir: "buy", vol: "0.05",
        entry: "185.20", exit: "184.10", comm: "1.00", swap: "-0.50",
        pnl: "-56.50", strategy: "Breakout" },
    ];
    let inserted = 0;
    for (const t of trades) {
      const res = await client.query(
        `INSERT INTO trades
           (user_id, account_id, external_deal_id, symbol, direction, status,
            entry_price, exit_price, volume, commission, swap, net_pnl,
            strategy, occurred_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'$5','CLOSED',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (account_id, external_deal_id) DO NOTHING
         RETURNING id`,
        [
          userId, accountId, t.deal, t.symbol, t.dir,
          t.entry, t.exit, t.vol, t.comm, t.swap, t.pnl,
          t.strategy, now, now, now,
        ],
      );
      inserted += res.rowCount;
    }

    await client.query("COMMIT");

    console.log("seed-demo: complete");
    console.log(`  user:      id=${userId} email=${userEmail}`);
    console.log(`  account:   id=${accountId} external=DEMO-MT4-001`);
    console.log(`  trades:    ${inserted} new (idempotent re-runs add 0)`);
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    console.error("seed-demo: failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
