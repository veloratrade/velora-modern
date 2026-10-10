#!/usr/bin/env bash
# VELORA MODERN — PostgreSQL backup producer (create -> verify -> evidence).
#
# AUDIT-FIRST NOTE
# ================
# The Reference producer (veloratrade/veloratrade :: velora-db-backup.yml +
# probe/db_backup_probe.php.tmpl) is deliberately NOT ported: it is MySQL-
# specific (SHOW CREATE TABLE / information_schema via PDO), it ships a one-use
# PHP probe over FTP into a cPanel docroot, and reaching it would violate the
# project's production-access rule. Modern is PostgreSQL on a container
# platform, so the PRODUCER is adapted while the EVIDENCE CONTRACT and the
# storage destination are reused unchanged.
#
# This script performs stages 1-2 of the chain and emits evidence:
#     1. create             pg_dump  (custom format, gzipped)
#     2. verify integrity   gzip -t + sha256 + non-zero size
#     -> writes <backup_id>.json evidence with storage_status=NONE
#
# Stages 3-4 (official storage + storage verification) are performed by the
# uploader, which must set storage_status=STORAGE_VERIFIED only after re-reading
# and re-hashing the STORED bytes. This script never claims storage success.
#
# It NEVER prints DATABASE_URL or any credential.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL required (never echoed)}"
: "${ENVIRONMENT:?ENVIRONMENT required (staging|production)}"
: "${SOURCE_COMMIT_SHA:?SOURCE_COMMIT_SHA required}"

case "$ENVIRONMENT" in
  staging|production) ;;
  *) echo "::error::invalid ENVIRONMENT: $ENVIRONMENT" >&2; exit 2 ;;
esac

OUT_DIR="${1:-./backup-artifacts}"
mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%d%H%M%S)"
RAND="$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BACKUP_ID="db-backup-${ENVIRONMENT}-${STAMP}-${RAND}"
ARTIFACT="${OUT_DIR}/${BACKUP_ID}.dump.gz"

echo "backup_id: ${BACKUP_ID}"

# --- 1) CREATE ------------------------------------------------------------- #
# --no-owner/--no-privileges keep the dump portable across role setups.
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | gzip -9 > "$ARTIFACT"

if [ ! -s "$ARTIFACT" ]; then
  echo "::error::backup artifact is empty — refusing to emit evidence" >&2
  exit 1
fi

# --- 2) VERIFY INTEGRITY --------------------------------------------------- #
if ! gzip -t "$ARTIFACT" 2>/dev/null; then
  echo "::error::gzip integrity check FAILED — refusing to emit evidence" >&2
  exit 1
fi

SHA256="$(sha256sum "$ARTIFACT" | awk '{print $1}')"
SIZE_BYTES="$(wc -c < "$ARTIFACT" | tr -d ' ')"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- EVIDENCE (storage stages NOT yet performed) --------------------------- #
EVIDENCE="${OUT_DIR}/${BACKUP_ID}.json"
cat > "$EVIDENCE" <<JSON
{
  "schema": "velora-backup/2",
  "backup_id": "${BACKUP_ID}",
  "environment": "${ENVIRONMENT}",
  "backup_type": "database",
  "source_commit_sha": "${SOURCE_COMMIT_SHA}",
  "created_at": "${CREATED_AT}",
  "sha256": "${SHA256}",
  "size_bytes": ${SIZE_BYTES},
  "db_engine": "postgresql",
  "verification_status": "INTEGRITY_VERIFIED",
  "storage_status": "NONE",
  "stored_at": null,
  "release_tag": null,
  "backup_repo": "veloratrade/velora-backups",
  "creation_mechanism": "pg_dump custom+gzip via ops/backup/create_pg_backup.sh"
}
JSON

echo "artifact: ${ARTIFACT}"
echo "sha256:   ${SHA256}"
echo "size:     ${SIZE_BYTES} bytes"
echo "evidence: ${EVIDENCE}"
echo
echo "NOTE: storage_status=NONE. The gate will REJECT this evidence until an"
echo "      uploader stores the artifact in veloratrade/velora-backups and sets"
echo "      storage_status=STORAGE_VERIFIED after re-hashing the stored bytes."

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "backup_id=${BACKUP_ID}"
    echo "sha256=${SHA256}"
    echo "artifact=${ARTIFACT}"
    echo "evidence=${EVIDENCE}"
  } >> "$GITHUB_OUTPUT"
fi
