#!/usr/bin/env bash
# Velora pre-push secret-safety scan (public repository policy — D-06/ADR-010).
# Exits non-zero on any finding.
#
# 2026-09-12 hardening (post-audit governance alignment):
#  - COVERAGE GAP CLOSED: previously only `git ls-files` (index) was scanned,
#    so brand-new untracked files were invisible until `git add` — a
#    scan-run-before-add could PASS while flaggable content sat in the tree
#    (this is exactly how e75b575's pre-commit PASS missed infra/docker-
#    compose.yml). Untracked-but-not-ignored files are now scanned too, so
#    scan/add ordering no longer matters.
#  - The URL-credential pattern excludes `${...}` env-placeholder syntax
#    (structural exclusion — same philosophy as the Reference
#    tools/n8n_archive/scan_archive_secrets.py): placeholders are not
#    credentials by design; values live in the environment. Literal
#    scheme://user:password@host matches are still flagged. Residual: a real
#    password containing `$`, `{`, or `}` evades this one heuristic — this
#    scan is a backstop, not the primary control (names-only env files +
#    review are).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# URL-credential detector, kept separate for readability. Double-quoted:
# \" -> ", \$ -> $ (prevents expansion), literals otherwise.
CRED_URL="://[^/\"' \${}]+:[^/@\"' \${}]+@"

PATTERNS="github_pat_|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[bpoas]-|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}|${CRED_URL}"

# Tracked (index + committed) AND untracked-but-not-ignored files, deduped.
# This script itself is excluded — it contains the detection patterns verbatim.
FILES=$({ git ls-files; git ls-files --others --exclude-standard; } | sort -u | grep -v "^tools/secret-scan.sh$" || true)

if [ -z "$FILES" ]; then echo "secret-scan: no files to scan"; exit 0; fi

MATCHES=$(echo "$FILES" | xargs grep -rIlE "$PATTERNS" 2>/dev/null || true)
if [ -n "$MATCHES" ]; then
  echo "SECRET-SCAN: FAIL — potential secrets in:" >&2
  echo "$MATCHES" >&2
  exit 1
fi
echo "SECRET-SCAN: PASS (0 findings)"
