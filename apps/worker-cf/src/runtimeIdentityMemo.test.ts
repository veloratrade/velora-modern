// The identity memo is a cache, so these tests are about the two ways a cache is wrong: serving a stale
// value, and never invalidating. `withLiveIdentityMemo` is driven with a stub store that counts calls, so
// what is asserted is exactly the wrapping the Worker puts around `PgTelegramStore`.
import test from "node:test";
import assert from "node:assert/strict";
import { withLiveIdentityMemo } from "./runtime.js";
import type { PgTelegramStore } from "../../api/src/telegram/pgTelegramStore.js";

interface Fake {
  readonly store: PgTelegramStore;
  reads(): number;
  calls(): readonly string[];
}

const fake = (rows: Record<string, unknown>[]): Fake => {
  let reads = 0;
  let last: Record<string, unknown> | null = null;
  const calls: string[] = [];
  const inner = {
    async findLiveIdentityByTelegramUserId(id: string) {
      reads += 1;
      last = rows.find((r) => r["telegram_user_id"] === id) ?? null;
      return last;
    },
    async findLiveIdentityByUserId() {
      calls.push("findLiveIdentityByUserId");
      return null;
    },
    async touchIdentity() {
      calls.push("touchIdentity");
    },
    async revokeIdentity() {
      calls.push("revokeIdentity");
    },
    async insertLiveIdentity() {
      calls.push("insertLiveIdentity");
      throw new Error("write refused");
    },
    async claimUpdate(input: unknown) {
      calls.push(`claimUpdate:${JSON.stringify(input)}`);
      return true;
    },
  };
  void last;
  return {
    store: withLiveIdentityMemo(inner as unknown as PgTelegramStore),
    reads: () => reads,
    calls: () => calls,
  };
};

test("the same sender is read from the database once per invocation, however many callers ask", async () => {
  const f = fake([{ telegram_user_id: "44", id: 8, status: "LINKED" }]);
  const first = await f.store.findLiveIdentityByTelegramUserId("44");
  const second = await f.store.findLiveIdentityByTelegramUserId("44");
  const third = await f.store.findLiveIdentityByTelegramUserId("44");
  const fourth = await f.store.findLiveIdentityByTelegramUserId("44");
  assert.equal(f.reads(), 1, "four callers, one round trip");
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(third, fourth);
  assert.deepEqual(first, { telegram_user_id: "44", id: 8, status: "LINKED" });
});

test("an unknown sender is memoised as 'not linked' too, so a miss is also one query", async () => {
  const f = fake([]);
  assert.equal(await f.store.findLiveIdentityByTelegramUserId("99"), null);
  assert.equal(await f.store.findLiveIdentityByTelegramUserId("99"), null);
  assert.equal(f.reads(), 1);
});

test("different senders do not share a memo entry", async () => {
  const f = fake([
    { telegram_user_id: "44", id: 8 },
    { telegram_user_id: "77", id: 9 },
  ]);
  assert.deepEqual(await f.store.findLiveIdentityByTelegramUserId("44"), { telegram_user_id: "44", id: 8 });
  assert.deepEqual(await f.store.findLiveIdentityByTelegramUserId("77"), { telegram_user_id: "77", id: 9 });
  assert.equal(f.reads(), 2, "two distinct ids are two reads, not a collision");
});

test("a touch invalidates, so the debounce cannot read its own stale answer", async () => {
  const rows = [{ telegram_user_id: "44", id: 8, last_seen_at: "2026-10-18T17:00:00Z" }];
  let touched = false;
  const inner = {
    async findLiveIdentityByTelegramUserId() {
      return touched ? { telegram_user_id: "44", id: 8, last_seen_at: "2026-10-18T19:00:00Z" } : rows[0];
    },
    async touchIdentity() {
      touched = true;
    },
  };
  const store = withLiveIdentityMemo(inner as unknown as PgTelegramStore);
  const before = await store.findLiveIdentityByTelegramUserId("44");
  assert.equal(before?.["last_seen_at"], "2026-10-18T17:00:00Z");
  await store.touchIdentity(8, new Date("2026-10-18T19:00:00Z"));
  const after = await store.findLiveIdentityByTelegramUserId("44");
  assert.equal(after?.["last_seen_at"], "2026-10-18T19:00:00Z", "the write must be visible to the next read");
});

test("a failed write still clears the memo", async () => {
  const f = fake([{ telegram_user_id: "44", id: 8 }]);
  await f.store.findLiveIdentityByTelegramUserId("44");
  await assert.rejects(() => f.store.insertLiveIdentity({} as never), /write refused/);
  await f.store.findLiveIdentityByTelegramUserId("44");
  assert.equal(f.reads(), 2, "a write that threw may still have landed, so the cached row is not trusted");
});

test("everything else passes straight through, receiver and arguments intact", async () => {
  const f = fake([]);
  assert.equal(await f.store.claimUpdate({ updateId: "1" }), true);
  await f.store.findLiveIdentityByUserId("7");
  assert.deepEqual(f.calls(), ["claimUpdate:{\"updateId\":\"1\"}", "findLiveIdentityByUserId"], "the other methods must reach the store unchanged");
  assert.equal(f.reads(), 0, "and must not disturb the memo");
});
