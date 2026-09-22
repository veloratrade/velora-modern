#!/usr/bin/env bash
# Backup — ADR-010: PITR is the production target; this is the dump-level
# script for dev/staging drills. Restore drill = Gate 3B requirement.
# STATUS: not executable in the dev sandbox (no PostgreSQL/Docker) — blocked,
# documented, never faked.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL required}"
OUT_DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f "$OUT_DIR/velora-$STAMP.dump"
echo "backup written: $OUT_DIR/velora-$STAMP.dump"
# Offsite copy target is provided by the StoragePort mount in staging/production.
