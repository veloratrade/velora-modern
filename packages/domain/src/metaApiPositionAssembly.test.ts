// Golden vectors for the MetaAPI position assembly port (MG-METAAPI-ASSEMBLY).
//
// Every vector mirrors Legacy `MetaApiDealAssembler` semantics verified from
// api/src/Trades/MetaApiDealAssembler.php @ edede31 (source-read 2026-10-05):
// grouping, side filter, dedup, the emit gate, VWAP prices at bcmath scale 8,
// Σ-IN volume, IN+OUT financial sums, earliest-IN / latest-OUT boundaries, and
// the full skip vocabulary. Expected strings are what PHP bcmath produces —
// truncation, never rounding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assemblePositions, positionGroupKey, type AssemblyFill } from "./metaApiPositionAssembly.js";

function fill(over: Partial<AssemblyFill> & Pick<AssemblyFill, "externalDealId" | "entryType">): AssemblyFill {
  // rawTimeText mirrors the resolved instant (as the DB row would), unless a
  // test overrides it explicitly.
  const occurred = over.occurredAtUtc ?? "2026-03-01T10:15:00.000Z";
  return {
    positionId: "p1",
    direction: "buy",
    symbol: "EURUSD",
    volume: "1",
    price: "1.10000",
    profit: "0",
    commission: "0",
    swap: "0",
    occurredAtUtc: occurred,
    rawTimeText: over.rawTimeText ?? occurred,
    ...over,
  };
}

test("single IN + single OUT → one closed trade, identity is the position", () => {
  const r = assemblePositions([
    fill({ externalDealId: "d-in", entryType: "in", price: "1.10000", volume: "1", occurredAtUtc: "2026-03-01T10:00:00.000Z" }),
    fill({ externalDealId: "d-out", entryType: "out", price: "1.10500", volume: "1", profit: "125.50", occurredAtUtc: "2026-03-01T11:00:00.000Z" }),
  ]);
  assert.equal(r.trades.length, 1);
  assert.deepEqual(r.skipped, []);
  const t = r.trades[0]!;
  assert.equal(t.positionKey, "pos-p1");
  assert.equal(t.symbol, "EURUSD");
  assert.equal(t.direction, "buy");
  assert.equal(t.entryPrice, "1.10000000");
  assert.equal(t.exitPrice, "1.10500000");
  assert.equal(t.volume, "1.00000000");
  assert.equal(t.profitLoss, "125.50000000"); // bcmath pads to scale 8
  assert.equal(t.openInstantUtc, "2026-03-01T10:00:00.000Z");
  assert.equal(t.closeInstantUtc, "2026-03-01T11:00:00.000Z");
  assert.equal(t.rawOpenText, "2026-03-01T10:00:00.000Z");
  assert.equal(t.rawCloseText, "2026-03-01T11:00:00.000Z");
});

test("scaled-in (2 IN, 1 OUT): entry = VWAP of INs, volume = Σ IN", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", volume: "0.5", price: "1.1000", occurredAtUtc: "2026-03-01T10:00:00.000Z" }),
    fill({ externalDealId: "i2", entryType: "in", volume: "0.5", price: "1.1200", occurredAtUtc: "2026-03-01T10:05:00.000Z" }),
    fill({ externalDealId: "o1", entryType: "out", volume: "1", price: "1.1300", occurredAtUtc: "2026-03-01T11:00:00.000Z" }),
  ]);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0]!;
  // (0.5×1.1000 + 0.5×1.1200) / 1.0 = 1.11000000
  assert.equal(t.entryPrice, "1.11000000");
  assert.equal(t.volume, "1.00000000");
  // open = EARLIEST IN, close = latest OUT
  assert.equal(t.openInstantUtc, "2026-03-01T10:00:00.000Z");
});

test("partial close (1 IN, 2 OUT): exit = VWAP of OUTs, close = LATEST OUT", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", volume: "1", price: "1.1000", occurredAtUtc: "2026-03-01T10:00:00.000Z" }),
    fill({ externalDealId: "o1", entryType: "out", volume: "0.4", price: "1.1200", occurredAtUtc: "2026-03-01T11:00:00.000Z" }),
    fill({ externalDealId: "o2", entryType: "out", volume: "0.6", price: "1.1400", occurredAtUtc: "2026-03-01T12:00:00.000Z" }),
  ]);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0]!;
  // (0.4×1.1200 + 0.6×1.1400) / 1.0 = 1.13200000
  assert.equal(t.exitPrice, "1.13200000");
  assert.equal(t.volume, "1.00000000");
  assert.equal(t.closeInstantUtc, "2026-03-01T12:00:00.000Z");
  assert.equal(t.rawCloseText, "2026-03-01T12:00:00.000Z");
});

test("financials sum across ALL fills (IN+OUT), direction = first IN, symbol = first IN", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", direction: "sell", symbol: "XAUUSD", profit: "-2", commission: "-1", swap: "0.5", occurredAtUtc: "2026-03-01T10:00:00.000Z" }),
    fill({ externalDealId: "o1", entryType: "out", direction: "sell", symbol: "XAUUSD", profit: "102.5", commission: "-1", swap: "0.25", occurredAtUtc: "2026-03-01T11:00:00.000Z" }),
  ]);
  const t = r.trades[0]!;
  assert.equal(t.direction, "sell");
  assert.equal(t.symbol, "XAUUSD");
  assert.equal(t.profitLoss, "100.50000000");
  assert.equal(t.commission, "-2.00000000");
  assert.equal(t.swap, "0.75000000");
});

test("emit gate: Σvol(OUT) == Σvol(IN) is a closed position; only < is partial", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", volume: "1" }),
    fill({ externalDealId: "o1", entryType: "out", volume: "1" }),
  ]);
  assert.equal(r.trades.length, 1);
  assert.deepEqual(r.skipped, []);
});

test("emit gate: OUT volume < IN volume → repairable position_partially_open", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", volume: "1" }),
    fill({ externalDealId: "o1", entryType: "out", volume: "0.4" }),
  ]);
  assert.equal(r.trades.length, 0);
  assert.deepEqual(r.skipped, [{ key: "pos-p1", reason: "position_partially_open" }]);
});

test("no IN side → missing_open_fill; no OUT side → position_still_open", () => {
  const onlyOut = assemblePositions([fill({ externalDealId: "o1", entryType: "out" })]);
  assert.deepEqual(onlyOut.skipped, [{ key: "pos-p1", reason: "missing_open_fill" }]);
  const onlyIn = assemblePositions([fill({ externalDealId: "i1", entryType: "in" })]);
  assert.deepEqual(onlyIn.skipped, [{ key: "pos-p1", reason: "position_still_open" }]);
});

test("unresolved boundary instant → repairable skip, never a fabricated boundary", () => {
  const noOpenInstant = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", occurredAtUtc: null, rawTimeText: null }),
    fill({ externalDealId: "o1", entryType: "out", occurredAtUtc: "2026-03-01T11:00:00.000Z" }),
  ]);
  assert.deepEqual(noOpenInstant.skipped, [{ key: "pos-p1", reason: "open_instant_unresolved" }]);

  const noCloseInstant = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", occurredAtUtc: "2026-03-01T10:00:00.000Z" }),
    fill({ externalDealId: "o1", entryType: "out", occurredAtUtc: null, rawTimeText: null }),
  ]);
  assert.deepEqual(noCloseInstant.skipped, [{ key: "pos-p1", reason: "close_instant_unresolved" }]);
});

test("close before open → terminal close_before_open", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", occurredAtUtc: "2026-03-01T11:00:00.000Z" }),
    fill({ externalDealId: "o1", entryType: "out", occurredAtUtc: "2026-03-01T10:00:00.000Z" }),
  ]);
  assert.deepEqual(r.skipped, [{ key: "pos-p1", reason: "close_before_open" }]);
});

test("no usable direction on the IN side → terminal unknown_direction", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", direction: null }),
    fill({ externalDealId: "o1", entryType: "out" }),
  ]);
  assert.deepEqual(r.skipped, [{ key: "pos-p1", reason: "unknown_direction" }]);
});

test("repeated deal id is collapsed within one assembly (fill-level idempotency)", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", volume: "0.5", price: "1.1000" }),
    fill({ externalDealId: "i1", entryType: "in", volume: "0.5", price: "1.1000" }), // replay
    fill({ externalDealId: "o1", entryType: "out", volume: "0.5", price: "1.1200" }),
  ]);
  assert.equal(r.trades.length, 1);
  // Without dedup the IN volume would be 1.0 and the position partially open.
  assert.equal(r.trades[0]!.volume, "0.50000000");
  assert.equal(r.trades[0]!.entryPrice, "1.10000000");
});

test("non-trade deals (null side) are ignored entirely", () => {
  const r = assemblePositions([
    fill({ externalDealId: "b1", entryType: null, profit: "1000" }),
    fill({ externalDealId: "i1", entryType: "in" }),
    fill({ externalDealId: "o1", entryType: "out" }),
  ]);
  assert.equal(r.trades.length, 1);
  // The balance deal's 1000 must NOT leak into the position PnL. The IN/OUT
  // fills carry profit "0" (string) → bcmath sum is scale-8 padded.
  assert.equal(r.trades[0]!.profitLoss, "0.00000000");
});

test("a real trade fill without a positionId cannot pair → unpaired_deal_no_position_id", () => {
  const r = assemblePositions([
    fill({ externalDealId: "lonely", entryType: "out", positionId: null }),
  ]);
  assert.equal(r.trades.length, 0);
  assert.deepEqual(r.skipped, [{ key: "lonely", reason: "unpaired_deal_no_position_id" }]);
});

test("invalid prices/volume → invalid_prices_or_volume", () => {
  const zeroPrice = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", price: "0" }),
    fill({ externalDealId: "o1", entryType: "out" }),
  ]);
  assert.deepEqual(zeroPrice.skipped, [{ key: "pos-p1", reason: "invalid_prices_or_volume" }]);
});

test("missing symbol on every fill → missing_symbol", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", symbol: null }),
    fill({ externalDealId: "o1", entryType: "out", symbol: null }),
  ]);
  assert.deepEqual(r.skipped, [{ key: "pos-p1", reason: "missing_symbol" }]);
});

test("bcmath-truncate division: VWAP never rounds up (1.123456785 → 1.12345678)", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", volume: "1", price: "1.12345678" }),
    fill({ externalDealId: "i2", entryType: "in", volume: "1", price: "1.12345679" }),
    fill({ externalDealId: "o1", entryType: "out", volume: "2", price: "1.13000000" }),
  ]);
  assert.equal(r.trades[0]!.entryPrice, "1.12345678");
});

test("positions are independent: two positionIds assemble separately", () => {
  const r = assemblePositions([
    fill({ externalDealId: "a-in", entryType: "in", positionId: "A" }),
    fill({ externalDealId: "a-out", entryType: "out", positionId: "A" }),
    fill({ externalDealId: "b-in", entryType: "in", positionId: "B" }),
    // B has no OUT yet — stays repairable, never blocks A.
  ]);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0]!.positionKey, "pos-A");
  assert.deepEqual(r.skipped, [{ key: "pos-B", reason: "position_still_open" }]);
});

test("positionGroupKey: Legacy's validation, verbatim", () => {
  assert.equal(positionGroupKey("A1024.5_x-1"), "pos-A1024.5_x-1");
  assert.equal(positionGroupKey("  padded  "), "pos-padded", "trimmed then validated");
  assert.equal(positionGroupKey(""), null);
  assert.equal(positionGroupKey("   "), null);
  assert.equal(positionGroupKey("has space"), null);
  assert.equal(positionGroupKey("has!special"), null);
  assert.equal(positionGroupKey("x".repeat(65)), null);
  assert.equal(positionGroupKey("x".repeat(64)), "pos-" + "x".repeat(64));
  assert.equal(positionGroupKey(null), null);
});

test("commission/swap absent on every fill default to 0, profit absent → 0", () => {
  const r = assemblePositions([
    fill({ externalDealId: "i1", entryType: "in", commission: null, swap: null, profit: null }),
    fill({ externalDealId: "o1", entryType: "out", commission: null, swap: null, profit: null }),
  ]);
  // Legacy: $profit ?? '0' — a field NO fill carried falls back to the bare
  // literal '0' (NOT the scale-8 padded zero bcmath would produce).
  assert.equal(r.trades[0]!.profitLoss, "0");
  assert.equal(r.trades[0]!.commission, "0");
  assert.equal(r.trades[0]!.swap, "0");
});
