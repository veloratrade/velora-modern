# Deploy Runbook — Staging & Production Procedures

Step-by-step operator procedures for `deploy-staging.yml` and `deploy.yml`.
Read `RELEASE_CHECKLIST.md` first; this runbook is the HOW for its items.

## 0. Prerequisites (both envs)

- GitHub Environments `staging` / `production` exist; `production` has required
  reviewers (owner action — see `PROVISIONING_RUNBOOK.md`).
- Environment secrets: `RAILWAY_TOKEN` (per-env values). Environment variables:
  `STAGING_APP_URL`, `PROD_APP_URL`, `STAGING_FRONTEND_URL`.
- The release commit shows green CI + green quality gate (link both runs).

## 1. Staging deploy

1. Actions → `Deploy Staging` → Run workflow → branch/tag: the release commit.
2. Inputs: `dry_run: true` (default) → Run. Review the plan in the summary.
3. Decide the backup path and fill inputs accordingly:
   - Evidence path: all six evidence fields (final phase).
   - Bootstrap path: `bootstrap_ack: EMPTY-TARGET-BOOTSTRAP` (only if staging
     provably holds no data — verify 0-data state, do not assume).
4. Run again with `dry_run: false`. Watch: preflight (URL contract + cost) →
   backup gate → battery → deploy → live verify → report.
5. Any red job stops the chain (fail-closed). Fix forward; never re-run a
   single failed deploy step out of order — re-dispatch the workflow.
6. Complete `STAGING_ENVIRONMENT.md` §4 and file the deployment report link.

## 2. Production deploy

1. Confirm staging is green ON THE SAME COMMIT (open the staging report; check
   the SHA, not the branch name).
2. Actions → `Deploy Production` → Run workflow on the release commit.
3. Inputs: `confirm_production_deploy: CONFIRM-PRODUCTION-DEPLOY` (exact),
   `dry_run: true` first. Review the plan.
4. Decide the production backup path (evidence preferred; bootstrap only with
   the same empty-target proof as staging).
5. Run with `dry_run: false`. Chain: owner gate → staging-green precondition →
   backup gate → battery → deploy → live verify → report. The `production`
   environment reviewers approve at the gate.
6. Within 30 minutes: manually dispatch `Health Check (production)` (read-only)
   and confirm green. Record the release per `RELEASE_CHECKLIST.md` §D.

## 3. Failure handling

| Failure | Response |
|---|---|
| Preflight red (URL/cost) | Fix the contract violation; never edit the guard to pass. |
| Backup gate red | Produce valid evidence (or prove empty-target); the gate is the law. |
| Battery red | Fix on a branch; new commit = new release candidate from §A. |
| `railway up` red | Check Railway status + CLI output; target unchanged until `up` succeeds. |
| Live verify red after green deploy | Treat as failed release: diagnose (`DIAGNOSTICS_RUNBOOK.md`); roll back (`ROLLBACK.md`) if user-facing. |
| Report says `bootstrap` unexpectedly | Investigate: evidence inputs may have been dropped. |

## 4. What deploys never do

- Never apply database migrations (no migration step exists in these
  workflows — deferred phase adds a separately gated migration procedure).
- Never write secrets anywhere (Railway variables are provisioned by the
  owner procedure, never by deploy workflows).
- Never deploy on push (manual dispatch only).
