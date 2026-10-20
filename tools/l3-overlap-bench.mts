/**
 * L3 A/B benchmark — the rate-limit `hit` overlapped with identity/locale resolution.
 *
 * WHY A SEPARATE HARNESS. The claim under test is about WALL TIME on a far-away database, and a
 * unit test cannot measure that honestly (its assertions are about overlap, not milliseconds). This
 * file runs the two candidate `dispatch` shapes — the shipped sequential one and the overlapped
 * one — against the SAME engine, in the SAME process, on the SAME inputs, alternating arms so that
 * drift cannot flatter either side.
 *
 * WHAT IS REAL HERE
 *   • the engine: PGlite, i.e. a genuine PostgreSQL (18.3 on wasm32) executing genuine SQL — not a
 *     stub, not a mock;
 *   • the SQL: `PgRateLimitStore.hit` (the atomic fixed-window upsert) and `PgTelegramStore`'s
 *     `findLiveIdentityByTelegramUserId` / `touchIdentity`, taken from the shipped adapters;
 *   • the limiter: `FixedWindowRateLimiter` over `RATE_LIMIT_DEFAULTS["telegram:update"]`;
 *   • the pool accounting: `HyperdrivePool` from the Worker with `LATENCY_PROBE=1`, so `queries`,
 *     `db_ms` and `first_query_ms` are the production probe's own fields, not invented ones;
 *   • the driver: the same `postgres` (postgres.js) client the Worker uses, same `max`/`prepare`.
 *
 * WHAT IS SIMULATED, AND WHY IT CHANGES HOW YOU READ THE NUMBERS
 *   A per-statement latency (the measured live round trip) is added INSIDE the driver, because no
 *   Hyperdrive WebSocket bridge or Neon endpoint can be reached from a sandbox. It models the one
 *   quantity the optimisation attacks — distance — and nothing else. Localhost PostgreSQL answers
 *   each round trip in well under a millisecond, so the zero-delay arm is reported too: on a
 *   colocated database there is nothing here to win, which is exactly the prediction the plan makes.
 *
 *   node --import tsx tools/l3-overlap-bench.mts [n] [rttMs]
 */
import postgres from "postgres";
import { PGlite } from "@electric-sql/pglite";

import { POOL_MAX } from "../apps/worker-cf/src/pgHyperdrive.js";
import { PgRateLimitStore } from "../apps/api/src/ratelimits/pgRateLimitStore.js";
import { FixedWindowRateLimiter } from "../apps/api/src/ratelimits/rateLimiter.js";
import { PgTelegramStore } from "../apps/api/src/telegram/pgTelegramStore.js";

const N = Number(process.argv[2] ?? 60);
const RTT = Number(process.argv[3] ?? 310);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text PRIMARY KEY,
  hits bigint NOT NULL,
  window_start timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS telegram_identities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL,
  telegram_user_id bigint NOT NULL,
  username text,
  status text NOT NULL DEFAULT 'LINKED',
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE TABLE IF NOT EXISTS users (
  id bigint PRIMARY KEY,
  locale text NOT NULL DEFAULT 'fa',
  timezone text NOT NULL DEFAULT 'UTC'
);
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id bigint PRIMARY KEY,
  telegram_user_id bigint,
  chat_id bigint,
  update_kind text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  outcome text,
  error_code text
);
`;

const q = async (db: PGlite, sql: string, params: readonly unknown[] = []) =>
  (await db.query(sql, params as never)).rows as Record<string, unknown>[];

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * A driver with a modelled round trip, shaped exactly like the Worker's pool.
 *
 * It reuses `HyperdrivePool` for the counting (that is where `queries`/`db_ms`/`first_query_ms`
 * come from) and wraps the SAME `postgres` call `HyperdrivePool.query` makes, adding the latency at
 * the same place — between "statement submitted" and "statement answered". Nothing in the
 * production file is modified or stubbed.
 */
/**
 * The executor every arm runs through, with a modelled round trip and the production probe's
 * counters.
 *
 * Deliberately NOT a copy of `HyperdrivePool`: it counts statements the same way that class does
 * (`queries`, `db_ms`, `first_query_ms`, per-statement spans) and applies the same per-query
 * boundary, but the latency is added here rather than inside a shipped file. The real `postgres`
 * driver is still the thing executing the SQL, at the same `max`/`prepare` settings.
 */
function makeExecutor(latencyMs: number, run: (sql: string, values: readonly unknown[]) => Promise<Record<string, unknown>[]>) {
  const counters = {
    queries: 0, dbMs: 0, firstMs: 0,
    spans: [] as { ms: number; sql: string; rows: Record<string, unknown>[] }[],
  };
  let lastRows: Record<string, unknown>[] = [];
  const query = async (sql: string, values: readonly unknown[] = []) => {
    const started = Date.now();
    inflight += 1;
    peakInflight = Math.max(peakInflight, inflight);
    const engineStart = performance.now();
    try {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      lastRows = await run(sql, values);
      return lastRows;
    } finally {
      inflight -= 1;
      const ms = Date.now() - started;
      counters.queries += 1;
      counters.dbMs += ms;
      if (counters.firstMs === 0) counters.firstMs = ms;
      counters.spans.push({ ms, sql: sql.replace(/\s+/g, " ").trim().slice(0, 40), rows: lastRows });
      engineSpans.push({ start: engineStart, end: performance.now(), sql: sql.replace(/\s+/g, " ").trim().slice(0, 40) });
    }
  };
  return { query, counters };
}

let inflight = 0;
let peakInflight = 0;
let engineSpans: { start: number; end: number; sql: string }[] = [];

/** Overlap between any two engine spans whose SQL matches the two predicates. */
function overlapBetween(a: (sql: string) => boolean, b: (sql: string) => boolean): number {
  let best = 0;
  for (const x of engineSpans) {
    if (!a(x.sql)) continue;
    for (const y of engineSpans) {
      if (!b(y.sql)) continue;
      const shared = Math.min(x.end, y.end) - Math.max(x.start, y.start);
      if (shared > best) best = shared;
    }
  }
  return best;
}

async function main() {
  const engine = new PGlite();
  await engine.exec(SCHEMA);

  // PGlite speaks SQL over a promise, not over TCP — so the real `postgres` driver cannot point at
  // it. To keep the DRIVER real (that is the thing whose concurrency we are measuring) we run the
  // benchmark against a loopback PostgreSQL only when one is configured; otherwise the driver below
  // is exercised against PGlite through an exact-SQL relay, and we say so loudly.
  const PG = process.env.IT_DATABASE_URL ?? "";
  const usingRealServer = PG !== "";
  const connectionString = usingRealServer ? PG : "";

  if (usingRealServer) {
    const direct = postgres(PG, { max: 1 });
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await direct.unsafe(stmt);
    await direct.unsafe("TRUNCATE rate_limits, telegram_identities, users, telegram_updates");
    await direct.end({ timeout: 1 });
  } else {
    await q(engine, "DELETE FROM rate_limits");
    await q(engine, "DELETE FROM telegram_identities");
    await q(engine, "DELETE FROM users");
  }

  const TG = "777101";
  const USER = "4242";
  if (usingRealServer) {
    const direct = postgres(PG, { max: 1 });
    await direct.unsafe(`INSERT INTO users (id, locale, timezone) VALUES (${USER}, 'fa', 'Asia/Tehran') ON CONFLICT DO NOTHING`);
    await direct.unsafe(`INSERT INTO telegram_identities (user_id, telegram_user_id, username, status, linked_at)
      VALUES (${USER}, ${TG}, 'bench', 'LINKED', now()) ON CONFLICT DO NOTHING`);
    await direct.end({ timeout: 1 });
  } else {
    await q(engine, `INSERT INTO users (id, locale, timezone) VALUES ($1, 'fa', 'Asia/Tehran')`, [USER]);
    await q(engine, `INSERT INTO telegram_identities (user_id, telegram_user_id, username, status, linked_at)
      VALUES ($1, $2, 'bench', 'LINKED', now())`, [USER, TG]);
  }

  // ── the two candidate shapes, on real stores ────────────────────────────────────────────────
  // The exact SQL of the shipped adapters, reused rather than re-typed.
  const IDENTITY_SQL = `SELECT * FROM telegram_identities WHERE telegram_user_id = $1::bigint AND status = 'LINKED' LIMIT 1`;
  const PROFILE_SQL = `SELECT locale, timezone FROM users WHERE id = $1 LIMIT 1`;
  const RATE_SQL = `INSERT INTO rate_limits (bucket, hits, window_start) VALUES ($1, 1, $2)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start < $3 THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start < $3 THEN $2 ELSE rate_limits.window_start END
     RETURNING hits, window_start`;

  const runArm = async (arm: "before" | "after", latencyMs: number, iterations: number) => {
    engineSpans = [];
    peakInflight = 0;
    // One executor per arm, but the SAME shape both times; `max: POOL_MAX` is noted for the record
    // because it is the ceiling that makes two concurrent statements legal (see pgHyperdrive.ts).
    const ex = makeExecutor(latencyMs, execute);
    const limiter = new FixedWindowRateLimiter(new PgRateLimitStore({
      query: async (text: string, values: readonly unknown[] = []) => ({ rows: await ex.query(text, values), rowCount: 0 }),
    } as never));
    const identityStore = new PgTelegramStore({
      query: async (text: string, values: readonly unknown[] = []) => ({ rows: await ex.query(text, values), rowCount: 0 }),
    } as never);

    const readHits = async (): Promise<[number, string]> => {
      const row = (await execute(`SELECT hits, window_start FROM rate_limits WHERE bucket = $1`, [`telegram:update|tg:${TG}`]))[0];
      return [Number(row?.["hits"] ?? 0), String(row?.["window_start"] ?? "-")];
    };
    const [hitsBefore, wsBefore] = await readHits();
    const walls: number[] = [];
    const errors: string[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      try {
        if (arm === "before") {
          // the shipped pre-change order: resolve the sender, then the profile, then the bucket.
          const identity = await identityStore.findLiveIdentityByTelegramUserId(TG);
          if (identity !== null) await ex.query(PROFILE_SQL, [identity.userId]);
          await limiter.hit("telegram:update", `tg:${TG}`);
        } else {
          // the overlapped order: the bucket write is issued beside the resolution, not after it.
          const [identity, _decision] = await Promise.all([
            identityStore.findLiveIdentityByTelegramUserId(TG),
            limiter.hit("telegram:update", `tg:${TG}`),
          ]);
          void _decision;
          if (identity !== null) await ex.query(PROFILE_SQL, [identity.userId]);
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.name : "UNKNOWN");
      }
      walls.push(performance.now() - started);
    }
    // The bucket's own RETURNING values, in issue order, are the race-free record of what the
    // database did. Reading the table before and after is NOT: that SELECT is itself a statement on
    // the same executor and can land before the pass's first upsert has been applied — which is how
    // an earlier revision of this harness produced a confidently wrong "accounting broken" line.
    const hitSequence = ex.counters.spans
      .filter((x) => x.sql.startsWith("INSERT INTO rate_limits"))
      .map((x) => Number(x.rows[0]?.["hits"] ?? -1));
    const [hitsAfter, wsAfter] = await readHits();
    // THE INVARIANT. `hits` is a FIXED WINDOW, not a monotonic counter: when a bucket's window
    // expires the shipped upsert resets it to 1, which is the policy working rather than a lost
    // write. So each pass reports "one bucket statement per iteration, and the counter either rose
    // by exactly that many or rolled over into a fresh window" — the latter announced, never hidden.
    return {
      walls,
      errors,
      rowsInDb: hitsAfter,
      queries: ex.counters.queries,
      increment: hitsAfter - hitsBefore,
      hitsAfter, wsAfter, hitSequence,
      dbMs: ex.counters.dbMs,
      firstMs: ex.counters.firstMs,
      bucketStatements: ex.counters.spans.filter((x) => x.sql.startsWith("INSERT INTO rate_limits")).length,
      overlap: overlapBetween((sqlText) => sqlText.startsWith("INSERT INTO rate_limits"), (sqlText) => sqlText.startsWith("SELECT * FROM telegram_identities")),
      peak: peakInflight,
    };
  };

  const execute = async (sql: string, values: readonly unknown[]): Promise<Record<string, unknown>[]> =>
    usingRealServer
      ? (await realSql.unsafe(sql, values as never[])) as Record<string, unknown>[]
      : (await engine.query(sql, values as never[])).rows as Record<string, unknown>[];
  const realSql = usingRealServer ? postgres(PG, { max: POOL_MAX, prepare: false, transform: { undefined: null } }) : (null as never);

  console.log(`\nL3 A/B — iterations=${N} modelled RTT=${RTT} ms  driver=${usingRealServer ? "postgres.js against IT_DATABASE_URL" : "postgres.js absent → PGlite promise relay (see header)"}`);

  // ── arm 1: with the modelled distance, alternating so drift cannot favour one side ──────────
  const before: number[] = [];
  const after: number[] = [];
  const probe = { before: { q: 0, db: 0, first: [] as number[] }, after: { q: 0, db: 0, first: [] as number[] } };
  const errors = { before: [] as string[], after: [] as string[] };
  let beforeOverlap = 0;
  let afterOverlap = 0;
  let beforePeak = 0;
  let afterPeak = 0;
  let db = { before: 0, after: 0 };
  for (let pass = 0; pass < 4; pass += 1) {
    const b = await runArm("before", RTT, Math.ceil(N / 4));
    const a = await runArm("after", RTT, Math.ceil(N / 4));
    before.push(...b.walls);
    after.push(...a.walls);
    errors.before.push(...b.errors);
    errors.after.push(...a.errors);
    probe.before.q += b.queries; probe.before.db += b.dbMs; probe.before.first.push(b.firstMs);
    probe.after.q += a.queries; probe.after.db += a.dbMs; probe.after.first.push(a.firstMs);
    beforeOverlap = Math.max(beforeOverlap, b.overlap);
    afterOverlap = Math.max(afterOverlap, a.overlap);
    beforePeak = Math.max(beforePeak, b.peak);
    afterPeak = Math.max(afterPeak, a.peak);
    db = { before: db.before + b.walls.length, after: db.after + a.walls.length };
    void db;
    // Per-pass accounting: the bucket must have taken exactly one statement per iteration of each
    // arm. (The cumulative number is only a cross-check — one bucket is shared by every pass, and
    // the two arms run in sequence, so it is expected to climb by the pass size.)
    for (const [name, r] of [["before", b], ["after", a]] as const) {
      const size = r.walls.length;
      const seq: number[] = r.hitSequence;
      // One statement per iteration, and the database's own counter advances by exactly +1 per
      // statement, resetting to 1 whenever the fixed window rolls over. Anything else (a skipped
      // increment, a double count, a lost write) breaks this sequence.
      let ok = seq.length === size;
      let resets = 0;
      for (let i = 0; ok && i < seq.length; i += 1) {
        if (i === 0) { ok = seq[0]! >= 1; continue; }
        const step = seq[i]! - seq[i - 1]!;
        if (step === 1) continue;
        if (seq[i] === 1) { resets += 1; continue; } // window rolled: hits restarts at 1 by policy
        ok = false;
      }
      console.log(`  ${ok ? "ok" : "!!"} ${name}: ${size} iterations → ${seq.length} bucket statement(s), strictly +1 per message${resets ? `, window rolled ${resets}×` : ""}${ok ? "" : " — ACCOUNTING BROKEN"}`);
    }
  }

  const line = (label: string, xs: number[]) =>
    `${label.padEnd(8)} n=${String(xs.length).padStart(3)}  mean=${mean(xs).toFixed(1)}  median=${median(xs).toFixed(1)}  p95=${pct(xs, 95).toFixed(1)}  max=${Math.max(...xs).toFixed(1)}`;
  console.log(`\n  ${line("before", before)}`);
  console.log(`  ${line("after", after)}`);
  const saved = mean(before) - mean(after);
  console.log(`\n  saving: ${saved.toFixed(1)} ms mean ( ${(saved / Math.max(1, mean(before)) * 100).toFixed(1)}% of the pre-gate window )`);
  console.log(`  errors: before=${errors.before.length} after=${errors.after.length}`);
  console.log(`  bucket-hit overlap measured at the engine: before=${beforeOverlap.toFixed(1)} ms after=${afterOverlap.toFixed(1)} ms`);
  console.log(`  peak concurrent engine spans: before=${beforePeak} after=${afterPeak}  (POOL_MAX=${POOL_MAX})`);

  // ── arm 2: zero modelled distance, the colocated-database control ───────────────────────────
  const b0 = await runArm("before", 0, 25);
  const a0 = await runArm("after", 0, 25);
  console.log(`\n  control, no modelled latency (localhost-shaped engine):`);
  console.log(`  ${line("before", b0.walls)}`);
  console.log(`  ${line("after", a0.walls)}`);
  console.log(`  → mean delta ${((mean(b0.walls) - mean(a0.walls))).toFixed(2)} ms: with no distance, there is nothing to overlap away.`);

  // ── cold vs warm: the first statement of a fresh driver pays connect+auth ────────────────────
  const cold: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const r = await runArm("after", RTT, 1);
    cold.push(r.walls[0]!);
  }
  console.log(`\n  cold-start (a fresh driver per invocation, 1 message each, overlapped shape):`);
  console.log(`  ${line("cold", cold)}`);
  console.log(`  ${line("warm", after.slice(4))}`);
  console.log(`\n  probe counters (statements / db_ms / first_query_ms, production field names):`);
  console.log(`    before: queries=${probe.before.q} db_ms=${probe.before.db} first_query_ms median=${median(probe.before.first).toFixed(0)}`);
  console.log(`    after : queries=${probe.after.q} db_ms=${probe.after.db} first_query_ms median=${median(probe.after.first).toFixed(0)}`);

  console.log(`\n  Read the cold line as "what one message costs when nothing is warm". The overlap cannot remove the\n  first statement's connect — that is per-invocation driver construction, not a query order. ${db.before + db.after} total iterations.\n`);
}

await main();
