// OD-M-PA-1(a) remediation — retire the pre-assembly per-fill MetaAPI trades.
//
// CONTEXT (MG-METAAPI-ASSEMBLY, audit §9.2). Before the position-assembly
// port, the Modern importer created ONE trade per OUT fill with
// entry_price = exit_price and volume = the fill volume. Those rows are
// materially wrong journals. No production or staging dataset was ever
// deployed (the worker never ran outside dev/local — Gate 3B 0/20), so the
// exposure is dev/local only, which is why owner decision OD-M-PA-1
// recommended option (a): tombstone the per-fill rows ADR-002-clean and let
// reconciliation re-import the positions from the immutable fill ledger.
//
// WHAT IT DOES (execute mode):
//   1. finds trades with source='metaapi' whose external_deal_id does NOT
//      start with 'pos-' (the per-fill-era identity),
//   2. tombstones them (deleted_at = now) through the append-only ledger:
//      one TRADE_TOMBSTONED event per trade, actor `sync`, deterministic
//      event_uid `metaapi-retire:<trade id>` — idempotent on re-run,
//   3. resets nothing else. The fills are untouched (append-only evidence);
//      the next reconciliation pass re-assembles every position from the
//      ledger — the pending question is answered from the FILLS, so no
//      back-fill of sync_position_state is needed.
//
// SAFETY: DRY-RUN BY DEFAULT. `--execute` is required for any mutation, and
// the script refuses to run without DATABASE_URL. It never touches trades of
// any other source, never hard-deletes anything (ADR-002: tombstone only),
// and prints the exact counts it acted on.
//
// USAGE:
//   DATABASE_URL=postgres://… npx tsx ops/metaapi/retirePerFillTrades.ts [--execute]
import { Pool } from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") {
    console.error("DATABASE_URL is required (this tool is explicitly opt-in).");
    process.exit(2);
  }
  const execute = process.argv.includes("--execute");

  const pool = new Pool({ connectionString: url });
  try {
    const found = await pool.query<{ id: string; external_deal_id: string }>(
      `SELECT id, external_deal_id FROM trades
        WHERE source = 'metaapi'
          AND external_deal_id IS NOT NULL
          AND external_deal_id NOT LIKE 'pos-%'
          AND deleted_at IS NULL
        ORDER BY id`,
    );
    console.log(`per-fill metaapi trades still live: ${found.rowCount}`);
    for (const r of found.rows.slice(0, 10)) {
      console.log(`  e.g. trade ${r.id} external_deal_id=${r.external_deal_id}`);
    }
    if (found.rowCount > 10) console.log(`  … and ${found.rowCount - 10} more`);

    if (!execute) {
      console.log("DRY RUN — nothing changed. Re-run with --execute to tombstone them.");
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let tombstoned = 0;
      for (const r of found.rows) {
        const upd = await client.query(
          `UPDATE trades SET deleted_at = now(), updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL AND source = 'metaapi'
              AND external_deal_id NOT LIKE 'pos-%'`,
          [r.id],
        );
        if (upd.rowCount === 1) {
          await client.query(
            `INSERT INTO trade_events (event_uid, trade_id, type, actor, expected_version, payload, at)
             VALUES ($1,$2,'TOMBSTONE_SET','sync',0,$3,now())
             ON CONFLICT (event_uid) DO NOTHING`,
            [
              `metaapi-retire:${r.id}`,
              r.id,
              JSON.stringify({
                reason: "MG-METAAPI-ASSEMBLY remediation (OD-M-PA-1a): per-fill-era row superseded by position assembly",
                externalDealId: r.external_deal_id,
              }),
            ],
          );
          tombstoned++;
        }
      }
      await client.query("COMMIT");
      console.log(`tombstoned: ${tombstoned} (idempotent — re-run converges to 0 new)`);
      console.log(
        "The next worker reconciliation pass re-assembles every position from the fill ledger.",
      );
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void main().catch((err: unknown) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
