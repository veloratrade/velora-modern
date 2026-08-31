#!/usr/bin/env bash
# Velora pre-push secret-safety scan (public repository policy — D-06/ADR-010).
# Exits non-zero on any finding. Scans tracked files only.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

PATTERNS='github_pat_|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[bpoas]-|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|://[^/"'"'"' ]+:[^/@"'"'"' ]+@'

# files tracked by git (staged+committed); never scans node_modules (ignored).
# This script itself is excluded — it contains the detection patterns verbatim.
FILES=$(git ls-files | grep -v "^tools/secret-scan.sh$" || true)

if [ -z "$FILES" ]; then echo "secret-scan: no tracked files"; exit 0; fi

MATCHES=$(echo "$FILES" | xargs grep -rIlE "$PATTERNS" 2>/dev/null || true)
if [ -n "$MATCHES" ]; then
  echo "SECRET-SCAN: FAIL — potential secrets in:" >&2
  echo "$MATCHES" >&2
  exit 1
fi
echo "SECRET-SCAN: PASS (0 findings)"
