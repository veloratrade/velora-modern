// Phase 3B-2 — trade lifecycle contract tests.
//
// Covers ONLY the behaviour introduced or changed by Phase 3B-2, against the
// frozen owner contract:
//   OD-2  tombstone-only delete, 204, mandatory optimistic concurrency
//   OD-3  canonical event vocabulary, transactional emission, no orphan events
//   OD-4  raw operator input retained verbatim (owner answer 2026-09-14: (B) —
//         ADR-004 D-11 profile-TZ resolution stands for MANUAL trades; OD-4
//         broker/import precedence applies to imported/synced trades, which do
//         not exist in this phase)
//   OD-6  single canonical financial field; net_pnl recomputed from the
//         realized exit ledger (owner answer 2026-09-14: "recompute")
//
// Pre-existing behaviour already covered by tradeService.test.ts /
// tradeRoutes.test.ts is NOT duplicated here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TradeService, TradeError } from "./tradeService.js";
import { MemoryTradeStore } from "./memoryTradeStore.js";

const OWNER = "1";
const OTHER = "2";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function makeService(opts?: { timezone?: string }): { svc: TradeService; store: MemoryTradeStore } {
  const store = new MemoryTradeStore();
  const svc = new TradeService({
    store,
    getUserTimezone: async () => opts?.timezone ?? "UTC",
    verifyAccountOwnership: async () => false,
    now: () => NOW,
    newEventUid: (() => {
      let n = 0;
      return () => `evt-3b2-${++n}`;
    })(),
  });
  return { svc, store };
}

/**
 * Golden vector A. entry 1.1000 → exit 1.1050, volume 1, contract 100000:
 * gross = 0.0050 × 1 × 100000 = 500.00; net = 500 − 5 − 1.50 = 493.50.
 * risk = (1.1000 − 1.0970) × 1 × 100000 = 300.00 → R = 493.50/300 = 1.645.
 */
const VECTOR_A = {
  symbol: "EURUSD",
  direction: "buy",
  entryPrice: "1.1000",
  exitPrice: "1.1050",
  volume: "1.0",
  contractSize: "100000",
  commission: "5.00",
  swap: "1.50",
  stopLoss: "1.0970",
  openTime: "2026-09-10 10:00:00",
  closeTime: "2026-09-10 12:00:00",
} as const;

async function seedTrade(
  svc: TradeService,
  over: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const t = (await svc.createTrade(OWNER, { ...VECTOR_A, ...over })) as { id: string; version: number };
  return { id: t.id, version: t.version };
}

async function expectErr(p: Promise<unknown>, status: number, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof TradeError, `expected TradeError, got ${String(e)}`);
    assert.equal(e.status, status, `status: ${e.message}`);
    assert.equal(e.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// OD-2 — DELETE: mandatory optimistic concurrency
// ---------------------------------------------------------------------------

test("3B-2 delete: CURRENT version succeeds and tombstones", async () => {
  const { svc, store } = makeService();
  const { id, version } = await seedTrade(svc);
  assert.deepEqual(await svc.deleteTrade(id, OWNER, version), { deleted: true });
  await expectErr(svc.getTrade(id, OWNER), 404, "NOT_FOUND"); // excluded from reads
  assert.equal(store.eventLog().filter((e) => e.type === "TOMBSTONE_SET").length, 1);
});

test("3B-2 delete: STALE version => 409, NO mutation, NO event (OD-2 + OD-3 atomicity)", async () => {
  const { svc, store } = makeService();
  const { id, version } = await seedTrade(svc);
  const before = store.eventLog().length;

  await expectErr(svc.deleteTrade(id, OWNER, version + 5), 409, "CONFLICT");

  // No event was appended for the failed mutation.
  assert.equal(store.eventLog().length, before);
  assert.equal(store.eventLog().some((e) => e.type === "TOMBSTONE_SET"), false);
  // And the trade is still very much alive.
  const alive = (await svc.getTrade(id, OWNER)) as { id: string; version: number };
  assert.equal(alive.id, id);
  assert.equal(alive.version, version);
});

test("3B-2 delete: malformed version is rejected before any state change", async () => {
  const { svc, store } = makeService();
  const { id } = await seedTrade(svc);
  const before = store.eventLog().length;
  await expectErr(svc.deleteTrade(id, OWNER, "not-a-number"), 400, "VALIDATION_FAILED");
  await expectErr(svc.deleteTrade(id, OWNER, -1), 400, "VALIDATION_FAILED");
  assert.equal(store.eventLog().length, before);
  assert.ok(await svc.getTrade(id, OWNER));
});

test("3B-2 delete: ownership beats concurrency — foreign trade is 404 even with the right version", async () => {
  const { svc, store } = makeService();
  const { id, version } = await seedTrade(svc);
  const before = store.eventLog().length;
  await expectErr(svc.deleteTrade(id, OTHER, version), 404, "NOT_FOUND");
  assert.equal(store.eventLog().length, before); // no event for a rejected delete
});

test("3B-2 delete: tombstone is NOT a physical delete — the row and its history survive", async () => {
  const { svc, store } = makeService();
  const { id, version } = await seedTrade(svc);
  await svc.deleteTrade(id, OWNER, version);

  // Physical row still present (read through the store, bypassing the service
  // filter) with deleted_at set — OD-2 "recoverable/auditable at data level".
  const raw = store.debugRow(id);
  assert.ok(raw !== null, "physical row must remain");
  assert.equal(raw!.deletedAt, NOW.toISOString());
  // Full event history retained.
  assert.deepEqual(
    store.eventLog().filter((e) => e.tradeId === id).map((e) => e.type),
    ["TRADE_CREATED", "TOMBSTONE_SET"],
  );
});

// ---------------------------------------------------------------------------
// OD-6 — net_pnl recomputed from the realized exit ledger
// ---------------------------------------------------------------------------

test("3B-2 exits: single PARTIAL exit recomputes canonical net_pnl (half the position)", async () => {
  const { svc } = makeService();
  const { id } = await seedTrade(svc);

  // Exit half the volume at the original exit price.
  // gross = 0.0050 × 0.5 × 100000 = 250.00
  // allocated commission = 5.00 × 0.5 = 2.50; swap = 1.50 × 0.5 = 0.75
  // exit pnl = 250 − 2.50 − 0.75 = 246.75
  await svc.createExit(id, OWNER, {
    exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:00:00",
  });

  const t = (await svc.getTrade(id, OWNER)) as { profitLoss: string; rMultiple: string | null };
  assert.equal(t.profitLoss, "246.75");
  // R = 246.75 / 300.00 = 0.8225 (risk is the ORIGINAL position risk)
  assert.equal(t.rMultiple, "0.8225");
});

test("3B-2 exits: MULTIPLE partial exits accumulate to the full realized figure", async () => {
  const { svc } = makeService();
  const { id } = await seedTrade(svc);

  await svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:00:00" });
  await svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:30:00" });

  // Two halves at the same price == the whole position: 246.75 + 246.75 = 493.50,
  // which equals the original close-price net P/L. Costs are NOT double-counted.
  const t = (await svc.getTrade(id, OWNER)) as { profitLoss: string; rMultiple: string | null };
  assert.equal(t.profitLoss, "493.5");
  assert.equal(t.rMultiple, "1.645");
});

test("3B-2 exits: FULL exit in one allocation equals the close-price figure", async () => {
  const { svc } = makeService();
  const { id } = await seedTrade(svc);
  await svc.createExit(id, OWNER, { exitType: "manual", exitPrice: "1.1050", volume: "1.0", exitedAt: "2026-09-10 11:00:00" });
  const t = (await svc.getTrade(id, OWNER)) as { profitLoss: string };
  assert.equal(t.profitLoss, "493.5");
});

test("3B-2 exits: SELL direction recomputes with inverted gross", async () => {
  const { svc } = makeService();
  // sell 1.1050 → 1.1000 is a WIN: gross = (1.1050 − 1.1000) × 1 × 100000 = 500
  const { id } = await seedTrade(svc, {
    direction: "sell", entryPrice: "1.1050", exitPrice: "1.1000", stopLoss: "1.1080",
  });
  await svc.createExit(id, OWNER, { exitType: "manual", exitPrice: "1.1000", volume: "1.0", exitedAt: "2026-09-10 11:00:00" });
  const t = (await svc.getTrade(id, OWNER)) as { profitLoss: string; rMultiple: string | null };
  assert.equal(t.profitLoss, "493.5");
  // sell risk = (SL − entry) = (1.1080 − 1.1050) × 100000 = 300.00 → 1.645
  assert.equal(t.rMultiple, "1.645");
});

test("3B-2 exits: CANCELLATION recomputes from the exits that remain", async () => {
  const { svc } = makeService();
  const { id } = await seedTrade(svc);

  const a = (await svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:00:00" })) as { id: string };
  await svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:30:00" });
  assert.equal(((await svc.getTrade(id, OWNER)) as { profitLoss: string }).profitLoss, "493.5");

  await svc.deleteExit(a.id, OWNER);

  // One half remains.
  const t = (await svc.getTrade(id, OWNER)) as { profitLoss: string };
  assert.equal(t.profitLoss, "246.75");
  // Cancelling the last exit returns the realized ledger to zero.
  const remaining = ((await svc.listExits(id, OWNER)) as { items: { id: string }[] }).items;
  await svc.deleteExit(remaining[0]!.id, OWNER);
  assert.equal(((await svc.getTrade(id, OWNER)) as { profitLoss: string }).profitLoss, "0");
});

test("3B-2 exits: undefined risk keeps rMultiple NULL after recompute (no fabricated fallback)", async () => {
  for (const over of [
    { stopLoss: undefined },            // no SL
    { stopLoss: "1.2000" },             // wrong-side SL for a buy (above entry)
  ]) {
    const { svc } = makeService();
    const { id } = await seedTrade(svc, over);
    await svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:00:00" });
    const t = (await svc.getTrade(id, OWNER)) as { profitLoss: string; rMultiple: string | null };
    assert.equal(t.profitLoss, "246.75"); // P/L still computed
    assert.equal(t.rMultiple, null, `rMultiple must stay null for ${JSON.stringify(over)}`);
  }
});

test("3B-2 exits: over-allocation is rejected and leaves financials untouched", async () => {
  const { svc, store } = makeService();
  const { id } = await seedTrade(svc);
  await svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.6", exitedAt: "2026-09-10 11:00:00" });
  const afterFirst = (await svc.getTrade(id, OWNER)) as { profitLoss: string };
  const events = store.eventLog().length;

  // 0.6 + 0.5 > 1.0
  await expectErr(
    svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:15:00" }),
    422, "VALIDATION_FAILED",
  );

  // Rejected mutation => no event, no financial change.
  assert.equal(store.eventLog().length, events);
  assert.equal(((await svc.getTrade(id, OWNER)) as { profitLoss: string }).profitLoss, afterFirst.profitLoss);
});

test("3B-2 exits: invalid price/volume rejected before any state change", async () => {
  const { svc, store } = makeService();
  const { id } = await seedTrade(svc);
  const before = store.eventLog().length;
  const base = { exitType: "partial", exitedAt: "2026-09-10 11:00:00" };

  await expectErr(svc.createExit(id, OWNER, { ...base, exitPrice: "0", volume: "0.5" }), 400, "VALIDATION_FAILED");
  await expectErr(svc.createExit(id, OWNER, { ...base, exitPrice: "1.1050", volume: "0" }), 400, "VALIDATION_FAILED");
  await expectErr(svc.createExit(id, OWNER, { ...base, exitPrice: "1.1050", volume: "-1" }), 400, "VALIDATION_FAILED");
  await expectErr(svc.createExit(id, OWNER, { ...base, exitPrice: "abc", volume: "0.5" }), 400, "VALIDATION_FAILED");

  assert.equal(store.eventLog().length, before);
  assert.equal(((await svc.getTrade(id, OWNER)) as { profitLoss: string }).profitLoss, "493.5"); // untouched
});

// ---------------------------------------------------------------------------
// OD-3 — event vocabulary + transactional emission
// ---------------------------------------------------------------------------

test("3B-2 events: lifecycle emits ONLY canonical types, with unique event_uid", async () => {
  const CANONICAL = new Set([
    "TRADE_IMPORTED", "TRADE_CREATED", "FINANCIAL_CORRECTED", "JOURNALING_EDITED",
    "EXIT_RECORDED", "EXIT_CANCELLED", "TOMBSTONE_SET", "ADMIN_CORRECTION", "QUARANTINE_RAISED",
  ]);
  const { svc, store } = makeService();
  const { id } = await seedTrade(svc);
  const ex = (await svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:00:00" })) as { id: string };
  await svc.updateTrade(id, OWNER, { notes: "journal" });
  await svc.deleteExit(ex.id, OWNER);
  const current = (await svc.getTrade(id, OWNER)) as { version: number };
  await svc.deleteTrade(id, OWNER, current.version);

  const log = store.eventLog().filter((e) => e.tradeId === id);
  assert.deepEqual(log.map((e) => e.type), [
    "TRADE_CREATED", "EXIT_RECORDED", "JOURNALING_EDITED", "EXIT_CANCELLED", "TOMBSTONE_SET",
  ]);
  for (const e of log) {
    assert.ok(CANONICAL.has(e.type), `non-canonical event ${e.type}`);
    assert.equal(e.actor, "user"); // explicit actor semantics
    assert.equal(typeof e.expectedVersion, "number");
  }
  const uids = log.map((e) => e.eventUid);
  assert.equal(new Set(uids).size, uids.length, "event_uid must be unique");
});

test("3B-2 events: every successful mutation bumps version exactly once", async () => {
  const { svc } = makeService();
  const { id, version } = await seedTrade(svc);
  const v = async (): Promise<number> => ((await svc.getTrade(id, OWNER)) as { version: number }).version;

  assert.equal(version, 0);
  await svc.createExit(id, OWNER, { exitType: "partial", exitPrice: "1.1050", volume: "0.5", exitedAt: "2026-09-10 11:00:00" });
  assert.equal(await v(), 1);
  await svc.updateTrade(id, OWNER, { notes: "n" });
  assert.equal(await v(), 2);
});

// ---------------------------------------------------------------------------
// OD-4 — raw input retention (owner answer (B): profile-TZ resolution stands)
// ---------------------------------------------------------------------------

test("3B-2 timezone: raw operator input is retained verbatim", async () => {
  const { svc } = makeService({ timezone: "Asia/Tehran" });
  const { id } = await seedTrade(svc);
  const t = (await svc.getTrade(id, OWNER)) as Record<string, unknown>;

  // Raw text preserved exactly as submitted — never overwritten by the
  // derived UTC instant (OD-4 "unresolved timestamps retain raw input";
  // retained unconditionally so the original survives re-interpretation).
  assert.equal(t.rawOpenText, "2026-09-10 10:00:00");
  assert.equal(t.rawCloseText, "2026-09-10 12:00:00");
  // Canonical storage remains UTC and is genuinely converted (Tehran = +03:30).
  assert.equal(t.occurredOpenAtUtc, "2026-09-10T06:30:00.000Z");
  assert.equal(t.timeStatus, "resolved");
  assert.equal(t.sourceTimezone, "Asia/Tehran");
});

test("3B-2 timezone: an EXPLICIT offset wins and is not reinterpreted", async () => {
  const { svc } = makeService({ timezone: "Asia/Tehran" });
  const { id } = await seedTrade(svc, {
    openTime: "2026-09-10T10:00:00+02:00",
    closeTime: "2026-09-10T12:00:00+02:00",
  });
  const t = (await svc.getTrade(id, OWNER)) as Record<string, unknown>;
  assert.equal(t.occurredOpenAtUtc, "2026-09-10T08:00:00.000Z"); // +02:00 honoured, NOT +03:30
  assert.equal(t.rawOpenText, "2026-09-10T10:00:00+02:00");
});

test("3B-2 timezone: an invalid profile timezone yields UNRESOLVED, never a guess", async () => {
  const { svc } = makeService({ timezone: "Not/AZone" });
  const { id } = await seedTrade(svc);
  const t = (await svc.getTrade(id, OWNER)) as Record<string, unknown>;
  assert.equal(t.timeStatus, "unresolved");
  assert.equal(t.sourceTimezone, null);
  assert.equal(t.sourceTimezoneSource, "unknown");
  assert.equal(t.rawOpenText, "2026-09-10 10:00:00"); // raw still retained
});

// ---------------------------------------------------------------------------
// OD-1 — journal field contract
// ---------------------------------------------------------------------------

test("3B-2 journal: OD-1 keeps exactly strategyTag/emotionalScore/notes and never exposes `setup`", async () => {
  const { svc } = makeService();
  const { id } = await seedTrade(svc, { strategyTag: "Breakout", emotionalScore: 4, notes: "ok" });
  const t = (await svc.getTrade(id, OWNER)) as Record<string, unknown>;

  assert.equal(t.strategyTag, "Breakout");
  assert.equal(t.emotionalScore, 4);
  assert.equal(t.notes, "ok");
  // Dropped/never-exposed capabilities (OD-1).
  for (const dead of ["setup", "strategy", "emotion", "confidence", "mistake", "marketContext", "market_context", "lotSize", "lot_size"]) {
    assert.equal(dead in t, false, `${dead} must not be exposed by the API`);
  }
});

test("3B-2 journal: OD-1 bounds enforced (64 / 1-5 / 5000)", async () => {
  const { svc } = makeService();
  const { id } = await seedTrade(svc);
  await expectErr(svc.updateTrade(id, OWNER, { strategyTag: "x".repeat(65) }), 400, "VALIDATION_FAILED");
  await expectErr(svc.updateTrade(id, OWNER, { notes: "x".repeat(5001) }), 400, "VALIDATION_FAILED");
  for (const bad of [0, 6, 2.5, "abc"]) {
    await expectErr(svc.updateTrade(id, OWNER, { emotionalScore: bad }), 400, "VALIDATION_FAILED");
  }
  // Boundaries are accepted.
  await svc.updateTrade(id, OWNER, { strategyTag: "x".repeat(64), notes: "y".repeat(5000), emotionalScore: 1 });
  const t = (await svc.getTrade(id, OWNER)) as { emotionalScore: number };
  assert.equal(t.emotionalScore, 1);
});
