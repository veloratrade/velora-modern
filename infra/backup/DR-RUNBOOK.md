# Backup / Restore / DR Runbook

Policy owner: `docs/security-policy.md` §11-12, **ADR-012** (the backup gate) and
`ops/backup/README.md` (the chain: create → verify → store → verify storage →
evidence → GATE → deploy).

**The rule that governs this document:** a backup that was never restored is not a
backup. Mechanism ≠ backup ≠ restore.

## Status (2026-10-04) — a real backup has been restored, and the RESTORE is verified

| Item | State | Evidence |
|---|---|---|
| Backup producer (`pg_dump` custom + gzip, real artifact) | **EXECUTED** | `db-backup-staging-20261004095454-bb023e0cab03`, 32 926 bytes, sha256 `b289558f…` |
| Integrity verification (gzip + sha256 + non-zero size) | **EXECUTED** | `ops/backup/create_pg_backup.sh` output + the evidence record |
| **Restore drill** (restore into a disposable database + parity + smoke) | **EXECUTED, VERIFIED** | `ops/backup/evidence/restore-drill-staging-20261004T095454Z.json` |
| Offsite storage + re-hash of the STORED bytes (`storage_status=STORAGE_VERIFIED`) | **NOT DONE** | no storage credential in this environment; the gate REJECTS the record on `release_tag` + `storage_status` |
| Production / staging drill against real data | **NOT DONE** | needs a deployed environment |
| RPO / RTO targets | **OWNER DECISION** (`OD-AC-RPORTO`) | — |

The previous revision of this file said *"BLOCKED — no PostgreSQL environment exists
in the dev sandbox (Docker absent)"*. That is no longer true (a disposable
PostgreSQL 17 runs in the workspace), and the drill has been executed against it.

`infra/backup/backup.sh` and `infra/backup/restore.sh` (the foundation pair) remain
the minimal scripts they are: they take a dump and put it back. They have no
verification, no parity gates and no evidence, so they are NOT the DR path — use
`ops/backup/create_pg_backup.sh` (create + verify + evidence + gate) and
`ops/backup/restore_drill.mjs` (restore + parity + smoke + evidence).

## The drill (one command)

```bash
DATABASE_URL=<source> \
DRILL_DATABASE_URL=<target — its database name MUST end in _drill> \
ENVIRONMENT=staging SOURCE_COMMIT_SHA=$(git rev-parse HEAD) \
node ops/backup/restore_drill.mjs [--keep] [--out DIR]
```

What it does, in order:

1. **create** — a real backup through the project's own producer, not a private
   code path, so the drill exercises what a scheduled backup exercises;
2. **restore** — `pg_restore` into the target, which is dropped and recreated
   first (the only thing the drill ever drops);
3. **parity** — table set, row counts and the exact decimal SUM of every numeric
   column, discovered from `pg_catalog` (74 comparisons in the executed run:
   44 tables + 49 numeric columns), plus the `schema_migrations` ledger;
4. **application smoke** — `tools/pg-smoke.ts` in `PG_SMOKE_SCHEMA=restored` mode
   against the RESTORED copy (11/11: driver facts, ADR-001 scales, the exit
   trigger, transaction rollback, row locks, unique violations, upserts);
5. **evidence** — a `velora-backup/2` record with `verification_status:
   RESTORE_VERIFIED` when, and only when, parity and smoke both passed, plus the
   ADR-012 gate's verdict on the record, reasons included.

Safety properties, all fail-closed and unit tested (`ops/backup/tests/restoreDrill.test.ts`):

* the target database name must end in `_drill`, must differ from the source, and
  must not be `postgres`/`template1` — a drill that can be pointed at a real
  database is a drill that will one day delete one;
* no connection string, password or credential is printed or written; the evidence
  carries host/port/database names only;
* physical relation size is recorded as an **observation**, never a gate: a live
  source accumulates dead tuples, so size legitimately differs after a restore.

## Executed drill record (2026-10-04)

```
source      127.0.0.1:54329/velora_phase1        target  127.0.0.1:54329/velora_phase4_drill
artifact    db-backup-staging-20261004095454-bb023e0cab03 · 32 926 bytes
sha256      b289558f1219a5b4822333ebeed5723436dfff52f90aafeb3069828f35d55c57
restore     343 ms (pg_restore, --no-owner --no-privileges, --exit-on-error)
parity      PASS — 44 tables · 49 numeric columns · schema_migrations head 0025_trade_financial_guards.sql
smoke       PASS — 11/11 against the restored copy
verdict     RESTORE_VERIFIED · storage_status NONE · gate REJECT (release_tag + storage_status)
```

The first run of the drill FAILED and is kept as evidence
(`…T095423Z.json`, `RESTORE_FAILED`): the smoke was asserting a fresh migration
apply, which is the wrong claim about a restored copy. Two defects were fixed
rather than the drill being relaxed — `PG_SMOKE_SCHEMA=restored` now asserts the
ledger (every migration present, in order) and S2's trade fixture was completed to
satisfy 0025. A drill whose first green run is its first run has not been tested.

## What remains before this is production-grade DR

1. **Offsite storage**: `ops/backup/upload_backup.py` → `veloratrade/velora-backups`,
   then re-read and re-hash the STORED bytes and set `storage_status=STORAGE_VERIFIED`.
   Without this the deployment gate keeps rejecting the record — correctly.
2. **Production drill**: the same command against staging/production data, scheduled
   (not ad-hoc), with the result recorded in the environment's evidence record.
3. **RPO/RTO**: owner decision — PITR via WAL archiving is the mechanism that
   satisfies a small RPO; nightly dumps alone do not.
4. **Restore of the object store** (screenshots/attachments) — ADR-010 StoragePort;
   `trade_attachments` rows reference objects whose bytes live elsewhere, so a
   database-only restore is only half a restore once attachments are in use.
