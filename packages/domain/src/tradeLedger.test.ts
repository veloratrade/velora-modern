import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyEvent, fold, externalTradeKey,
  VersionConflictError, TombstoneError, OverAllocationError, OwnershipPolicyError, LedgerError,
  type LedgerEvent, type TradeState,
} from "./tradeLedger.js";

const base = {
  id: "t1",
  accountId: "acc1",
  externalDealId: "DEAL-1",
  symbol: "EURUSD",
  direction: "buy" as const,
  status: "CLOSED" as const,
  financial: {
    entryPrice: "1.08500000", exitPrice: "1.09000000", volume: "1.00000000",
    contractSize: "100000.00000000", commission: "7.00", swap: "0.00",
  },
  journaling: { strategy: "breakout", setup: null, emotion: null, notes: null },
  stopLoss: "1.08250000",
  takeProfit: null,
};

const created: LedgerEvent = { id: "e1", type: "TRADE_CREATED", actor: "user", at: "2026-08-31T10:00:00Z", expectedVersion: 0, trade: base };

test("create → fold produces versioned state", () => {
  const { state } = fold([created]);
  assert.ok(state);
  assert.equal(state!.version, 0);
  assert.equal(state!.deletedAt, null);
  assert.equal(state!.allocatedVolume, "0");
});

test("ownership matrix: user cannot emit FINANCIAL_CORRECTED (SYNC_WINS_FINANCIAL)", () => {
  const { state } = fold([created]);
  // Intentionally illegal event — the LedgerEvent union correctly forbids this
  // actor/type combination at compile time, hence the documented cast.
  const illegal = { id: "e2", type: "FINANCIAL_CORRECTED", actor: "user", at: "2026-08-31T10:01:00Z", expectedVersion: 0, patch: { commission: "9.00" } } as unknown as LedgerEvent;
  assert.throws(() => applyEvent(state, illegal), OwnershipPolicyError);
});

test("ownership matrix: sync cannot emit JOURNALING_EDITED (USER_WINS_JOURNALING)", () => {
  const { state } = fold([created]);
  const illegal = { id: "e3", type: "JOURNALING_EDITED", actor: "sync", at: "2026-08-31T10:01:00Z", expectedVersion: 0, patch: { notes: "auto" } } as unknown as LedgerEvent;
  assert.throws(() => applyEvent(state, illegal), OwnershipPolicyError);
});

test("sync financial correction and user journaling edit both apply with version bump", () => {
  const s1 = applyEvent(null, created);
  const s2 = applyEvent(s1, { id: "e4", type: "FINANCIAL_CORRECTED", actor: "sync", at: "2026-08-31T11:00:00Z", expectedVersion: 0, patch: { swap: "-2.00" } });
  assert.equal(s2.financial.swap, "-2.00");
  const s3 = applyEvent(s2, { id: "e5", type: "JOURNALING_EDITED", actor: "user", at: "2026-08-31T11:05:00Z", expectedVersion: 1, patch: { notes: "chased entry" } });
  assert.equal(s3.journaling.notes, "chased entry");
  assert.equal(s3.financial.swap, "-2.00"); // journaling edit did not touch financials
  assert.equal(s3.version, 2);
});

test("optimistic concurrency: stale expectedVersion is rejected (no last-write-wins)", () => {
  const s1 = applyEvent(null, created);
  assert.throws(
    () => applyEvent(s1, { id: "e6", type: "FINANCIAL_CORRECTED", actor: "sync", at: "2026-08-31T11:00:00Z", expectedVersion: 7, patch: { swap: "0.00" } }),
    VersionConflictError,
  );
});

test("exits: allocation accumulates and over-allocation is rejected", () => {
  const s1 = applyEvent(null, { ...created, trade: { ...base, financial: { ...base.financial, volume: "2.00000000" } } });
  const s2 = applyEvent(s1, { id: "x1", type: "EXIT_RECORDED", actor: "user", at: "2026-08-31T12:00:00Z", expectedVersion: 0, exit: { exitId: "x1", volume: "1.25000000", price: "1.08800000", recordedAt: "2026-08-31T12:00:00Z" } });
  assert.equal(s2.allocatedVolume, "1.25000000");
  assert.throws(
    () => applyEvent(s2, { id: "x2", type: "EXIT_RECORDED", actor: "user", at: "2026-08-31T12:05:00Z", expectedVersion: 1, exit: { exitId: "x2", volume: "0.75000001", price: "1.09000000", recordedAt: "2026-08-31T12:05:00Z" } }),
    OverAllocationError,
  );
  const s3 = applyEvent(s2, { id: "x3", type: "EXIT_RECORDED", actor: "user", at: "2026-08-31T12:06:00Z", expectedVersion: 1, exit: { exitId: "x3", volume: "0.75000000", price: "1.09000000", recordedAt: "2026-08-31T12:06:00Z" } });
  assert.equal(s3.allocatedVolume, "2.00000000"); // exactly fully allocated is legal
});

test("exit cancellation frees allocation with version bump (EXIT_CANCELLED)", () => {
  const s1 = applyEvent(null, created);
  const s2 = applyEvent(s1, { id: "e10", type: "EXIT_RECORDED", actor: "user", at: "2026-09-12T10:00:00Z", expectedVersion: 0, exit: { exitId: "x1", volume: "0.60000000", price: "1.08800000", recordedAt: "2026-09-12T10:00:00Z" } });
  assert.equal(s2.allocatedVolume, "0.60000000");
  const s3 = applyEvent(s2, { id: "e11", type: "EXIT_CANCELLED", actor: "user", at: "2026-09-12T10:05:00Z", expectedVersion: 1, exitId: "x1", volume: "0.60000000" });
  assert.equal(s3.allocatedVolume, "0.00000000");
  assert.equal(s3.version, 2);
  // freed allocation is reusable
  const s4 = applyEvent(s3, { id: "e12", type: "EXIT_RECORDED", actor: "user", at: "2026-09-12T10:06:00Z", expectedVersion: 2, exit: { exitId: "x2", volume: "1.00000000", price: "1.09100000", recordedAt: "2026-09-12T10:06:00Z" } });
  assert.equal(s4.allocatedVolume, "1.00000000");
});

test("exit cancellation: underflow and ownership are rejected", () => {
  const s1 = applyEvent(null, created);
  const s2 = applyEvent(s1, { id: "e13", type: "EXIT_RECORDED", actor: "user", at: "2026-09-12T10:00:00Z", expectedVersion: 0, exit: { exitId: "x1", volume: "0.50000000", price: "1.08800000", recordedAt: "2026-09-12T10:00:00Z" } });
  assert.throws(() => applyEvent(s2, { id: "e14", type: "EXIT_CANCELLED", actor: "user", at: "2026-09-12T10:05:00Z", expectedVersion: 1, exitId: "x1", volume: "0.50000001" }), LedgerError);
  const illegal = { id: "e15", type: "EXIT_CANCELLED", actor: "sync", at: "2026-09-12T10:05:00Z", expectedVersion: 1, exitId: "x1", volume: "0.50000000" } as unknown as LedgerEvent;
  assert.throws(() => applyEvent(s2, illegal), OwnershipPolicyError);
});

test("tombstone: blocks every further mutation event", () => {
  const s1 = applyEvent(null, created);
  const s2 = applyEvent(s1, { id: "d1", type: "TOMBSTONE_SET", actor: "user", at: "2026-08-31T13:00:00Z", expectedVersion: 0, reason: "mistake" });
  assert.notEqual(s2.deletedAt, null);
  assert.throws(
    () => applyEvent(s2, { id: "d2", type: "JOURNALING_EDITED", actor: "user", at: "2026-08-31T13:01:00Z", expectedVersion: 1, patch: { notes: "x" } }),
    TombstoneError,
  );
});

test("duplicate event id is idempotent in fold (webhook/sync replay converges)", () => {
  const dup: LedgerEvent = { id: "e4", type: "FINANCIAL_CORRECTED", actor: "sync", at: "2026-08-31T11:00:00Z", expectedVersion: 0, patch: { swap: "-2.00" } };
  const { state, appliedIds } = fold([created, dup, dup]);
  assert.equal(appliedIds.size, 2);
  assert.equal(state!.financial.swap, "-2.00");
  assert.equal(state!.version, 1); // replay did not bump version
});

test("replay determinism: fold(events) is stable", () => {
  const events: LedgerEvent[] = [
    created,
    { id: "f1", type: "FINANCIAL_CORRECTED", actor: "sync", at: "2026-08-31T11:00:00Z", expectedVersion: 0, patch: { swap: "-2.00" } },
    { id: "f2", type: "JOURNALING_EDITED", actor: "user", at: "2026-08-31T11:05:00Z", expectedVersion: 1, patch: { notes: "ok" } },
  ];
  const a = fold(events).state;
  const b = fold(events).state;
  assert.deepEqual(a, b);
});

test("external trade key is account-scoped", () => {
  assert.equal(externalTradeKey("acc1", "D9"), "trade:acc1:D9");
  assert.equal(externalTradeKey(null, "D9"), "trade:manual:D9");
});
