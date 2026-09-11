# Rollback — Code Rollback Procedure + Database Boundary

Modern-native successor to the PHP rollback discipline (docroot pre-deploy
backup + redeploy + verified DB backup id). Railway deployments are immutable,
so code rollback = rebuild + redeploy a last-known-good commit. Database
restore is DEFERRED (final phase) — the boundary below is explicit.

## 1. Code rollback (implemented: `rollback.yml`)

1. Identify the last-known-good SHA from the previous deployment/rollback
   provenance record (40-hex, full SHA required).
2. Confirm schema compatibility: the database (once it exists) must work with
   the old code, or the rollback will trade one outage for another. There is
   no automated check for this today — operator judgment, recorded in the run.
3. Dispatch `rollback.yml`: `target_environment`, `last_good_sha`,
   `confirm_rollback: ROLLBACK-APPROVED`, `dry_run: true` first, then `false`.
4. The workflow rebuilds at that SHA (typecheck + build), redeploys via
   `railway up`, live-verifies, and writes a rollback provenance record
   (stamped `database_restore: DEFERRED`).

## 2. What rollback does NOT do (deferred, not forgotten)

- No database restore, no down-migration, no data repair. If the incident
  involves data corruption or a forward-only schema change, code rollback
  alone is INSUFFICIENT — escalate to the owner and the (future) database
  restore runbook.
- No automatic trigger: rollback is always a conscious manual dispatch.

## 3. Rehearsal requirement

`rollback.yml` MUST be rehearsed on staging (`dry_run: false` against staging)
at least once before the first production release, and after any change to the
workflow itself. An unrehearsed rollback path is treated as not existing.

## 4. Rollback readiness checklist (per release)

- [ ] Last-known-good SHA identified (= previous production commit) and linked.
- [ ] Schema compatibility confirmed (or N/A: no database attached yet).
- [ ] Rollback workflow unchanged since last rehearsal (or re-rehearsed).
