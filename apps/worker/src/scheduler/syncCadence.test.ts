// Sync cadence resolution tests — MG-METAAPI-CADENCE (AC-35).
//
// Pins the governance contract:
//   - the audited DEFAULT is unchanged (hourly) — OD-AC-CADENCE owns changes
//   - a valid METAAPI_SYNC_CRON is used verbatim (source: "env")
//   - an INVALID value falls back to the default LOUDLY (rejectedEnvValue set)
//   - absent/empty env → default, silently (nothing to warn about)
//   - the legacy reference constant stays minute-precision

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SYNC_CRON,
  LEGACY_SYNC_CRON,
  isValidSyncCron,
  resolveSyncCron,
  syncCronFieldRangesAreValid,
} from "./syncCadence.js";

test("cadence: the audited default is unchanged (hourly) — OD-AC-CADENCE owns changes", () => {
  assert.equal(DEFAULT_SYNC_CRON, "0 * * * *");
  // the legacy reference point (per-minute poll) is documented, not defaulted
  assert.equal(LEGACY_SYNC_CRON, "* * * * *");
  assert.notEqual(DEFAULT_SYNC_CRON, LEGACY_SYNC_CRON);
});

test("cadence: absent/empty/whitespace env → default, no warning", () => {
  assert.deepEqual(resolveSyncCron(undefined), {
    cron: "0 * * * *", source: "default", rejectedEnvValue: null,
  });
  assert.deepEqual(resolveSyncCron(""), {
    cron: "0 * * * *", source: "default", rejectedEnvValue: null,
  });
  assert.deepEqual(resolveSyncCron("   "), {
    cron: "0 * * * *", source: "default", rejectedEnvValue: null,
  });
});

test("cadence: a valid override is used verbatim", () => {
  // the tightening an operator would actually pick (5-minute sweep)
  assert.deepEqual(resolveSyncCron("*/5 * * * *"), {
    cron: "*/5 * * * *", source: "env", rejectedEnvValue: null,
  });
  // legacy parity is expressible
  const legacy = resolveSyncCron("* * * * *");
  assert.equal(legacy.source, "env");
  assert.equal(legacy.cron, LEGACY_SYNC_CRON);
  // ranges, lists, steps
  assert.equal(resolveSyncCron("15,45 */2 * * 1-5").source, "env");
});

test("cadence: invalid values fall back to the default LOUDLY", () => {
  // 6-field (seconds) — pg-boss 5-field contract only here
  assert.deepEqual(resolveSyncCron("0 */5 * * * *"), {
    cron: "0 * * * *", source: "default", rejectedEnvValue: "0 */5 * * * *",
  });
  // out-of-range fields
  for (const bad of ["*/5 24 * * *", "61 * * * *", "* * 0 * *", "* * * 13 *", "@daily", "garbage", "* * * * 1/0"]) {
    const res = resolveSyncCron(bad);
    assert.equal(res.source, "default", `${bad} must not be accepted`);
    assert.equal(res.rejectedEnvValue, bad, `${bad} must be reported`);
    assert.equal(res.cron, DEFAULT_SYNC_CRON);
  }
});

test("cadence: validators reject names and typos, accept the full legal grammar", () => {
  assert.ok(isValidSyncCron("0 * * * *"));
  assert.ok(isValidSyncCron("*/10 4 * * mon-fri".replace("mon-fri", "1-5")));
  // day-names deliberately NOT accepted (narrow typo surface)
  assert.ok(!isValidSyncCron("* * * * mon"));
  assert.ok(!isValidSyncCron(""));
  assert.ok(!isValidSyncCron("* * * *"));
  assert.ok(!isValidSyncCron("* * * * * *"));
  // range checks: legal bounds pass, off-by-one fails
  assert.ok(syncCronFieldRangesAreValid("59 23 31 12 7"));
  assert.ok(!syncCronFieldRangesAreValid("60 * * * *"));
  assert.ok(!syncCronFieldRangesAreValid("* 24 * * *"));
  assert.ok(!syncCronFieldRangesAreValid("* * 32 * *"));
  assert.ok(!syncCronFieldRangesAreValid("* * * 0 *"));
});
