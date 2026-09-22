#!/usr/bin/env bash
# Real-PostgreSQL evidence runner — every `db/tests/*.pg.test.ts` battery, both
# in file order and REVERSED.
#
# WHY THIS EXISTS AS A SCRIPT. Pass 2 discovered that a battery asserted on
# `# fail 0` alone can pass while having executed nothing (a silently skipped
# battery is not evidence), and that a hard-coded count in CI drifted away from
# the files it counted. This runner takes each battery's declared top-level test
# count from the SOURCE and requires:
#
#   # tests   >= declared        (the battery actually ran)
#   # skipped == 0               (nothing was skipped, silently or otherwise)
#   # fail    == 0               (no failures)
#
# It then runs the whole set in reverse file order, because an order-dependent
# battery — one that depends on state another battery left behind — is a false
# positive waiting to happen.
#
# Usage:  DATABASE_URL=postgres://… tools/run-pg-batteries.sh
set -uo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required (this runner is the real-PostgreSQL evidence path)" >&2
  exit 2
fi

cd "$(dirname "$0")/.." || exit 1
LOG_DIR="${PG_BATTERY_LOG_DIR:-/tmp/pg-batteries}"
mkdir -p "$LOG_DIR"

mapfile -t BATTERIES < <(ls db/tests/*.pg.test.ts | sort)
if [[ "${#BATTERIES[@]}" -eq 0 ]]; then
  echo "no batteries found — refusing to report success" >&2
  exit 1
fi

run_one() {
  local file="$1" label="$2" log=""
  local declared
  declared=$(grep -cE '^test\(' "$file")
  log="${LOG_DIR}/$(basename "${file%.ts}").${label}.log"
  npx tsx --test "$file" >"$log" 2>&1
  local tests skipped failed
  tests=$(awk '/^# tests /{print $3}' "$log")
  skipped=$(awk '/^# skipped /{print $3}' "$log")
  failed=$(awk '/^# fail /{print $3}' "$log")
  printf '%-46s %-8s tests=%-4s skipped=%-3s fail=%-3s (declared %s)\n' \
    "$(basename "$file")" "$label" "${tests:-?}" "${skipped:-?}" "${failed:-?}" "$declared"
  if [[ -z "$tests" || "$tests" -lt "$declared" ]]; then
    echo "  FAIL: executed fewer tests than declared — the battery did not run" >&2
    tail -n 20 "$log" >&2
    return 1
  fi
  [[ "$skipped" == "0" ]] || { echo "  FAIL: ${skipped} skipped — a skipped battery is NOT evidence" >&2; return 1; }
  [[ "$failed" == "0" ]] || { echo "  FAIL: ${failed} failures" >&2; tail -n 30 "$log" >&2; return 1; }
  return 0
}

failures=0
total=0
echo "── forward order ────────────────────────────────────────────────────────"
for file in "${BATTERIES[@]}"; do
  total=$((total + 1))
  run_one "$file" "forward" || failures=$((failures + 1))
done

echo "── reverse order ────────────────────────────────────────────────────────"
for (( i=${#BATTERIES[@]}-1; i>=0; i-- )); do
  run_one "${BATTERIES[$i]}" "reverse" || failures=$((failures + 1))
done

echo "─────────────────────────────────────────────────────────────────────────"
echo "batteries: ${total}  runs: $((total * 2))  failures: ${failures}"
if [[ "$failures" -ne 0 ]]; then
  exit 1
fi
echo "REAL-PG EVIDENCE: PASS"
