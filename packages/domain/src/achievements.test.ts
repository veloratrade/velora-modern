// Achievements port tests — semantics ported from legacy
// UserAchievementRepository (READ-ONLY source-read 2026-10-04): idempotent
// first-unlock, fail-silent behavior, exact metadata/timestamp formats, and
// the complete two-definition catalog (nothing invented).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACHIEVEMENTS,
  normalizeAchievementKey,
  formatUtcDbTimestamp,
  formatIso8601UtcPhpStyle,
  buildAchievementMetadata,
  parseAchievementMetadata,
  unlockAchievement,
  listAchievementsForUser,
  type AchievementStore,
  type UnlockedAchievement,
} from "./achievements.js";

/** In-memory store double with failure injection. */
function makeStore(opts: { failExists?: boolean; failInsert?: boolean } = {}) {
  const rows: UnlockedAchievement[] = [];
  const inserts: UnlockedAchievement[] = [];
  const store: AchievementStore = {
    async exists(userId, key) {
      if (opts.failExists) throw new Error("db down");
      return rows.some((r) => r.userId === userId && r.achievementKey === key);
    },
    async insert(entry) {
      if (opts.failInsert) throw new Error("db down");
      inserts.push(entry);
      rows.push(entry);
    },
    async list(userId) {
      return rows.filter((r) => r.userId === userId);
    },
  };
  return { store, rows, inserts };
}

const NOW = new Date("2026-10-04T12:34:56.789Z");

test("catalog: exactly the two legacy definitions, with the legacy i18n keys", () => {
  assert.deepEqual(Object.keys(ACHIEVEMENTS).sort(), ["EMAIL_VERIFIED", "FIRST_TRADE"]);
  assert.equal(ACHIEVEMENTS.FIRST_TRADE!.titleKey, "achievements.firstTrade.title");
  assert.equal(ACHIEVEMENTS.FIRST_TRADE!.descriptionKey, "achievements.firstTrade.description");
  assert.equal(ACHIEVEMENTS.EMAIL_VERIFIED!.titleKey, "achievements.emailVerified.title");
  assert.equal(ACHIEVEMENTS.EMAIL_VERIFIED!.descriptionKey, "achievements.emailVerified.description");
});

test("normalizeAchievementKey: legacy mb_strtoupper(trim()) behavior", () => {
  assert.equal(normalizeAchievementKey("  first_trade  "), "FIRST_TRADE");
  assert.equal(normalizeAchievementKey("EmailVerified"), "EMAILVERIFIED");
});

test("timestamp formats: achieved_at uses DB shape, unlockedAt uses PHP gmdate('c')", () => {
  assert.equal(formatUtcDbTimestamp(NOW), "2026-10-04 12:34:56"); // milliseconds dropped, space separator
  assert.equal(formatIso8601UtcPhpStyle(NOW), "2026-10-04T12:34:56+00:00"); // no milliseconds, explicit +00:00
});

test("metadata_json: same fields, same order as legacy json_encode", () => {
  const json = buildAchievementMetadata(ACHIEVEMENTS.FIRST_TRADE!, NOW);
  assert.equal(
    json,
    '{"titleKey":"achievements.firstTrade.title","descriptionKey":"achievements.firstTrade.description","unlockedAt":"2026-10-04T12:34:56+00:00"}',
  );
  const parsed = parseAchievementMetadata(json);
  assert.deepEqual(parsed, {
    titleKey: "achievements.firstTrade.title",
    descriptionKey: "achievements.firstTrade.description",
    unlockedAt: "2026-10-04T12:34:56+00:00",
  });
});

test("parseAchievementMetadata: malformed or partial rows degrade to null, never throw", () => {
  assert.equal(parseAchievementMetadata(null), null);
  assert.equal(parseAchievementMetadata("not json"), null);
  assert.equal(parseAchievementMetadata('{"titleKey":"a"}'), null); // missing fields
  assert.equal(parseAchievementMetadata('"a string"'), null);
});

test("unlock: first time returns true and persists one row", async () => {
  const { store, inserts } = makeStore();
  const first = await unlockAchievement("user-1", ACHIEVEMENTS.FIRST_TRADE!, store, NOW);
  assert.equal(first, true);
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0], {
    userId: "user-1",
    achievementKey: "FIRST_TRADE",
    achievedAt: "2026-10-04 12:34:56",
    metadataJson: '{"titleKey":"achievements.firstTrade.title","descriptionKey":"achievements.firstTrade.description","unlockedAt":"2026-10-04T12:34:56+00:00"}',
  });
});

test("unlock: second time returns false and inserts nothing (idempotent first-unlock only)", async () => {
  const { store, inserts } = makeStore();
  assert.equal(await unlockAchievement("user-1", ACHIEVEMENTS.EMAIL_VERIFIED!, store, NOW), true);
  assert.equal(await unlockAchievement("user-1", ACHIEVEMENTS.EMAIL_VERIFIED!, store, new Date("2026-10-05T00:00:00Z")), false);
  assert.equal(inserts.length, 1); // no second row
});

test("unlock: per-user isolation — another user's unlock does not block this one", async () => {
  const { store } = makeStore();
  assert.equal(await unlockAchievement("user-1", ACHIEVEMENTS.FIRST_TRADE!, store, NOW), true);
  assert.equal(await unlockAchievement("user-2", ACHIEVEMENTS.FIRST_TRADE!, store, NOW), true);
});

test("unlock: store failure degrades to false — legacy catch(Throwable) fail-silent parity", async () => {
  const failExists = makeStore({ failExists: true });
  assert.equal(await unlockAchievement("user-1", ACHIEVEMENTS.FIRST_TRADE!, failExists.store, NOW), false);
  const failInsert = makeStore({ failInsert: true });
  assert.equal(await unlockAchievement("user-1", ACHIEVEMENTS.FIRST_TRADE!, failInsert.store, NOW), false);
});

test("list: returns the user's rows ordered by the store, other users excluded", async () => {
  const { store } = makeStore();
  await unlockAchievement("user-1", ACHIEVEMENTS.FIRST_TRADE!, store, NOW);
  await unlockAchievement("user-2", ACHIEVEMENTS.EMAIL_VERIFIED!, store, NOW);
  const list = await listAchievementsForUser("user-1", store);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.achievementKey, "FIRST_TRADE");
});

test("list: store failure degrades to [] — legacy listForUser catch parity", async () => {
  const broken: AchievementStore = {
    exists: async () => false,
    insert: async () => {},
    list: async () => {
      throw new Error("db down");
    },
  };
  assert.deepEqual(await listAchievementsForUser("user-1", broken), []);
});
