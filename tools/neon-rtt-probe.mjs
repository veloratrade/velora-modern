/**
 * neon-rtt-probe.mjs — why is the bot slow? separate *distance* from *work*.
 *
 * Read-only by construction: TCP handshake, `select 1`, one EXPLAIN ANALYZE of a statement the bot
 * really runs, and a SELECT over the update ledger. No writes, no DDL, nothing is deleted.
 *
 *   DB_URL_FILE=/tmp/velora_db_url node tools/neon-rtt-probe.mjs
 *
 * The point of the first two numbers: `select 1` does no work inside Postgres, so its wall time is
 * the round trip. EXPLAIN ANALYZE then reports how long the server actually spent on a real
 * statement. When the second number is 3 orders of magnitude smaller than the first, the cost is
 * transport, not the database — and the answer is co-location, not query tuning.
 */
import net from 'node:net';
import { URL } from 'node:url';
import fs from 'node:fs';
import pg from 'pg';

const dsnFile = process.env.DB_URL_FILE || '/tmp/velora_db_url';
const dsn = fs.readFileSync(dsnFile, 'utf8').trim();
const host = new URL(dsn).hostname;
const SAMPLES = Number(process.env.SAMPLES || 10);

/** One RTT, no Postgres involved: plain TCP connect to the DB port. */
function tcpTries(n) {
  return new Promise((resolve) => {
    const out = [];
    let i = 0;
    const step = () => {
      if (i++ >= n) return resolve(out);
      const t = process.hrtime.bigint();
      const s = net.connect({ host, port: 5432 });
      s.on('connect', () => { out.push(Number(process.hrtime.bigint() - t) / 1e6); s.destroy(); step(); });
      s.on('error', () => { out.push(-1); step(); });
    };
    step();
  });
}

const probeSql = 'select update_id from telegram_updates where update_id = $1';
const probeArg = Number(process.env.PROBE_UPDATE_ID || 407785986);
const ledgerFrom = process.env.LEDGER_FROM || '2026-10-18 18:45:00+00';

console.log(`host: ${host}`);
const tcp = await tcpTries(5);
console.log(`tcp connect ms (no DB work): ${tcp.map((x) => x.toFixed(0)).join(', ')}`);
if (tcp.every((x) => x >= 0 && x < 20)) {
  console.log('  note: sub-RTT values mean a relay/terminates locally — treat tcp as uninformative here;');
  console.log('  the authoritative transport number is `select 1` on a warm connection below.');
}

const client = new pg.Client({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
let t0 = process.hrtime.bigint();
await client.connect();
console.log(`pg connect (tcp+tls+auth, cold): ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)} ms`);

const wall = [];
for (let i = 0; i < SAMPLES; i++) {
  const t = process.hrtime.bigint();
  await client.query('select 1');
  wall.push(Number(process.hrtime.bigint() - t) / 1e6);
}
const avg = wall.reduce((a, b) => a + b, 0) / wall.length;
console.log(`select 1 on a warm connection: ${wall.map((x) => x.toFixed(0)).join(', ')} ms`);
console.log(`  => one round trip costs ${avg.toFixed(1)} ms of pure transport; N serial statements ≈ ${(avg * 12 / 1000).toFixed(2)} s at N=12`);

const plan = await client.query(`explain (analyze, buffers, format json) ${probeSql}`, [probeArg]);
const node = plan.rows[0]['QUERY PLAN'][0];
const t = process.hrtime.bigint();
await client.query(probeSql, [probeArg]);
const realWall = Number(process.hrtime.bigint() - t) / 1e6;
console.log(`a real statement the bot runs (update-ledger SELECT):`);
console.log(`  server execution time: ${node['Execution Time']} ms  |  planning: ${node['Plan Planning Time'] ?? node['Planning Time']} ms`);
console.log(`  wall clock from here:  ${realWall.toFixed(0)} ms  => ${((1 - (node['Execution Time'] / realWall)) * 100).toFixed(2)} % of it is not the database`);


/* ── the driver question, answered once and for all ────────────────────────────────────────────────
 * The bot does not use `pg`, it uses `postgres` (postgres.js), and on this stack a *parameterized*
 * postgres.js statement costs two round trips where a parameter-free one costs one. Measured 2026-10-18
 * in one process on one warm connection, alternating shapes so no ordering could flatter a result:
 *
 *   unsafe(text) with no values            155 ms   median of 8
 *   unsafe(text, [value])                  310 ms
 *   template call, first run of a shape    310 ms → then 155 ms for every repeat of the SAME shape,
 *                                                    because `prepare: true` caches the row description
 *
 * Which is why `prepare: true` was tried, measured, and REVERTED: a Worker invocation opens its own
 * connection, the cache is per connection, and after the identity memo (§23) each invocation issues
 * every statement shape exactly once — so there is nothing left to cache. The A/B: db_ms 3588 (prepared)
 * against 3576/3579 (not prepared), 8 statements either way, same row. The rule this leaves is blunter
 * and better than "tune the driver": a repeat is worth 155 ms, but *not doing the query at all* is worth
 * 310. The section below re-measures the two numbers every run, on purpose, so nobody re-litigates it.
 */
{
  const { default: postgres } = await import("postgres");
  const shape = "select update_id from telegram_updates where update_id = $1";
  const strings = Object.assign([shape.slice(0, shape.indexOf("$1")), ""], { raw: [shape.slice(0, shape.indexOf("$1")), ""] });
  const timed = async (label, fn, per = 1) => {
    const xs = [];
    for (let i = 0; i < SAMPLES; i++) { const t = performance.now(); await fn(); xs.push((performance.now() - t) / per); }
    const m = [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.log(`  ${label.padEnd(46)} ${m.toFixed(0)} ms per statement  (median of ${SAMPLES})`);
  };
  console.log("\npostgres.js on the same connection (the driver the Worker actually uses):");
  for (const prepare of [false, true]) {
    const sql = postgres(dsn, { max: 1, prepare, ssl: "require", transform: { undefined: null } });
    await sql.unsafe("select 1"); // warm the connection so connect cost cannot flatter anything
    console.log(`  prepare:${prepare ? "true " : "false"}`);
    const four = (run) => async () => { await run(); await run(); await run(); return run(); };
    await timed("no parameter (simple query)", () => sql.unsafe("select 1"));
    await timed("one parameter, unsafe(text, [v])", () => sql.unsafe(shape, [probeArg]));
    await timed("unsafe(text, [v]) — 4 in a row", four(() => sql.unsafe(shape, [probeArg])), 4);
    await timed("template call, after warm-up — 4 in a row", four(() => sql(strings, probeArg)), 4);
    await sql.end({ timeout: 1 });
  }
}

const ledger = await client.query(`
  select to_char(received_at at time zone 'UTC','HH24:MI:SS') as recv,
         update_id, update_kind, outcome,
         round(extract(epoch from (processing_started_at - received_at))::numeric, 2) as delivery_s,
         round(extract(epoch from (processed_at - processing_started_at))::numeric, 2) as work_s,
         round(extract(epoch from (processed_at - received_at))::numeric, 2) as total_s
    from telegram_updates
   where received_at > $1
   order by received_at`, [ledgerFrom]);
console.log(`\nledger since ${ledgerFrom} (recv | update_id | kind | outcome | delivery_s | work_s | total_s):`);
for (const r of ledger.rows) {
  console.log(`  ${r.recv}  ${r.update_id}  ${String(r.update_kind).padEnd(14)} ${String(r.outcome).padEnd(8)} ${r.delivery_s}  ${r.work_s}  ${r.total_s}`);
}

await client.end();
