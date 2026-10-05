// Regression test for the root test runner's verdict logic.
//
// WHY: on 2026-10-04 the runner printed “ALL TEST FILES PASSED (after re-running
// OS-killed files individually)” and exited 0 while SEVEN tests were failing. The
// inline logic treated “batch failed, zero OS kills” as “retried successfully”
// because `retrySigkilled([]) === true`. The rule now lives in
// `tools/lib/testRunnerVerdict.mjs` and these tests pin the property that matters:
// a red batch can never be reported green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchVerdict, overallVerdict, parseCount, parseFailCount, sigkilledTests } from "./lib/testRunnerVerdict.mjs";

const summary = (tests: number, pass: number, fail: number, skipped = 0) =>
  `# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skipped}\n`;

/** A `not ok` block the way node prints a file the OS killed. */
const killed = (name: string) =>
  `not ok 22 - ${name}\n  ---\n  failureType: 'testCodeFailure'\n  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'\n  signal: 'SIGKILL'\n  ...\n`;

/** A `not ok` block from a real assertion. */
const assertion = (name: string, message: string) =>
  `not ok 23 - ${name}\n  ---\n  failureType: 'testCodeFailure'\n  error: '${message}'\n  code: 'ERR_ASSERTION'\n  ...\n`;

test("parses the batch summary the node test runner prints", () => {
  assert.equal(parseFailCount(summary(999, 999, 0)), 0);
  assert.equal(parseFailCount(summary(63, 56, 7)), 7);
  assert.equal(parseCount(summary(63, 56, 7, 2), "skipped"), 2);
  assert.equal(parseFailCount("no summary here"), null);
});

test("a killed subtest is recognised from its own block, an assertion is not", () => {
  const output = summary(2, 0, 2) + killed("PGlite battery") + assertion("real test", "boom");
  assert.deepEqual(sigkilledTests(output), ["PGlite battery"]);
});

test("THE BUG: a red batch with zero OS kills can never be excused", () => {
  const output = summary(63, 56, 7) + assertion("migration contract", 'violates check constraint "trades_closed_has_financials"');
  const verdict = batchVerdict({ ok: false, output, killedFiles: [] });
  assert.equal(verdict.decision, "fail");
  assert.match(verdict.reason, /none of them an OS kill/);
  // …and the overall verdict follows: the suite must exit non-zero.
  assert.equal(overallVerdict([{ name: "PGlite batch", decision: verdict.decision, reason: verdict.reason }]).ok, false);
});

test("a batch with BOTH kills and assertion failures is a failure — only the kills are retryable", () => {
  const output = summary(10, 7, 3) + killed("OOM file") + assertion("real test", "boom");
  const verdict = batchVerdict({ ok: false, output, killedFiles: ["db/tests/oom.test.ts"] });
  assert.equal(verdict.decision, "fail");
  assert.match(verdict.reason, /3 failure\(s\) but only 1 OS-killed file/);
});

test("a batch whose failures are ALL kills is retried, once, per file", () => {
  const output = summary(10, 8, 2) + killed("OOM one") + killed("OOM two");
  const verdict = batchVerdict({ ok: false, output, killedFiles: ["db/tests/a.test.ts", "db/tests/b.test.ts"] });
  assert.equal(verdict.decision, "retry");
  assert.deepEqual(verdict.retry, ["db/tests/a.test.ts", "db/tests/b.test.ts"]);
});

test("a kill that cannot be mapped back to a file is a failure, never an excuse", () => {
  const output = summary(3, 2, 1) + killed("a test name that is nowhere in the sources");
  const verdict = batchVerdict({ ok: false, output, killedFiles: [], unresolvedKills: 1 });
  assert.equal(verdict.decision, "fail");
  assert.match(verdict.reason, /could not be mapped/);
});

test("fail-closed on a batch that failed without a parseable summary", () => {
  const verdict = batchVerdict({ ok: false, output: "the process died before printing anything", killedFiles: [] });
  assert.equal(verdict.decision, "fail");
  assert.match(verdict.reason, /no `# fail` count/);
});

test("a passing batch needs no excuses", () => {
  const verdict = batchVerdict({ ok: true, output: summary(999, 999, 0), killedFiles: [] });
  assert.equal(verdict.decision, "pass");
  assert.deepEqual(verdict.retry, []);
});

test("overall summary names the batches that failed", () => {
  const verdict = overallVerdict([
    { name: "general batch", decision: "pass", reason: "batch exited 0" },
    { name: "PGlite batch", decision: "fail", reason: "7 failure(s), none of them an OS kill" },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.summary, /PGlite batch: 7 failure\(s\)/);
  assert.equal(overallVerdict([{ name: "general batch", decision: "pass", reason: "batch exited 0" }]).ok, true);
});
