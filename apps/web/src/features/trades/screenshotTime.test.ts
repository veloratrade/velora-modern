import { test } from "node:test";
import assert from "node:assert/strict";
import {
  screenshotTimePrefill,
  toApiDateTime,
  toLocalInputTime,
} from "./screenshotTime.js";

test("explicit screenshot offsets display in the profile zone and preserve the exact instant on submit", () => {
  const value = "2026-10-10T15:30:45+03:30";
  const prefill = screenshotTimePrefill(value, "2026-10-10T08:00", "Europe/Paris");
  assert.equal(prefill.valid, true);
  assert.equal(prefill.inputValue, "2026-10-10T14:00:45");
  assert.equal(prefill.apiValue, "2026-10-10T12:00:45Z");
  assert.equal(toLocalInputTime(value, "", "Europe/Paris"), prefill.inputValue, "the screenshot workflow retains toLocalInputTime");
  assert.equal(toApiDateTime(prefill.inputValue, prefill), prefill.apiValue);
});

test("a valid screenshot timezone-offset hint is converted before prefill", () => {
  const value = "2026-10-10 15:30:00";
  const prefill = screenshotTimePrefill(value, "", "Europe/Paris", 210);
  assert.equal(prefill.valid, true);
  assert.equal(prefill.inputValue, "2026-10-10T14:00:00");
  assert.equal(prefill.apiValue, "2026-10-10T12:00:00Z");
});

test("ambiguous daylight-saving wall time keeps its captured offset until edited", () => {
  const prefill = screenshotTimePrefill("2026-10-25T02:30:00+02:00", "", "Europe/Paris");
  assert.equal(prefill.inputValue, "2026-10-25T02:30:00");
  assert.equal(prefill.apiValue, "2026-10-25T00:30:00Z", "the repeated 02:30 remains the captured +02:00 instant");
  assert.equal(toApiDateTime(prefill.inputValue, prefill), "2026-10-25T00:30:00Z");
  assert.equal(toApiDateTime("2026-10-25T02:31:00", prefill), "2026-10-25 02:31:00", "a manual edit uses the server's profile-timezone policy");
});

test("unzoned wall time stays unchanged and invalid calendar values do not overwrite the form", () => {
  const wall = screenshotTimePrefill("2026-04-03T12:34", "2026-01-01T00:00", "Europe/Paris");
  assert.deepEqual(wall, { inputValue: "2026-04-03T12:34", apiValue: null, valid: true });
  assert.equal(toApiDateTime(wall.inputValue, wall), "2026-04-03 12:34:00");

  const invalid = screenshotTimePrefill("2026-02-30T12:34:00Z", "2026-04-03T12:34", "Europe/Paris");
  assert.deepEqual(invalid, { inputValue: "2026-04-03T12:34", apiValue: null, valid: false });
});
