#!/usr/bin/env node
// Verdict logic for the root test runner — extracted so it can be UNIT TESTED.
//
// WHY THIS MODULE EXISTS (a real defect, found 2026-10-04 during Phase 4).
// The previous inline logic was:
//
//     let retryOk = true;
//     if (!general.ok) retryOk = retrySigkilled(sigkilledFiles(general.output)) && retryOk;
//     ...
//     } else if (retryOk) { console.log("ALL TEST FILES PASSED (after re-running …)"); }
//
// `retrySigkilled([])` returns `true`. So a batch that failed with ASSERTION
// failures and ZERO OS-kills took the "retried successfully" branch: the run
// printed “ALL TEST FILES PASSED (after re-running OS-killed files individually)”
// and exited 0 while real tests were failing. It happened for real: seven test
// files were red (a new CHECK constraint exposed incomplete fixtures) and the
// suite still reported green. A green suite that can print green over red is
// worse than a red suite.
//
// THE RULE, stated once, fail-closed:
//
//   * a batch is PASS when it exits 0;
//   * a batch that fails may ONLY be excused for the ONE class that is not a test
//     result — files killed by a SIGNAL (PGlite is in-process WASM; a small
//     container SIGKILLs it). Excusing requires that every failure in the batch be
//     accounted for by a killed file: `failCount === killedFiles.length`;
//   * if the batch reports MORE failures than killed files, the excess are real
//     results → FAIL, no retry;
//   * if the batch failed but its `# fail` line cannot be parsed, or the kill
//     markers cannot be matched to a file, → FAIL (never assume the benign class);
//   * each killed file is re-run alone and must pass on its own.
//
// Everything is derived from the batch's own output, so the runner cannot claim
// more than the batch proved.

/** The `# fail N` line the node test runner prints per batch. */
export function parseFailCount(output) {
  // The LAST summary line is the batch total (a batch prints one summary).
  const matches = [...output.matchAll(/^# fail (\d+)\s*$/gm)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

/** `# tests N` / `# pass N` / `# skipped N` for the audit trail. */
export function parseCount(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, "gm"))];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

/**
 * Files whose failure is a SIGNAL, not an assertion.
 *
 * A `not ok` subtest line names the test; the SIGKILL marker appears in the same
 * failure block. Returns the test names, which the runner maps back to files.
 */
export function sigkilledTests(output) {
  const killed = [];
  let current = null;
  for (const line of output.split("\n")) {
    const subtest = /^not ok \d+ - (.+)$/.exec(line.trim());
    if (subtest) current = subtest[1].trim();
    if (current !== null && /signal: 'SIGKILL'/.test(line)) {
      killed.push(current);
      current = null;
    }
  }
  return killed;
}

/**
 * Resolve one batch into a decision.
 *
 * `killedFiles` must be the files the caller actually intends to re-run — derived
 * from `sigkilledTests` by mapping test names to source files. If a killed test
 * name cannot be mapped, the batch is a failure (we do not retry what we cannot
 * name, and we cannot excuse it either).
 */
export function batchVerdict({ ok, output, killedFiles = [], unresolvedKills = 0 }) {
  if (ok) return { decision: "pass", retry: [], reason: "batch exited 0" };
  const failCount = parseFailCount(output);
  if (failCount === null) {
    return { decision: "fail", retry: [], reason: "the batch failed and reported no `# fail` count — cannot excuse it" };
  }
  if (failCount === 0) {
    return { decision: "fail", retry: [], reason: "the batch exited non-zero while reporting 0 failures — treat as a harness error" };
  }
  if (unresolvedKills > 0) {
    return { decision: "fail", retry: [], reason: `${unresolvedKills} SIGKILLed test(s) could not be mapped to a file` };
  }
  if (killedFiles.length === 0) {
    return { decision: "fail", retry: [], reason: `${failCount} failure(s), none of them an OS kill — assertion failures are never retried` };
  }
  if (failCount > killedFiles.length) {
    return {
      decision: "fail",
      retry: [],
      reason: `${failCount} failure(s) but only ${killedFiles.length} OS-killed file(s) — ${failCount - killedFiles.length} real failure(s) would have been masked`,
    };
  }
  return { decision: "retry", retry: killedFiles, reason: `every one of the ${failCount} failure(s) is an OS kill` };
}

/** Overall verdict, given each batch's post-retry state. */
export function overallVerdict(batches) {
  const failed = batches.filter((b) => b.decision !== "pass");
  return {
    ok: failed.length === 0,
    failed,
    summary: failed.length === 0
      ? "ALL TEST FILES PASSED"
      : `TEST RUN FAILED — ${failed.map((b) => `${b.name}: ${b.reason}`).join("; ")}`,
  };
}

if (process.argv[1] && process.argv[1].endsWith("testRunnerVerdict.mjs")) {
  // Manual probe: feed a captured batch output on stdin and print the verdict.
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const output = Buffer.concat(chunks).toString("utf8");
    console.log(JSON.stringify(batchVerdict({ ok: false, output, killedFiles: sigkilledTests(output) }), null, 2));
  });
}
