// D4 real-PostgreSQL battery — SERVICE-LEVEL TRADE CONCURRENCY.
//
// EVIDENCE LABEL (Phase D policy): executes ONLY against a REAL, disposable
// PostgreSQL (DATABASE_URL — postgres-evidence workflow). Without it, every
// test is SKIPPED. A local SKIP is NOT D4 evidence.
//
// D4 scope (owner authorization 2026-09-13, per the D4 preflight): verification
// of trade-concurrency semantics through the REAL TradeService over the real
// PgTradeStore — the primitives (version CAS, SELECT … FOR UPDATE, the
// velora_apply_exit trigger, tombstones, event_uid uniqueness) are D2-built
// and must NOT be redesigned here. This battery proves, on real PostgreSQL:
//
//   A. same-trade mixed mutation races (exit vs edit, exit vs tombstone,
//      edit vs tombstone) — deterministic winner-SET invariants: the service's
//      pre-read is advisory (unlocked), so a fully-serialized interleaving may
//      legitimately let BOTH racers succeed (the second re-reads the fresh
//      version); overlapping attempts yield exactly one winner + exact 409/404
//      for the loser. Both outcomes are correct ADR-002 behavior — the D4
//      invariants are: no lost update, no double-apply, version == committed
//      mutations, one event per committed mutation, allocation exact.
//   B. different-trade concurrency isolation (no cross-row interference)
//   C. service-level stale CAS → exact 409 CONFLICT, no event written
//   D. concurrent exits — exactly-one full-volume winner; partial-exit
//      allocation stays exactly consistent (never over-allocated)
//   E. record-exit vs cancel-exit race — allocation increment/decrement
//      consistency under CAS
//   F/N. tombstone finality — no resurrection, no post-tombstone mutation,
//      non-disclosing 404 (tombstoned ≡ missing)
//   G. over-allocation → full rollback (no partial exit/event/projection)
//   H. lock release after failure — subsequent operations complete promptly
//   I/J. duplicate event_uid → honest constraint failure + FULL rollback
//      (idempotency boundary: uniqueness constraint honesty; webhook/sync
//      replay convergence is Phase H, NOT D4)
//   K. NUMERIC exact-string preservation after races (ADR-001 scales)
//   L/M. no lost events + bounded replay: projection == fold(trade_events)
//      for every raced sequence (ADR-002 testing requirement)
//
// Test architecture (D3 pattern): TWO independent TradeService instances over
// ONE shared pool — correctness must come from the database, never from
// process-local state. Lock-wait-sensitive tests set EXPLICIT statement_timeout
// and lock_timeout on every pool connection (no PostgreSQL server defaults
// relied upon — D1-spike risk R8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createEngine, migrate } from "../migrate.ts";
import { PgTradeStore } from "../../apps/api/src/trades/pgTradeStore.ts";
import { TradeService, TradeError } from "../../apps/api/src/trades/tradeService.ts";
import type { TradeStore } from "../../apps/api/src/trades/tradeStore.ts";
import { applyEvent } from "../../packages/domain/src/tradeLedger.ts";
import type { TradeState, LedgerEvent } from "../../packages/domain/src/tradeLedger.ts";
import type { Pool } from "pg";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const PG_URL = process.env.DATABASE_URL;
const SKIP = PG_URL === undefined
  ? "DATABASE_URL not set — real-PG battery (postgres-evidence workflow only)"
  : false;

const T0 = new Date("2026-09-13T09:00:00.000Z");

/** Explicit lock/statement timeouts (ms) — R8: never rely on server defaults. */
const STATEMENT_TIMEOUT_MS = 20_000;
const LOCK_TIMEOUT_MS = 10_000;

async function harness(): Promise<{
  pool: Pool;
  store: PgTradeStore;
  owner: string;
  other: string;
  svcA: TradeService;
  svcB: TradeService;
  close: () => Promise<void>;
}> {
  const { Pool } = await import("pg");
  const engine = await createEngine(PG_URL);
  await migrate(engine, MIGRATIONS);
  await engine.close();
  const pool = new Pool({
    connectionString: PG_URL,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    lock_timeout: LOCK_TIMEOUT_MS,
    max: 12,
  });
  pool.on("error", () => { /* idle-client socket errors must not crash the battery */ });
  await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1,'x'), ($2,'y') ON CONFLICT (email) DO NOTHING",
    ["pgd4-owner@velora.test", "pgd4-other@velora.test"],
  );
  const ids = await pool.query(
    "SELECT id, email FROM users WHERE email IN ($1, $2)",
    ["pgd4-owner@velora.test", "pgd4-other@velora.test"],
  );
  const byEmail = new Map<string, string>(
    ids.rows.map((r: { id: string; email: string }) => [r.email, String(r.id)]),
  );
  const mkService = (): TradeService => {
    let clock = T0.getTime();
    let uid = 0;
    return new TradeService({
      store: new PgTradeStore(pool) as unknown as TradeStore,
      getUserTimezone: async () => "UTC",
      verifyAccountOwnership: async () => true,
      now: () => new Date(clock++), // deterministic, strictly increasing
      newEventUid: () => `pg-d4-${Date.now()}-${++uid}-${randomTag()}`,
    });
  };
  return {
    pool,
    store: new PgTradeStore(pool),
    owner: byEmail.get("pgd4-owner@velora.test")!,
    other: byEmail.get("pgd4-other@velora.test")!,
    svcA: mkService(),
    svcB: mkService(),
    close: () => pool.end(),
  };
}

let tagCounter = 0;
function randomTag(): string {
  return `t${process.pid.toString(36)}${(++tagCounter).toString(36)}`;
}

// ---- shared fixtures -------------------------------------------------------

const TRADE_BODY = {
  symbol: "XAUUSD",
  direction: "buy",
  entryPrice: "2350.50",
  exitPrice: "2361.25",
  volume: "1",
  contractSize: "100",
  commission: "7",
  swap: "-0.50",
  stopLoss: "2345",
  takeProfit: "2380",
  openTime: "2026-09-10T08:00:00Z",
  closeTime: "2026-09-10T16:00:00Z",
  strategyTag: "breakout",
  emotionalScore: 3,
  notes: "d4 probe",
} as const;

const exitBody = (volume: string, exitType = "partial") => ({
  exitType,
  exitPrice: "2355.00",
  volume,
  exitedAt: "2026-09-10T12:00:00Z",
});

interface Caught {
  ok: boolean;
  value?: Record<string, unknown>;
  status?: number;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** Run a service promise; classify TradeError outcomes (never swallow others). */
async function attempt(p: Promise<Record<string, unknown>>): Promise<Caught> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    if (err instanceof TradeError) {
      return { ok: false, status: err.status, code: err.code, message: err.message, details: err.details };
    }
    throw err; // non-contract failures (driver leaks, dead DB…) must fail the test
  }
}

const isExactConflict = (r: Caught) => r.status === 409 && r.code === "CONFLICT" && r.message === "Version conflict.";
const isExactOverAllocation = (r: Caught) =>
  r.status === 422 && r.code === "VALIDATION_FAILED" && r.details?.volume === "EXIT_VOLUME_EXCEEDED";
const isExactTrade404 = (r: Caught) => r.status === 404 && r.code === "NOT_FOUND" && r.message === "Trade not found.";

async function newTrade(svc: TradeService, userId: string): Promise<string> {
  const created = await svc.createTrade(userId, { ...TRADE_BODY });
  return String((created as { id: unknown }).id);
}

async function projection(pool: Pool, tradeId: string): Promise<{ version: string; allocated: string; deletedAt: string | null; notes: string | null; strategy: string | null }> {
  const r = await pool.query(
    "SELECT version, allocated_volume, deleted_at, notes, strategy FROM trades WHERE id = $1",
    [tradeId],
  );
  const row = r.rows[0] as { version: string; allocated_volume: string; deleted_at: Date | null; notes: string | null; strategy: string | null };
  return {
    version: String(row.version),
    allocated: String(row.allocated_volume),
    deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
    notes: row.notes,
    strategy: row.strategy,
  };
}

async function countEvents(pool: Pool, tradeId: string): Promise<number> {
  const r = await pool.query("SELECT count(*)::int AS n FROM trade_events WHERE trade_id = $1", [tradeId]);
  return (r.rows[0] as { n: number }).n;
}

async function activeExits(pool: Pool, tradeId: string): Promise<{ id: string; volume: string }[]> {
  const r = await pool.query(
    "SELECT id::text AS id, volume::text AS volume FROM trade_exits WHERE trade_id = $1 AND deleted_at IS NULL ORDER BY id",
    [tradeId],
  );
  return r.rows as { id: string; volume: string }[];
}

/** 0.2 × k rendered at scale 8 (integer math — never floats, ADR-001 spirit). */
function tenths(k: number): string {
  const units = BigInt(k) * 2n * 10_000_000n; // k × 0.2 at scale 8
  const s = units.toString().padStart(9, "0");
  return `${s.slice(0, -8)}.${s.slice(-8)}`;
}

/** Normalize a decimal string to scale 8 (the domain fold's zero is "0";
 *  PostgreSQL renders NUMERIC(20,8) as "0.00000000" — equal values, different
 *  string forms; comparison must be scale-normalized. Integer math only.) */
function scale8(s: string): string {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
  assert.ok(m !== null, `scale8: not a plain decimal string: ${JSON.stringify(s)}`);
  const [, sign, intPart, frac = ""] = m;
  assert.ok(frac.length <= 8, `scale8: more than 8 fraction digits: ${JSON.stringify(s)}`);
  return `${sign}${intPart}.${frac.padEnd(8, "0")}`;
}

/** Every trade raced in this battery, for the final replay invariant (L/M). */
const racedTradeIds: string[] = [];

// ---- tests -----------------------------------------------------------------

test("PG D4 A1: MIXED RACE — createExit vs updateTrade (two service instances) → winner-set invariants, exact contracts, no lost event", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);

    const [exitRes, editRes] = await Promise.all([
      attempt(h.svcA.createExit(id, h.owner, exitBody("0.2"))),
      attempt(h.svcB.updateTrade(id, h.owner, { notes: "raced-edit" })),
    ]);

    const k = [exitRes, editRes].filter((r) => r.ok).length;
    assert.ok(k === 1 || k === 2, `winner count ∈ {1 overlapping, 2 serialized}, got ${k}`);
    for (const loser of [exitRes, editRes].filter((r) => !r.ok)) {
      // the row stays active in this race ⇒ a loser is ALWAYS an exact 409
      assert.ok(isExactConflict(loser), `loser exact 409 CONFLICT, got ${JSON.stringify(loser)}`);
    }

    const p = await projection(h.pool, id);
    assert.equal(p.version, String(k), "version advanced once per committed mutation");
    assert.equal(p.deletedAt, null, "no tombstone in this race");
    assert.equal(await countEvents(h.pool, id), 1 + k, "TRADE_CREATED + one event per committed mutation (no lost, no extra)");
    const exits = await activeExits(h.pool, id);
    if (exitRes.ok) {
      assert.equal(p.allocated, "0.20000000", "exit committed ⇒ allocation applied at scale 8");
      assert.equal(exits.length, 1, "exit committed ⇒ one active exit row");
    } else {
      assert.equal(p.allocated, "0.00000000", "exit lost ⇒ no allocation");
      assert.equal(exits.length, 0, "exit lost ⇒ zero exit rows");
    }
    assert.equal(p.notes, editRes.ok ? "raced-edit" : "d4 probe", "journaling reflects exactly whether the edit committed");
  } finally {
    await h.close();
  }
});

test("PG D4 A2: MIXED RACE — createExit vs deleteTrade (tombstone) → winner-set invariants; tombstone/no-tombstone consistency", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);

    const [exitRes, tombRes] = await Promise.all([
      attempt(h.svcA.createExit(id, h.owner, exitBody("0.2"))),
      attempt(h.svcB.deleteTrade(id, h.owner)),
    ]);

    const k = [exitRes, tombRes].filter((r) => r.ok).length;
    assert.ok(k === 1 || k === 2, `winner count ∈ {1, 2}, got ${k}`);
    // loser contracts are determined by WHO won:
    //  - tombstone won ⇒ the exit attempt fails closed (404 once tombstoned —
    //    the locked parent filters deleted rows) — never a post-tombstone write
    //  - exit won ⇒ the tombstone loser saw an active row at a moved version ⇒ 409
    if (k === 1) {
      if (tombRes.ok) {
        assert.ok(exitRes.status === 404 && exitRes.code === "NOT_FOUND",
          `exit loser after tombstone → exact 404 NOT_FOUND, got ${JSON.stringify(exitRes)}`);
      } else {
        assert.ok(isExactConflict(tombRes), `tombstone loser exact 409 (row stays active), got ${JSON.stringify(tombRes)}`);
      }
    }

    const p = await projection(h.pool, id);
    assert.equal(p.version, String(k), "version == committed mutations");
    assert.equal(await countEvents(h.pool, id), 1 + k, "one event per committed mutation");
    if (k === 2) {
      // both committed ⇒ the ONLY legal order is exit-then-tombstone
      // (an exit after the tombstone is a non-disclosing 404, proven in F/N)
      assert.notEqual(p.deletedAt, null, "serialized both ⇒ ended tombstoned");
      assert.equal(p.allocated, "0.20000000", "exit applied before the tombstone");
      assert.equal((await activeExits(h.pool, id)).length, 1, "exit row preserved under the tombstone (immutable ledger)");
    } else if (tombRes.ok) {
      assert.notEqual(p.deletedAt, null, "tombstone won ⇒ deleted_at set");
      assert.equal((await activeExits(h.pool, id)).length, 0, "tombstone won ⇒ no exit row (loser rolled back entirely)");
    } else {
      assert.equal(p.deletedAt, null, "exit won ⇒ trade still active");
      assert.equal(p.allocated, "0.20000000", "exit won ⇒ allocation applied");
    }
  } finally {
    await h.close();
  }
});

test("PG D4 A3: MIXED RACE — updateTrade vs deleteTrade → winner-set invariants; loser exact contract; projection consistent", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);

    const [editRes, tombRes] = await Promise.all([
      attempt(h.svcA.updateTrade(id, h.owner, { notes: "edit-race" })),
      attempt(h.svcB.deleteTrade(id, h.owner)),
    ]);

    const k = [editRes, tombRes].filter((r) => r.ok).length;
    assert.ok(k === 1 || k === 2, `winner count ∈ {1, 2}, got ${k}`);
    if (k === 1) {
      if (tombRes.ok) {
        assert.ok(editRes.status === 404 && editRes.code === "NOT_FOUND",
          `edit loser after tombstone → exact 404, got ${JSON.stringify(editRes)}`);
      } else {
        assert.ok(isExactConflict(tombRes), `tombstone loser exact 409, got ${JSON.stringify(tombRes)}`);
      }
    }
    const p = await projection(h.pool, id);
    assert.equal(p.version, String(k), "version == committed mutations");
    assert.equal(await countEvents(h.pool, id), 1 + k, "no lost events");
    if (k === 2) {
      assert.notEqual(p.deletedAt, null, "serialized both ⇒ edit-then-tombstone");
      assert.equal(p.notes, "edit-race", "edit committed before the tombstone");
    } else if (editRes.ok) {
      assert.equal(p.notes, "edit-race", "edit won ⇒ notes applied");
      assert.equal(p.deletedAt, null, "edit won ⇒ still active");
    }
  } finally {
    await h.close();
  }
});

test("PG D4 B: different-trade concurrency — simultaneous edit/exit/tombstone all succeed; rows isolated; foreign user non-disclosing 404", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const t1 = await newTrade(h.svcA, h.owner);
    const t2 = await newTrade(h.svcA, h.owner);
    const t3 = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(t1, t2, t3);

    const [r1, r2, r3] = await Promise.all([
      attempt(h.svcA.updateTrade(t1, h.owner, { notes: "iso-edit" })),
      attempt(h.svcB.createExit(t2, h.owner, exitBody("0.5"))),
      attempt(h.svcA.deleteTrade(t3, h.owner)),
    ]);
    assert.ok(r1.ok && r2.ok && r3.ok, `different trades ⇒ all succeed, got ${JSON.stringify([r1, r2, r3])}`);

    const p1 = await projection(h.pool, t1);
    const p2 = await projection(h.pool, t2);
    const p3 = await projection(h.pool, t3);
    assert.equal(p1.version, "1", "t1 edited");
    assert.equal(p2.allocated, "0.50000000", "t2 exit allocated");
    assert.notEqual(p3.deletedAt, null, "t3 tombstoned");
    assert.equal(p1.notes, "iso-edit", "t1 notes only");
    // ownership: a foreign user's mutation is a NON-DISCLOSING 404 (never 403/leak)
    const foreign = await attempt(h.svcB.updateTrade(t1, h.other, { notes: "theft" }));
    assert.ok(isExactTrade404(foreign), `foreign edit → exact non-disclosing 404, got ${JSON.stringify(foreign)}`);
    assert.equal((await projection(h.pool, t1)).notes, "iso-edit", "foreign attempt changed nothing");
  } finally {
    await h.close();
  }
});

test("PG D4 C: service-level stale CAS → exact 409 CONFLICT, no event written, version unchanged by loser", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);
    const first = await attempt(h.svcA.updateTrade(id, h.owner, { notes: "first", version: 0 }));
    assert.ok(first.ok, "fresh CAS wins");
    // stale explicit version (0) against the now-current version 1
    const stale = await attempt(h.svcB.updateTrade(id, h.owner, { notes: "stale", version: 0 }));
    assert.ok(isExactConflict(stale), `stale CAS → exact 409 CONFLICT, got ${JSON.stringify(stale)}`);
    const p = await projection(h.pool, id);
    assert.equal(p.version, "1", "loser did not bump version");
    assert.equal(p.notes, "first", "loser's patch not applied");
    assert.equal(await countEvents(h.pool, id), 2, "TRADE_CREATED + 1 edit — the stale loser wrote NO event");
  } finally {
    await h.close();
  }
});

test("PG D4 D1: concurrent FULL-volume exits (8 racers, two services) → exactly ONE success; losers exact 409/422; allocation exactly 1.0", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);

    const racers = Array.from({ length: 8 }, (_, i) =>
      attempt((i % 2 === 0 ? h.svcA : h.svcB).createExit(id, h.owner, exitBody("1"))));
    const results = await Promise.all(racers);

    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, `exactly one full-volume exit wins (got ${winners.length})`);
    for (const loser of results.filter((r) => !r.ok)) {
      assert.ok(isExactConflict(loser) || isExactOverAllocation(loser),
        `loser ∈ {exact 409 CONFLICT, exact 422 EXIT_VOLUME_EXCEEDED}, got ${JSON.stringify(loser)}`);
    }
    const p = await projection(h.pool, id);
    assert.equal(p.allocated, "1.00000000", "allocation exactly the trade volume, scale 8");
    assert.equal((await activeExits(h.pool, id)).length, 1, "exactly one exit row — no partial loser rows");
    assert.equal(p.version, "1", "one committed mutation");
    assert.equal(await countEvents(h.pool, id), 2, "one EXIT_RECORDED event — no lost, no duplicate");
  } finally {
    await h.close();
  }
});

test("PG D4 D2: concurrent PARTIAL exits (8 × 0.2, two services) → every failure exact 409/422; allocation == 0.2 × successes exactly; never over-allocated", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);

    const racers = Array.from({ length: 8 }, (_, i) =>
      attempt((i % 2 === 0 ? h.svcA : h.svcB).createExit(id, h.owner, exitBody("0.2"))));
    const results = await Promise.all(racers);

    const k = results.filter((r) => r.ok).length;
    assert.ok(k >= 1 && k <= 5, `successes within the physical allocation bound (got ${k})`);
    for (const loser of results.filter((r) => !r.ok)) {
      assert.ok(isExactConflict(loser) || isExactOverAllocation(loser),
        `loser ∈ {exact 409, exact 422 over-allocation}, got ${JSON.stringify(loser)}`);
    }
    const p = await projection(h.pool, id);
    assert.equal(p.allocated, tenths(k), `allocated == 0.2 × k exactly (k=${k}), scale 8`);
    const exits = await activeExits(h.pool, id);
    assert.equal(exits.length, k, "exit rows == successes (no partial/duplicate rows)");
    assert.equal(p.version, String(k), "version advanced once per committed exit");
    assert.equal(await countEvents(h.pool, id), k + 1, "TRADE_CREATED + one event per success — zero lost events");
    // financial bound: allocation can never exceed the trade volume
    assert.ok(Number(p.allocated) <= 1, "never over-allocated");
  } finally {
    await h.close();
  }
});

test("PG D4 E: createExit vs deleteExit race → winner-set invariants; allocation increment/decrement stays exactly consistent", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);
    const pre = await h.svcA.createExit(id, h.owner, exitBody("0.3")); // allocated 0.3, version 1
    const preExitId = String((pre as { id: unknown }).id);

    const [createRes, cancelRes] = await Promise.all([
      attempt(h.svcA.createExit(id, h.owner, exitBody("0.5"))),
      attempt(h.svcB.deleteExit(preExitId, h.owner)),
    ]);

    const k = [createRes, cancelRes].filter((r) => r.ok).length;
    assert.ok(k === 1 || k === 2, `winner count ∈ {1, 2}, got ${k}`);
    for (const loser of [createRes, cancelRes].filter((r) => !r.ok)) {
      // the trade row stays active in this race ⇒ loser is always an exact 409
      assert.ok(isExactConflict(loser), `loser exact 409, got ${JSON.stringify(loser)}`);
    }

    const p = await projection(h.pool, id);
    const exits = await activeExits(h.pool, id);
    assert.equal(p.version, String(1 + k), "version advanced once per committed mutation");
    if (k === 2) {
      // serialized both (either order): 0.3 + 0.5 − 0.3 = 0.5 exactly
      assert.equal(p.allocated, "0.50000000", "increment + decrement both applied exactly (order-independent)");
      assert.equal(exits.length, 1, "the cancelled exit is tombstoned; the created exit remains");
      assert.equal(exits[0].volume, "0.50000000", "remaining active exit is the created 0.5");
    } else if (createRes.ok) {
      assert.equal(p.allocated, "0.80000000", "create won ⇒ 0.3 + 0.5 applied exactly");
      assert.equal(exits.length, 2, "both exits active");
    } else {
      assert.equal(p.allocated, "0.00000000", "cancel won ⇒ 0.3 − 0.3 decremented exactly");
      assert.equal(exits.length, 0, "cancelled exit tombstoned, none active");
    }
    assert.equal(await countEvents(h.pool, id), 2 + k, "created + first exit + one event per committed race mutation");
  } finally {
    await h.close();
  }
});

test("PG D4 F/N: tombstone finality — every mutation path non-disclosing 404; no resurrection; version frozen; no new events", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    const created = await h.svcA.createExit(id, h.owner, exitBody("0.25"));
    const exitId = String((created as { id: unknown }).id);
    await h.svcA.deleteTrade(id, h.owner);
    racedTradeIds.push(id);
    const before = await projection(h.pool, id);
    const eventsBefore = await countEvents(h.pool, id);

    // every mutation path against the tombstoned trade → exact non-disclosing 404
    const edit = await attempt(h.svcB.updateTrade(id, h.owner, { notes: "zombie" }));
    const exit = await attempt(h.svcB.createExit(id, h.owner, exitBody("0.1")));
    const again = await attempt(h.svcB.deleteTrade(id, h.owner));
    const cancel = await attempt(h.svcB.deleteExit(exitId, h.owner));
    const read = await attempt(h.svcB.getTrade(id, h.owner));
    for (const r of [edit, exit, again, cancel, read]) {
      assert.ok(r.status === 404 && r.code === "NOT_FOUND", `tombstoned ≡ missing (non-disclosing 404), got ${JSON.stringify(r)}`);
    }
    assert.equal(edit.message, "Trade not found.", "exact trade-404 message");
    assert.equal(cancel.message, "Trade exit not found.", "exact exit-404 message");
    // a NEVER-EXISTENT id returns the byte-identical trade-404 (non-disclosure)
    const ghost = await attempt(h.svcB.updateTrade("999999999", h.owner, { notes: "x" }));
    assert.equal(ghost.status, 404, "ghost id → 404");
    assert.equal(ghost.code, "NOT_FOUND", "ghost id → NOT_FOUND");
    assert.equal(ghost.message, edit.message, "tombstoned ≡ never-existed (indistinguishable)");

    const after = await projection(h.pool, id);
    assert.equal(after.version, before.version, "version frozen — no resurrection bump");
    assert.notEqual(after.deletedAt, null, "still tombstoned");
    assert.equal(after.notes, before.notes, "no post-tombstone journaling change");
    assert.equal(await countEvents(h.pool, id), eventsBefore, "zero post-tombstone events");
    // physical row preserved (tombstone, never a physical delete)
    const phys = await h.pool.query("SELECT deleted_at FROM trades WHERE id = $1", [id]);
    assert.equal(phys.rows.length, 1, "physical row still present (immutable ledger)");
  } finally {
    await h.close();
  }
});

test("PG D4 G: over-allocation → 422 with FULL rollback — no partial exit row, no partial event, projection intact (serial + concurrent)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // serial: a second exit that cannot fit fails honestly and leaves nothing
    const id1 = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id1);
    const first = await attempt(h.svcA.createExit(id1, h.owner, exitBody("1")));
    assert.ok(first.ok, "first full-volume exit succeeds");
    const second = await attempt(h.svcB.createExit(id1, h.owner, exitBody("0.5")));
    assert.ok(isExactOverAllocation(second), `second exit → exact 422 EXIT_VOLUME_EXCEEDED, got ${JSON.stringify(second)}`);
    let p = await projection(h.pool, id1);
    assert.equal(p.allocated, "1.00000000", "allocation unchanged by the failed attempt");
    assert.equal((await activeExits(h.pool, id1)).length, 1, "no partial exit row from the rollback");
    assert.equal(await countEvents(h.pool, id1), 2, "no event for the failed attempt");

    // concurrent: two 0.6 exits cannot both fit (0.6 + 0.6 > 1.0)
    const id2 = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id2);
    const [a, b] = await Promise.all([
      attempt(h.svcA.createExit(id2, h.owner, exitBody("0.6"))),
      attempt(h.svcB.createExit(id2, h.owner, exitBody("0.6"))),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    assert.equal(winners.length, 1, "exactly one 0.6 exit fits");
    const loser = a.ok ? b : a;
    assert.ok(isExactConflict(loser) || isExactOverAllocation(loser), `loser exact 409/422, got ${JSON.stringify(loser)}`);
    p = await projection(h.pool, id2);
    assert.equal(p.allocated, "0.60000000", "exactly the winner's volume committed");
    assert.equal((await activeExits(h.pool, id2)).length, 1, "loser's exit fully rolled back");
    assert.equal(await countEvents(h.pool, id2), 2, "one event for the winner only");
  } finally {
    await h.close();
  }
});

test("PG D4 H: lock release after failure — failed transactions release row locks; subsequent mutations complete within explicit timeouts", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);
    const created = await h.svcA.createExit(id, h.owner, exitBody("0.4"));
    const exitId = String((created as { id: unknown }).id);

    // a burst of failing mutations (over-allocation + stale CAS) must release locks
    const failures = await Promise.all([
      attempt(h.svcA.createExit(id, h.owner, exitBody("0.9"))), // over-allocation → rollback
      attempt(h.svcB.updateTrade(id, h.owner, { notes: "stale", version: 0 })), // stale CAS
      attempt(h.svcA.createExit(id, h.owner, exitBody("0.9"))), // over-allocation again
    ]);
    assert.ok(failures.every((r) => !r.ok), "all three fail as expected");

    // subsequent operations complete promptly — locks were released, no deadlock
    const edit = await attempt(h.svcB.updateTrade(id, h.owner, { notes: "after-failure" }));
    assert.ok(edit.ok, "post-failure edit succeeds (locks released)");
    const cancel = await attempt(h.svcA.deleteExit(exitId, h.owner));
    assert.ok(cancel.ok, "post-failure exit cancel succeeds");
    const p = await projection(h.pool, id);
    assert.equal(p.allocated, "0.00000000", "cancel decremented after the failure burst");
    assert.equal(p.version, "3", "exit(1) + edit(1) + cancel(1) committed — failures bumped nothing");
    assert.equal(await countEvents(h.pool, id), 4, "zero events from failures, three from successes");
  } finally {
    await h.close();
  }
});

test("PG D4 I/J: duplicate event_uid → honest constraint failure with FULL rollback (idempotency boundary; replay convergence is Phase H)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // store-level: the service mints unique UIDs, so the duplicate is driven at
    // the store boundary — proving the DB constraint fails CLOSED and the whole
    // transaction (projection + event) rolls back together.
    const first = await h.store.createTrade(
      {
        userId: h.other, accountId: null, symbol: "EURUSD", direction: "sell", status: "CLOSED",
        entryPrice: "1.10000000", exitPrice: "1.09500000", volume: "1.00000000",
        contractSize: "100000.00000000", commission: "2.00", swap: "0.00", netPnl: "500.00",
        rMultiple: "1.00000000", stopLoss: null, takeProfit: null, strategy: null, emotion: null,
        notes: "dup probe", openAtUtc: T0.toISOString(), closeAtUtc: T0.toISOString(),
        timeStatus: "resolved", sourceTimezone: "UTC", sourceTimezoneSource: "user_config",
        sourceCalendar: "proleptic-gregorian", rawOpenText: null, rawCloseText: null, source: "manual", externalDealId: null,
      },
      { eventUid: "d4-fixed-uid-001", tradeId: "", type: "TRADE_CREATED", actor: "user", expectedVersion: 0, payload: { probe: "d4" }, at: T0.toISOString() },
    );
    assert.ok(first.id !== undefined, "first insert with the fixed uid succeeds");

    const beforeTrades = (await h.pool.query("SELECT count(*)::int AS n FROM trades WHERE user_id = $1", [h.other])).rows[0] as { n: number };
    let duplicateThrew = false;
    try {
      await h.store.createTrade(
        {
          userId: h.other, accountId: null, symbol: "USDJPY", direction: "buy", status: "CLOSED",
          entryPrice: "150.00000000", exitPrice: "151.00000000", volume: "1.00000000",
          contractSize: "1.00000000", commission: "1.00", swap: "0.00", netPnl: "100.00",
          rMultiple: null, stopLoss: null, takeProfit: null, strategy: null, emotion: null,
          notes: "dup probe 2", openAtUtc: T0.toISOString(), closeAtUtc: T0.toISOString(),
          timeStatus: "resolved", sourceTimezone: "UTC", sourceTimezoneSource: "user_config",
          sourceCalendar: "proleptic-gregorian", rawOpenText: null, rawCloseText: null, source: "manual", externalDealId: null,
        },
        { eventUid: "d4-fixed-uid-001", tradeId: "", type: "TRADE_CREATED", actor: "user", expectedVersion: 0, payload: { probe: "d4" }, at: T0.toISOString() },
      );
    } catch {
      duplicateThrew = true; // honest failure — never a false success
    }
    assert.ok(duplicateThrew, "duplicate event_uid FAILS (constraint honesty)");
    const afterTrades = (await h.pool.query("SELECT count(*)::int AS n FROM trades WHERE user_id = $1", [h.other])).rows[0] as { n: number };
    assert.equal(afterTrades.n, beforeTrades.n, "FULL rollback: the duplicate's projection row did not survive");
    const uidCount = (await h.pool.query("SELECT count(*)::int AS n FROM trade_events WHERE event_uid = $1", ["d4-fixed-uid-001"])).rows[0] as { n: number };
    assert.equal(uidCount.n, 1, "exactly one event with the shared uid — no partial duplicate event");
  } finally {
    await h.close();
  }
});

test("PG D4 K: NUMERIC exactness after races — ADR-001 scales as exact strings through the whole race lifecycle", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    const id = await newTrade(h.svcA, h.owner);
    racedTradeIds.push(id);
    await h.svcA.createExit(id, h.owner, exitBody("0.25"));
    await h.svcA.createExit(id, h.owner, exitBody("0.75"));

    const row = (await h.pool.query(
      "SELECT entry_price::text AS entry, volume::text AS vol, allocated_volume::text AS alloc, commission::text AS comm, swap::text AS swap FROM trades WHERE id = $1",
      [id],
    )).rows[0] as Record<string, string>;
    // the driver must return NUMERIC as EXACT STRINGS (D1 law) at the declared scales
    assert.match(row.entry, /^-?\d+\.\d{8}$/, "entry_price scale-8 exact string");
    assert.match(row.vol, /^-?\d+\.\d{8}$/, "volume scale-8 exact string");
    assert.match(row.alloc, /^-?\d+\.\d{8}$/, "allocated_volume scale-8 exact string");
    assert.match(row.comm, /^-?\d+\.\d{2}$/, "commission scale-2 exact string");
    assert.match(row.swap, /^-?\d+\.\d{2}$/, "swap scale-2 exact string");
    assert.equal(row.alloc, "1.00000000", "0.25 + 0.75 applied exactly inside PostgreSQL (no float path)");

    const exits = (await h.pool.query(
      "SELECT volume::text AS vol, price::text AS price, pnl::text AS pnl FROM trade_exits WHERE trade_id = $1 AND deleted_at IS NULL ORDER BY id",
      [id],
    )).rows as Record<string, string>[];
    assert.equal(exits.length, 2, "both exits present");
    for (const e of exits) {
      assert.match(e.vol, /^-?\d+\.\d{8}$/, "exit volume scale-8 exact string");
      assert.match(e.price, /^-?\d+\.\d{8}$/, "exit price scale-8 exact string");
      assert.match(e.pnl, /^-?\d+\.\d{2}$/, "exit pnl scale-2 exact string");
    }
    // no float conversion anywhere in the pipeline: values round-trip byte-stable
    const again = await projection(h.pool, id);
    assert.equal(again.allocated, row.alloc, "stable on re-read");
  } finally {
    await h.close();
  }
});

test("PG D4 L/M: no lost events + bounded replay — projection == fold(trade_events) for every raced sequence (ADR-002)", { skip: SKIP }, async () => {
  const h = await harness();
  try {
    // deterministic mixed sequence first (create → edit → exit → exit → cancel → edit → tombstone)
    const id = await newTrade(h.svcA, h.owner);
    await h.svcA.updateTrade(id, h.owner, { notes: "seq-1" });
    const e1 = await h.svcA.createExit(id, h.owner, exitBody("0.3"));
    await h.svcA.createExit(id, h.owner, exitBody("0.2"));
    await h.svcA.deleteExit(String((e1 as { id: unknown }).id), h.owner);
    await h.svcB.updateTrade(id, h.owner, { notes: "seq-2", strategyTag: "fade" });
    await h.svcA.deleteTrade(id, h.owner);
    racedTradeIds.push(id);

    // fold EVERY raced trade in this battery (incl. all races above)
    const ids = [...new Set(racedTradeIds)];
    assert.ok(ids.length >= 10, `replaying every raced trade (got ${ids.length})`);
    for (const tid of ids) {
      const evRows = (await h.pool.query(
        "SELECT payload FROM trade_events WHERE trade_id = $1 ORDER BY id",
        [tid],
      )).rows as { payload: { event?: LedgerEvent } }[];
      assert.ok(evRows.length >= 1, "every raced trade has its TRADE_CREATED event (no lost events)");
      let state: TradeState | null = null;
      for (const r of evRows) {
        const e = r.payload.event;
        assert.ok(e !== undefined && typeof e.type === "string", "stored payload embeds the foldable domain event");
        state = applyEvent(state, e as LedgerEvent); // throws on ANY inconsistency
      }
      const row = (await h.pool.query(
        "SELECT version, allocated_volume, deleted_at, notes, strategy FROM trades WHERE id = $1",
        [tid],
      )).rows[0] as { version: string; allocated_volume: string; deleted_at: Date | null; notes: string | null; strategy: string | null };
      assert.ok(state !== null, `trade ${tid} folded to a state`);
      assert.equal(String(state.version), String(row.version), `trade ${tid}: replay version == projection version`);
      assert.equal(scale8(state.allocatedVolume), scale8(String(row.allocated_volume)), `trade ${tid}: replay allocation == projection (scale-8 normalized; domain zero "0" ≡ PG "0.00000000")`);
      assert.equal(state.deletedAt !== null, row.deleted_at !== null, `trade ${tid}: replay tombstone state == projection`);
      assert.equal(state.journaling.notes ?? null, row.notes, `trade ${tid}: replay notes == projection`);
      assert.equal(state.journaling.strategy ?? null, row.strategy, `trade ${tid}: replay strategy == projection`);
    }
    // the deterministic sequence's final state, explicitly
    const seq = await projection(h.pool, id);
    assert.equal(seq.version, "6", "7 events (create..tombstone) ⇒ version 6");
    assert.notEqual(seq.deletedAt, null, "sequence ended tombstoned");
    assert.equal(seq.allocated, "0.20000000", "0.3 + 0.2 − 0.3 = 0.2 exactly");
    assert.equal(await countEvents(h.pool, id), 7, "no lost events across the full sequence");
  } finally {
    await h.close();
  }
});
