# Backup/Restore Runbook (foundation)

Policy owner: `docs/security-policy.md` §11-12 and ADR-010 (restore drill = release gate).

## Dev/staging (once a PostgreSQL environment exists — currently BLOCKED, no PG in sandbox)

1. `bash infra/backup/backup.sh /mnt/storage/backups` — `pg_dump` (custom format).
2. `bash infra/backup/restore.sh /mnt/storage/backups/velora-<stamp>.dump` into a
   DISPOSABLE database, then verify application-level recovery:
   `GET /health` → 200 `{status:"ok"}`, plus row spot-checks (counts per core table).
3. Record the drill: date, duration, dump size, checksum — in the environment's
   evidence record. A backup that was never restored is not a backup.

## Production (Gate 3B side — later)

- PITR via WAL archiving + nightly dumps; encrypted; offsite via StoragePort.
- RPO/RTO targets: owner decision at production-readiness review.
- Restore drill scheduled, not ad-hoc.

## Current status (2026-08-31)

BLOCKED — no PostgreSQL environment exists in the dev sandbox (Docker absent).
This is an environment blocker, not a completed drill. Gate 3B rows 7/8 remain
NOT VALIDATED.
