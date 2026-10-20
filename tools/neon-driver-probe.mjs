/**
 * neon-driver-probe.mjs — is a round trip per statement the *network* or the *driver*?
 *
 * Read-only: `select 1` and one SELECT against the update ledger, no writes, nothing created or dropped.
 *
 *   DB_URL_FILE=/tmp/velora_db_url node tools/neon-driver-probe.mjs
 *
 * WHY. `tools/neon-rtt-probe.mjs` measured 154 ms for a no-work statement through `pg`, while the
 * deployed ledger probe shows ~311 ms for the statements the bot really issues on the same connection
 * string. 311 ≈ 2 × 154, which is the signature of one extra protocol round trip per statement. If the
 * extra trip belongs to the driver rather than to the distance, the fix is not "run fewer queries" and
 * not "move the database" — it is this file's fourth measurement: issue the independent statements
 * concurrently, which the current serial path leaves on the table.
 */
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import postgres from 'postgres';

const dsn = fs.readFileSync(process.env.DB_URL_FILE || '/tmp/velora_db_url', 'utf8').trim();
const SQL = 'select update_id from telegram_updates where update_id = $1';
const ID = Number(process.env.PROBE_UPDATE_ID || 407785986);
const N = Number(process.env.SAMPLES || 9);

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const line = (label, xs) =>
  console.log(`${label.padEnd(46)} median ${med(xs).toFixed(0)} ms   [${xs.map((x) => x.toFixed(0)).join(', ')}]`);

/** pg (node-postgres): the reference the ledger probe is *not* using. */
const pgc = new pg.Client({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
await pgc.connect();
{
  const a = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); await pgc.query('select 1'); a.push(performance.now() - t); }
  line('pg  select 1', a);
  const b = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); await pgc.query(SQL, [ID]); b.push(performance.now() - t); }
  line('pg  real ledger SELECT', b);
}
await pgc.end();

/** postgres.js exactly as the Worker configures it today. */
for (const opts of [
  { label: 'postgres.js  prepare:false (current)', prepare: false },
  { label: 'postgres.js  prepare:true (default)', prepare: true },
]) {
  const sql = postgres(dsn, { max: 2, prepare: opts.prepare, ssl: 'require' });
  const a = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); await sql.unsafe('select 1'); a.push(performance.now() - t); }
  line(`${opts.label}  select 1`, a);
  const b = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); await sql.unsafe(SQL, [ID]); b.push(performance.now() - t); }
  line(`${opts.label}  real SELECT`, b);
  await sql.end({ timeout: 1 });
}

/** Concurrent independent statements — the shape the bot's pre-reads already have. */
for (const width of [1, 2, 4]) {
  const sql = postgres(dsn, { max: Math.max(width, 2), prepare: false, ssl: 'require' });
  const a = [];
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    await Promise.all(Array.from({ length: width }, () => sql.unsafe(SQL, [ID])));
    a.push(performance.now() - t);
    await delay(20);
  }
  line(`postgres.js  ${width} SELECT${width > 1 ? 's' : ''} in parallel (total)`, a);
  await sql.end({ timeout: 1 });
}
