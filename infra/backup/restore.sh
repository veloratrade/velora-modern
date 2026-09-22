#!/usr/bin/env bash
# Restore drill — the drill MUST demonstrate a running stack serving from the
# restored data (ADR-010: "restore drill is a release gate, not a hope").
# STATUS: blocked in the dev sandbox (no PostgreSQL); execute on dev/staging.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
DUMP="${1:?usage: restore.sh <dumpfile>}"
createdb "$(node -e 'console.log(new URL(process.env.DATABASE_URL!).pathname.slice(1))')" 2>/dev/null || true
pg_restore --no-owner --no-privileges --clean --if-exists --dbname "$DATABASE_URL" "$DUMP"
echo "restored from $DUMP — now verify application-level connectivity (/health + row spot-checks)"
