// TradeService tests — Phase C increment 3. Service-level evidence for the
// ADR-002 trades ledger: validation matrix (Remote/PHP), ownership, journaling
// corrections, tombstones, exit allocation + cancellation, optimistic
// concurrency, ADR-004 time interpretation, PnL linkage (Local engine,
// half-even), deterministic serialization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TradeService, TradeError } from "./tradeService.js";
import { MemoryTradeStore } from "./memoryTradeStore.js";

const OWNER = "1";
const OTHER = "2";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function makeService(opts?: {
  timezone?: string;
  ownedAccounts?: Record<string, boolean>;
  now?: () => Date;
}): { svc: TradeService; store: MemoryTradeStore } {
  const store = new MemoryTradeStore();
  const owned = opts?.ownedAccounts ?? {};
  const svc = new TradeService({
    store,
    getUserTimezone: async (userId) => (userId === OWNER ? (opts?.timezone ?? "UTC") : "UTC"),
    verifyAccountOwnership: async (accountId, userId) => owned[`${userId}:${accountId}`] === true,
    now: opts?.now ?? (() => NOW),
    newEventUid: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
  });
  return { svc, store };
}

/** Remote integration-test payload = increment-2 golden vector A. */
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
  strategyTag: "Breakout",
  emotionalScore: 4,
  notes: "Clean H1 breakout trade",
};

async function expectTradeError(p: Promise<unknown>, status: number, code: string, detailsContains?: Record<string, string | number>): Promise<void> {
  await assert.rejects(
    p,
    (e: unknown) => {
      assert.ok(e instanceof TradeError, `expected TradeError, got ${e}`);
      assert.equal(e.status, status);
      assert.equal(e.code, code);
      if (detailsContains !== undefined) {
        for (const [k, v] of Object.entries(detailsContains)) assert.equal(e.details?.[k], v, `details.${k}`);
      }
      return true;
    },
  );
}

test("create: NO stop-loss → rMultiple null, PnL still computed (lineage parity, inc 8)", async () => {
  // PHP PnlCalculator::riskAmount + Remote riskAmount: no SL → null risk →
  // r_multiple NULL (serialized as JSON null; DB column nullable since 0001).
  // Inc-8 inventory §3: the former Local fallback (risk = |exit−entry|)
  // traced to an unimplemented PHP docblock and is removed.
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, {
    ...VECTOR_A, stopLoss: undefined,
  })) as Record<string, unknown>;
  assert.equal(t.profitLoss, "493.5"); // net unchanged — gross − commission − swap
  assert.equal(t.rMultiple, null);
});

test("create: WRONG-SIDE stop-loss (buy, SL above entry) → rMultiple null (lineage parity, inc 8)", async () => {
  // PHP: directional delta (buy: entry − SL) <= 0 → null risk ("SL on wrong
  // side — undefined risk"); Remote: identical. gross/net still computed.
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, {
    ...VECTOR_A, stopLoss: "1.2000",
  })) as Record<string, unknown>;
  assert.equal(t.profitLoss, "493.5");
  assert.equal(t.rMultiple, null);
});

test("create: zero stop-loss string → rejected (PHP MUST_BE_POSITIVE parity; engine zero-SL branch is defensive-only)", async () => {
  // PHP TradeService.php:100 rejects stopLoss <= 0 at validation — Local is
  // the exact port (inc 3). The engine's zero-SL → no-stop-loss branch
  // (PHP bccomp === 0 → null) is defensive parity below the validation layer
  // and is pinned at the engine level by VECTOR-8c.
  const { svc } = makeService();
  await expectTradeError(
    svc.createTrade(OWNER, { ...VECTOR_A, stopLoss: "0" } as Record<string, unknown>),
    400, "VALIDATION_FAILED", { field: "stopLoss", messageKey: "errors.validation.positive" },
  );
});

test("create: valid manual trade — vector A PnL via the Local engine, trimZeros serialization", async () => {
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  assert.equal(t.symbol, "EURUSD");
  assert.equal(t.direction, "buy");
  assert.equal(t.entryPrice, "1.1");
  assert.equal(t.exitPrice, "1.105");
  assert.equal(t.volume, "1");
  assert.equal(t.profitLoss, "493.5"); // golden vector A net (engine, half-even)
  assert.equal(t.rMultiple, "1.645"); // golden vector A r
  assert.equal(t.strategyTag, "Breakout");
  assert.equal(t.emotionalScore, 4);
  assert.equal(t.source, "manual");
  assert.equal(t.status === undefined, true); // status not in the Remote serialization
  assert.equal(t.version, 0);
  assert.equal(t.session, "unconfigured");
  assert.equal(typeof t.id, "string");
});

test("create: ADR-004 time interpretation — user profile TZ, explicit offsets, invalid-TZ fallback", async () => {
  // Asia/Tehran (+03:30): naive 10:00 local → 06:30Z
  const tehran = makeService({ timezone: "Asia/Tehran" });
  const t = (await tehran.svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  assert.equal(t.openTime, "2026-09-10T06:30:00.000Z");
  assert.equal(t.closeTime, "2026-09-10T08:30:00.000Z");
  assert.equal(t.occurredOpenAtUtc, "2026-09-10T06:30:00.000Z");
  assert.equal(t.timeStatus, "resolved");
  assert.equal(t.sourceTimezone, "Asia/Tehran");
  assert.equal(t.sourceTimezoneSource, "user_profile");
  assert.equal(t.sourceCalendar, "unknown");

  // explicit offset beats profile TZ (authoritative evidence)
  const explicit = (await tehran.svc.createTrade(OWNER, {
    ...VECTOR_A, openTime: "2026-09-10T10:00:00+02:00", closeTime: "2026-09-10T12:00:00+02:00",
  })) as Record<string, unknown>;
  assert.equal(explicit.openTime, "2026-09-10T08:00:00.000Z");

  // invalid profile TZ → UTC fallback, unresolved, no fabricated source
  const broken = makeService({ timezone: "Not/A_Zone" });
  const u = (await broken.svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  assert.equal(u.openTime, "2026-09-10T10:00:00.000Z");
  assert.equal(u.timeStatus, "unresolved");
  assert.equal(u.sourceTimezone, null);
  assert.equal(u.sourceTimezoneSource, "unknown");
});

test("create: validation matrix (Remote order and error shapes)", async () => {
  const { svc } = makeService();
  const cases: Array<[Record<string, unknown>, number, string, Record<string, string | number>]> = [
    [{ ...VECTOR_A, symbol: "  " }, 400, "VALIDATION_FAILED", { field: "symbol", messageKey: "errors.validation.required" }],
    [{ ...VECTOR_A, symbol: "bad symbol!" }, 400, "VALIDATION_FAILED", { field: "symbol", messageKey: "errors.validation.format" }],
    [{ ...VECTOR_A, direction: "hold" }, 400, "VALIDATION_FAILED", { field: "direction", messageKey: "errors.validation.choice" }],
    [{ ...VECTOR_A, accountId: "0x1" }, 400, "VALIDATION_FAILED", { field: "accountId", messageKey: "errors.validation.format" }],
    [{ ...VECTOR_A, entryPrice: "1.1.0" }, 400, "VALIDATION_FAILED", { field: "entryPrice", messageKey: "errors.validation.decimal" }],
    [{ ...VECTOR_A, exitPrice: "x" }, 400, "VALIDATION_FAILED", { field: "exitPrice", messageKey: "errors.validation.decimal" }],
    [{ ...VECTOR_A, volume: "0" }, 400, "VALIDATION_FAILED", { field: "volume", messageKey: "errors.validation.positive" }],
    [{ ...VECTOR_A, commission: "0.125" }, 400, "VALIDATION_FAILED", { field: "commission", messageKey: "errors.validation.decimal", maxFractionDigits: 2 }],
    [{ ...VECTOR_A, stopLoss: "-1" }, 400, "VALIDATION_FAILED", { field: "stopLoss", messageKey: "errors.validation.positive" }],
    [{ ...VECTOR_A, openTime: "Sep 10 2026" }, 400, "VALIDATION_FAILED", { field: "openTime", messageKey: "errors.validation.datetime" }],
    [{ ...VECTOR_A, openTime: "2026-02-30 10:00:00" }, 400, "VALIDATION_FAILED", { field: "openTime", messageKey: "errors.validation.datetime" }],
    [{ ...VECTOR_A, closeTime: "2026-09-10 09:00:00" }, 400, "VALIDATION_FAILED", { field: "closeTime", messageKey: "errors.validation.datetime" }],
    [{ ...VECTOR_A, strategyTag: "x".repeat(65) }, 400, "VALIDATION_FAILED", { field: "strategyTag", messageKey: "errors.validation.maxLength", max: 64 }],
    [{ ...VECTOR_A, notes: "x".repeat(5001) }, 400, "VALIDATION_FAILED", { field: "notes", messageKey: "errors.validation.maxLength", max: 5000 }],
    [{ ...VECTOR_A, emotionalScore: 6 }, 400, "VALIDATION_FAILED", { field: "emotionalScore", messageKey: "errors.validation.range", min: 1, max: 5 }],
    [{ ...VECTOR_A, emotionalScore: 2.5 }, 400, "VALIDATION_FAILED", { field: "emotionalScore", messageKey: "errors.validation.range" }],
  ];
  for (const [payload, status, code, details] of cases) {
    await expectTradeError(svc.createTrade(OWNER, payload), status, code, details);
  }
  // defaults: commission/swap/contractSize
  const d = (await svc.createTrade(OWNER, {
    symbol: "XAUUSD", direction: "sell", entryPrice: "2350.50", exitPrice: "2345.00",
    volume: "0.10", openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 11:00:00",
  })) as Record<string, unknown>;
  assert.equal(d.commission, "0");
  assert.equal(d.swap, "0");
  assert.equal(d.contractSize, "1");
  // sell: gross = (2350.50-2345.00)*0.1*1 = 0.55 → net 0.55 (no costs)
  assert.equal(d.profitLoss, "0.55");
});

test("create: account ownership verified before create (400 accountNotOwned — lineages agree)", async () => {
  const { svc } = makeService({ ownedAccounts: { "1:7": true } });
  await expectTradeError(
    svc.createTrade(OWNER, { ...VECTOR_A, accountId: 8 }),
    400, "VALIDATION_FAILED", { field: "accountId", messageKey: "errors.trades.accountNotOwned" },
  );
  const ok = (await svc.createTrade(OWNER, { ...VECTOR_A, accountId: 7 })) as Record<string, unknown>;
  assert.equal(ok.accountId, "7");
});

test("create: no manual idempotency (evidenced absence — duplicates create duplicates)", async () => {
  const { svc } = makeService();
  const a = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const b = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  assert.notEqual(a.id, b.id);
});

test("ownership: cross-user get/update/delete/exits are non-disclosing 404s", async () => {
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;
  await expectTradeError(svc.getTrade(id, OTHER), 404, "NOT_FOUND");
  await expectTradeError(svc.updateTrade(id, OTHER, { notes: "steal" }), 404, "NOT_FOUND");
  await expectTradeError(svc.deleteTrade(id, OTHER), 404, "NOT_FOUND");
  await expectTradeError(svc.listExits(id, OTHER), 404, "NOT_FOUND");
  await expectTradeError(svc.createExit(id, OTHER, { exitType: "tp", exitPrice: "1.1030", volume: "0.5", exitedAt: "2026-09-10 11:00:00" }), 404, "NOT_FOUND");
  // a ghost id is indistinguishable
  await expectTradeError(svc.getTrade("999999", OWNER), 404, "NOT_FOUND");
  // the owner still sees their trade
  assert.equal(((await svc.getTrade(id, OWNER)) as Record<string, unknown>).id, id);
});

test("correction: journaling edit applies as event with version bump; null clears", async () => {
  const { svc, store } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;
  const eventsBefore = store.eventLog().length;

  const updated = (await svc.updateTrade(id, OWNER, { notes: "reviewed", strategyTag: "Pullback" })) as Record<string, unknown>;
  assert.equal(updated.notes, "reviewed");
  assert.equal(updated.strategyTag, "Pullback");
  assert.equal(updated.version, 1);
  assert.equal(updated.profitLoss, "493.5"); // financials untouched
  assert.equal(store.eventLog().length, eventsBefore + 1); // one JOURNALING_EDITED event

  const cleared = (await svc.updateTrade(id, OWNER, { notes: null })) as Record<string, unknown>;
  assert.equal(cleared.notes, null);
  assert.equal(cleared.version, 2);
});

test("correction: financial fields rejected (403, ADR-002) — including mixed payloads; empty PUT is a no-op", async () => {
  const { svc, store } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;

  await expectTradeError(svc.updateTrade(id, OWNER, { entryPrice: "1.2000" }), 403, "FORBIDDEN", { messageKey: "errors.trades.financialImmutable" });
  await expectTradeError(svc.updateTrade(id, OWNER, { notes: "ok", volume: "2" }), 403, "FORBIDDEN", { fields: "volume" });
  await expectTradeError(svc.updateTrade(id, OWNER, { openTime: "2026-09-10 09:00:00" }), 403, "FORBIDDEN");

  const eventsBefore = store.eventLog().length;
  const noop = (await svc.updateTrade(id, OWNER, {})) as Record<string, unknown>;
  assert.equal(noop.version, 0); // Remote-evidenced no-op: no event, no version change
  assert.equal(store.eventLog().length, eventsBefore);
});

test("correction: optimistic concurrency — stale expectedVersion → 409 CONFLICT", async () => {
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;
  await svc.updateTrade(id, OWNER, { notes: "first" }); // version 0 → 1
  await expectTradeError(svc.updateTrade(id, OWNER, { notes: "stale", version: 0 }), 409, "CONFLICT");
  const fresh = (await svc.updateTrade(id, OWNER, { notes: "fresh", version: 1 })) as Record<string, unknown>;
  assert.equal(fresh.version, 2);
  await expectTradeError(svc.updateTrade(id, OWNER, { notes: "bad", version: "x" }), 400, "VALIDATION_FAILED");
});

test("tombstone: delete → {deleted:true}; tombstoned ≡ missing; further mutation blocked", async () => {
  const { svc, store } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;
  const eventsBefore = store.eventLog().length;

  assert.deepEqual(await svc.deleteTrade(id, OWNER), { deleted: true });
  assert.equal(store.eventLog().length, eventsBefore + 1); // TOMBSTONE_SET
  await expectTradeError(svc.getTrade(id, OWNER), 404, "NOT_FOUND");
  await expectTradeError(svc.deleteTrade(id, OWNER), 404, "NOT_FOUND"); // repeat delete
  await expectTradeError(svc.updateTrade(id, OWNER, { notes: "zombie" }), 404, "NOT_FOUND");
  await expectTradeError(svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1030", volume: "0.5", exitedAt: "2026-09-10 11:00:00" }), 404, "NOT_FOUND");
  // search and symbols exclude tombstoned trades
  const search = (await svc.searchTrades(OWNER, {})) as { items: unknown[] };
  assert.equal(search.items.length, 0);
  assert.deepEqual(await svc.listSymbols(OWNER), { symbols: [] });
});

test("exits: allocation with proportional costs, cumulative cap (422), chronology (422), PHP input validation", async () => {
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, {
    ...VECTOR_A, commission: "10.00", swap: "0", stopLoss: undefined,
    openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 14:00:00",
  })) as Record<string, unknown>;
  const id = t.id as string;

  // exit 1: 0.5 vol @ 1.1030 → ratio 0.5, allocated commission 5.00 → 150.00 − 5.00 = 145.00
  const e1 = (await svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1030", volume: "0.5", exitedAt: "2026-09-10 11:00:00", notes: "TP1" })) as Record<string, unknown>;
  assert.equal(e1.messageKey, "trades.exitCreated");

  // cumulative cap: 0.5 + 0.6 > 1.0 → 422 (Remote integration-test evidenced)
  await expectTradeError(
    svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1050", volume: "0.6", exitedAt: "2026-09-10 12:00:00" }),
    422, "VALIDATION_FAILED", { volume: "EXIT_VOLUME_EXCEEDED" },
  );

  // PHP-hardened input validation
  await expectTradeError(svc.createExit(id, OWNER, { exitType: "limit", exitPrice: "1.1030", volume: "0.1", exitedAt: "2026-09-10 11:00:00" }), 400, "VALIDATION_FAILED", { field: "exitType", messageKey: "errors.validation.choice" });
  await expectTradeError(svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "0", volume: "0.1", exitedAt: "2026-09-10 11:00:00" }), 400, "VALIDATION_FAILED", { field: "volume", messageKey: "errors.validation.positive" });
  await expectTradeError(svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1030", volume: "0.1", exitedAt: "2026-09-10 09:00:00" }), 422, "VALIDATION_FAILED", { field: "exitedAt", messageKey: "errors.validation.datetime" });

  const list = (await svc.listExits(id, OWNER)) as { items: Array<Record<string, unknown>> };
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]!.volume, "0.5");
  assert.equal(list.items[0]!.pnl, "145");
  assert.equal(list.items[0]!.exitPrice, "1.103"); // trimZeros('1.1030')
  assert.equal(list.items[0]!.notes, "TP1");
});

test("exit cancellation: tombstone frees allocation for re-record (ADR-002 EXIT_CANCELLED)", async () => {
  const { svc, store } = makeService();
  const t = (await svc.createTrade(OWNER, {
    ...VECTOR_A, commission: "10.00", swap: "0",
    openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 14:00:00",
  })) as Record<string, unknown>;
  const id = t.id as string;
  const e1 = (await svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1030", volume: "0.5", exitedAt: "2026-09-10 11:00:00" })) as { id: string };
  const eventsBefore = store.eventLog().length;

  assert.deepEqual(await svc.deleteExit(e1.id, OWNER), { deleted: true });
  assert.equal(store.eventLog().length, eventsBefore + 1); // EXIT_CANCELLED
  await expectTradeError(svc.deleteExit(e1.id, OWNER), 404, "NOT_FOUND"); // repeat
  await expectTradeError(svc.deleteExit("999999", OWNER), 404, "NOT_FOUND");

  const afterCancel = (await svc.listExits(id, OWNER)) as { items: unknown[] };
  assert.equal(afterCancel.items.length, 0);

  // allocation freed: 0.6 now fits (would have exceeded with the cancelled 0.5)
  const e2 = (await svc.createExit(id, OWNER, { exitType: "manual", exitPrice: "1.1050", volume: "0.6", exitedAt: "2026-09-10 12:00:00" })) as Record<string, unknown>;
  assert.equal(typeof e2.id, "string");
  // parent version advanced through EXIT_RECORDED + EXIT_CANCELLED + EXIT_RECORDED
  const parent = (await svc.getTrade(id, OWNER)) as Record<string, unknown>;
  assert.equal(parent.version, 3);
});

test("exits: cross-user exit access is a non-disclosing 404", async () => {
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;
  const e = (await svc.createExit(id, OWNER, { exitType: "tp", exitPrice: "1.1030", volume: "0.5", exitedAt: "2026-09-10 11:00:00" })) as { id: string };
  await expectTradeError(svc.deleteExit(e.id, OTHER), 404, "NOT_FOUND");
  const otherList = await svc.listExits(id, OTHER).catch((err: unknown) => err);
  assert.ok(otherList instanceof TradeError && otherList.status === 404);
});

test("search: filters, ordering, pagination (q/order covered in dedicated tests)", async () => {
  const { svc } = makeService();
  const a = (await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "EURUSD", openTime: "2026-09-08 10:00:00", closeTime: "2026-09-08 12:00:00" })) as Record<string, unknown>;
  const b = (await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "GBPUSD", direction: "sell", entryPrice: "1.2800", exitPrice: "1.2750", openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 12:00:00" })) as Record<string, unknown>;
  await svc.createTrade(OTHER, VECTOR_A); // other user — never visible

  const all = (await svc.searchTrades(OWNER, {})) as { items: Array<Record<string, unknown>>; pagination: Record<string, number> };
  assert.equal(all.items.length, 2);
  assert.deepEqual(all.items.map((x) => x.id), [b.id, a.id]); // newest open first
  assert.deepEqual(all.pagination, { page: 1, limit: 20, total: 2, totalPages: 1 });

  const sym = (await svc.searchTrades(OWNER, { symbol: "gbp" })) as { items: unknown[] }; // contains, case-insensitive
  assert.equal(sym.items.length, 1);
  const dir = (await svc.searchTrades(OWNER, { direction: "sell" })) as { items: unknown[] };
  assert.equal(dir.items.length, 1);
  const ranged = (await svc.searchTrades(OWNER, { from: "2026-09-09T00:00:00Z", to: "2026-09-11T00:00:00Z" })) as { items: unknown[] };
  assert.equal(ranged.items.length, 1);
  const paged = (await svc.searchTrades(OWNER, { limit: "1", page: "2" })) as { items: unknown[]; pagination: Record<string, number> };
  assert.equal(paged.items.length, 1);
  assert.deepEqual(paged.pagination, { page: 2, limit: 1, total: 2, totalPages: 2 });
  const clamped = (await svc.searchTrades(OWNER, { limit: "500" })) as { pagination: Record<string, number> };
  assert.equal(clamped.pagination.limit, 200); // PHP clamp
  await expectTradeError(svc.searchTrades(OWNER, { from: "garbage" }), 400, "VALIDATION_FAILED", { field: "from" });
});

test("journal search q (PHP evidence): contains across symbol | strategy | notes, case-insensitive, trimmed", async () => {
  const { svc } = makeService();
  await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "EURUSD", strategyTag: "Breakout", notes: "clean London session" });
  await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "XAUUSD", strategyTag: "Pullback", notes: "gold reversal" });
  await svc.createTrade(OTHER, { ...VECTOR_A, symbol: "EURUSD", notes: "other user EURUSD" }); // never visible

  const bySymbol = (await svc.searchTrades(OWNER, { q: "eurusd" })) as { items: unknown[] };
  assert.equal(bySymbol.items.length, 1); // case-insensitive symbol match
  const byStrategy = (await svc.searchTrades(OWNER, { q: "pull" })) as { items: unknown[] };
  assert.equal(byStrategy.items.length, 1); // strategy contains
  const byNotes = (await svc.searchTrades(OWNER, { q: "LONDON SESSION" })) as { items: unknown[] };
  assert.equal(byNotes.items.length, 1); // notes contains, case-insensitive
  const none = (await svc.searchTrades(OWNER, { q: "no-such-text" })) as { items: unknown[] };
  assert.equal(none.items.length, 0);
  const trimmed = (await svc.searchTrades(OWNER, { q: "   gold   " })) as { items: unknown[] };
  assert.equal(trimmed.items.length, 1); // PHP controller trims
  const emptyQ = (await svc.searchTrades(OWNER, { q: "   " })) as { items: unknown[] };
  assert.equal(emptyQ.items.length, 2); // empty-after-trim = no filter (PHP !empty)
  // q composes with other filters
  const composed = (await svc.searchTrades(OWNER, { q: "gold", direction: "buy" })) as { items: unknown[] };
  assert.equal(composed.items.length, 1);
  // emotion is NOT in the PHP q scope (symbol | strategy_tag | notes only)
  await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "GBPJPY", notes: null, strategyTag: null, emotionalScore: 5 });
  const byEmotion = (await svc.searchTrades(OWNER, { q: "5" })) as { items: unknown[] };
  assert.equal(byEmotion.items.length, 0);
});

test("search order: PHP whitelist open_time|close_time|profit_loss; default/unknown → open_time", async () => {
  const { svc } = makeService();
  // trade a: opens first, loses; trade b: opens later, wins
  const a = (await svc.createTrade(OWNER, {
    symbol: "EURUSD", direction: "sell", entryPrice: "1.3000", exitPrice: "1.3050", volume: "0.5",
    commission: "3.50", swap: "0.50", contractSize: "100000",
    openTime: "2026-09-08 10:00:00", closeTime: "2026-09-08 12:00:00",
  })) as Record<string, unknown>; // net = -254.00 (Remote sell-loser vector)
  const b = (await svc.createTrade(OWNER, {
    symbol: "XAUUSD", direction: "buy", entryPrice: "100.00", exitPrice: "105.00", volume: "2.0",
    contractSize: "10", openTime: "2026-09-10 10:00:00", closeTime: "2026-09-10 09:00:00".replace("09", "11"),
  })) as Record<string, unknown>; // net = +100.00, opens later, closes EARLIER than a closes? no: closes 11:00 on the 10th

  const open = (await svc.searchTrades(OWNER, {})) as { items: Array<Record<string, unknown>> };
  assert.deepEqual(open.items.map((x) => x.id), [b.id, a.id]); // default open_time DESC (Remote lineage)
  const explicitOpen = (await svc.searchTrades(OWNER, { order: "open_time" })) as { items: Array<Record<string, unknown>> };
  assert.deepEqual(explicitOpen.items.map((x) => x.id), [b.id, a.id]);
  const byClose = (await svc.searchTrades(OWNER, { order: "close_time" })) as { items: Array<Record<string, unknown>> };
  assert.deepEqual(byClose.items.map((x) => x.id), [b.id, a.id]); // b closes later (Sep 10) than a (Sep 8)
  const byPnl = (await svc.searchTrades(OWNER, { order: "profit_loss" })) as { items: Array<Record<string, unknown>> };
  assert.deepEqual(byPnl.items.map((x) => x.id), [b.id, a.id]); // +100 before -254
  const unknown = (await svc.searchTrades(OWNER, { order: "total_bogus" })) as { items: Array<Record<string, unknown>> };
  assert.deepEqual(unknown.items.map((x) => x.id), [b.id, a.id]); // unknown → default open_time (PHP: default branch)
});

test("journal field ownership: every FINANCIAL_IMMUTABLE field is 403; SYSTEM_DERIVED rejected on create", async () => {
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;
  for (const field of [
    "symbol", "direction", "entryPrice", "exitPrice", "volume", "contractSize",
    "commission", "swap", "stopLoss", "takeProfit", "accountId", "openTime", "closeTime",
  ]) {
    await expectTradeError(
      svc.updateTrade(id, OWNER, { [field]: "1.0" }),
      403, "FORBIDDEN", { messageKey: "errors.trades.financialImmutable" },
    );
  }
  // derived/provenance fields are not accepted journal inputs at all (ignored on PUT —
  // the journaling patch only reads strategyTag/emotionalScore/notes; system fields
  // like profitLoss/version are never writable through the journal path)
  const untouched = (await svc.updateTrade(id, OWNER, { profitLoss: "999", rMultiple: "999", source: "metaapi" } as Record<string, unknown>)) as Record<string, unknown>;
  assert.equal(untouched.profitLoss, "493.5");
  assert.equal(untouched.rMultiple, "1.645");
  assert.equal(untouched.source, "manual");
});

test("journal semantics: null/empty clear, explicit values set; emotion range enforced on edit", async () => {
  const { svc } = makeService();
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;
  const cleared = (await svc.updateTrade(id, OWNER, { strategyTag: null, notes: "", emotionalScore: null })) as Record<string, unknown>;
  assert.equal(cleared.strategyTag, null);
  assert.equal(cleared.notes, null);
  assert.equal(cleared.emotionalScore, null);
  const set = (await svc.updateTrade(id, OWNER, { strategyTag: "Breakout", notes: "ok", emotionalScore: 3 })) as Record<string, unknown>;
  assert.equal(set.strategyTag, "Breakout");
  assert.equal(set.notes, "ok");
  assert.equal(set.emotionalScore, 3);
  await expectTradeError(svc.updateTrade(id, OWNER, { emotionalScore: 0 }), 400, "VALIDATION_FAILED", { field: "emotionalScore", messageKey: "errors.validation.range" });
  await expectTradeError(svc.updateTrade(id, OWNER, { strategyTag: "x".repeat(65) }), 400, "VALIDATION_FAILED", { field: "strategyTag", messageKey: "errors.validation.maxLength" });
  await expectTradeError(svc.updateTrade(id, OWNER, { notes: "x".repeat(5001) }), 400, "VALIDATION_FAILED", { field: "notes", messageKey: "errors.validation.maxLength" });
});

test("STRATEGIES regression (inc 5): strategyTag contract — free-form journal field, full lifecycle, ledger-safe", async () => {
  const { svc, store } = makeService();
  // create with tag → serialized on the trade, stored as journaling metadata
  const t = (await svc.createTrade(OWNER, { ...VECTOR_A, strategyTag: "TrendFollowing" })) as Record<string, unknown>;
  const id = t.id as string;
  assert.equal(t.strategyTag, "TrendFollowing");
  // no strategy id/entity semantics: the field is a plain string (null when absent)
  const bare = (await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "XAUUSD", strategyTag: null })) as Record<string, unknown>;
  assert.equal(bare.strategyTag, null);
  // edit via the journal path: event + version bump, financials untouched
  const edited = (await svc.updateTrade(id, OWNER, { strategyTag: "MeanReversion" })) as Record<string, unknown>;
  assert.equal(edited.strategyTag, "MeanReversion");
  assert.equal(edited.version, 1);
  assert.equal(edited.profitLoss, "493.5");
  // null and empty-string clear (both lineages); ''→null on create
  const cleared = (await svc.updateTrade(id, OWNER, { strategyTag: null })) as Record<string, unknown>;
  assert.equal(cleared.strategyTag, null);
  const emptied = (await svc.updateTrade(id, OWNER, { strategyTag: "" })) as Record<string, unknown>;
  assert.equal(emptied.strategyTag, null);
  const fromEmpty = (await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "GBPUSD", strategyTag: "" })) as Record<string, unknown>;
  assert.equal(fromEmpty.strategyTag, null);
  // validation: maxLength 64 (PHP schema AND both services; Remote DB column
  // 50 is a Remote-internal divergence — Local is consistent at 64)
  await expectTradeError(svc.updateTrade(id, OWNER, { strategyTag: "x".repeat(65) }), 400, "VALIDATION_FAILED", { field: "strategyTag", messageKey: "errors.validation.maxLength" });
  await expectTradeError(svc.createTrade(OWNER, { ...VECTOR_A, strategyTag: "y".repeat(65) }), 400, "VALIDATION_FAILED", { field: "strategyTag", messageKey: "errors.validation.maxLength" });
  // 64 chars is accepted (boundary)
  const boundary = (await svc.updateTrade(id, OWNER, { strategyTag: "z".repeat(64) })) as Record<string, unknown>;
  assert.equal((boundary.strategyTag as string).length, 64);
  // free-form: no charset restriction in either lineage
  const free = (await svc.updateTrade(id, OWNER, { strategyTag: "ICT #2026 — FVG/ OB" })) as Record<string, unknown>;
  assert.equal(free.strategyTag, "ICT #2026 — FVG/ OB");
  // journal search by strategy (inc 4, PHP evidence)
  const found = (await svc.searchTrades(OWNER, { q: "ICT" })) as { items: unknown[] };
  assert.equal(found.items.length, 1);
  // every strategyTag mutation is a JOURNALING_EDITED event; replay reproduces it
  const { fold } = await import("@velora/domain");
  const events = store.eventLog().filter((e) => e.tradeId === id).map((e, i) => {
    const payload = e.payload as { event: import("@velora/domain").LedgerEvent };
    const ev = { ...payload.event, id: `r-${i}` };
    if (ev.type === "TRADE_CREATED") ev.trade = { ...ev.trade, id };
    return ev as import("@velora/domain").LedgerEvent;
  });
  const { state } = fold(events);
  assert.equal(state!.journaling.strategy, "ICT #2026 — FVG/ OB"); // final value derives from the log
  // tombstone removes strategy data from search (Dashboard projection source)
  await svc.deleteTrade(id, OWNER);
  const afterTombstone = (await svc.searchTrades(OWNER, { q: "ICT" })) as { items: unknown[] };
  assert.equal(afterTombstone.items.length, 0);
});

test("journal integration script (authorization step 8): create → read → edit → immutability → events → replay → tombstone → 409", async () => {
  const { svc, store } = makeService();
  // 1. create
  const t = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const id = t.id as string;
  // 2. read journal state
  const read = (await svc.getTrade(id, OWNER)) as Record<string, unknown>;
  assert.equal(read.strategyTag, "Breakout");
  assert.equal(read.notes, "Clean H1 breakout trade");
  assert.equal(read.emotionalScore, 4);
  // 3. edit permitted journal metadata
  const edited = (await svc.updateTrade(id, OWNER, { notes: "journal edit", emotionalScore: 2 })) as Record<string, unknown>;
  assert.equal(edited.notes, "journal edit");
  assert.equal(edited.emotionalScore, 2);
  // 4. financial fields remain unchanged
  assert.equal(edited.entryPrice, "1.1");
  assert.equal(edited.exitPrice, "1.105");
  assert.equal(edited.volume, "1");
  assert.equal(edited.profitLoss, "493.5");
  assert.equal(edited.rMultiple, "1.645");
  // 5. event history contains the journal event
  const journalEvents = store.eventLog().filter((e) => e.type === "JOURNALING_EDITED");
  assert.equal(journalEvents.length, 1);
  assert.equal(journalEvents[0]!.actor, "user");
  // 6+7. replay: the projection is derivable from the event stream (memory adapter)
  const { fold } = await import("@velora/domain");
  const replayEvents = store.eventLog().map((e, i) => {
    const payload = e.payload as { event: import("@velora/domain").LedgerEvent };
    const ev = { ...payload.event, id: `replay-${i}` };
    if (ev.type === "TRADE_CREATED") ev.trade = { ...ev.trade, id };
    return ev as import("@velora/domain").LedgerEvent;
  });
  const { state } = fold(replayEvents);
  assert.equal(state!.journaling.notes, "journal edit");
  assert.equal(state!.journaling.emotion, "2");
  assert.equal(state!.financial.entryPrice, "1.10000000"); // financial facts intact through replay
  assert.equal(state!.version, 1);
  // 8. tombstone
  assert.deepEqual(await svc.deleteTrade(id, OWNER), { deleted: true });
  // 9. journal becomes non-readable (tombstoned ≡ missing)
  await expectTradeError(svc.getTrade(id, OWNER), 404, "NOT_FOUND");
  await expectTradeError(svc.updateTrade(id, OWNER, { notes: "zombie" }), 404, "NOT_FOUND");
  const search = (await svc.searchTrades(OWNER, { q: "journal edit" })) as { items: unknown[] };
  assert.equal(search.items.length, 0); // tombstoned journal data is not searchable
  // 10. stale version → 409 (on a second trade; the first is tombstoned)
  const t2 = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  await svc.updateTrade(t2.id as string, OWNER, { notes: "v1" });
  await expectTradeError(svc.updateTrade(t2.id as string, OWNER, { notes: "stale", version: 0 }), 409, "CONFLICT");
});

test("symbols: distinct + alphabetical (PHP evidence)", async () => {
  const { svc } = makeService();
  await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "XAUUSD" });
  await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "EURUSD" });
  await svc.createTrade(OWNER, { ...VECTOR_A, symbol: "EURUSD" });
  assert.deepEqual(await svc.listSymbols(OWNER), { symbols: ["EURUSD", "XAUUSD"] });
});

test("serialization: deterministic for identical input (ids/createdAt excluded)", async () => {
  const clock = { n: 0 };
  const { svc } = makeService({ now: () => new Date(NOW.getTime() + clock.n++ * 1000) });
  const a = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const b = (await svc.createTrade(OWNER, VECTOR_A)) as Record<string, unknown>;
  const strip = (t: Record<string, unknown>): Record<string, unknown> => {
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = t as Record<string, unknown> & { id: string; createdAt: string; updatedAt: string };
    return rest;
  };
  assert.deepEqual(strip(a), strip(b));
});
