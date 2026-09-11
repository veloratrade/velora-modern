# Staging Environment — Isolation Architecture

Modern-native successor to PHP `docs/STAGING_ENVIRONMENT.md`. The PHP staging
model (same FTP account, separation by convention + owner confirm) is replaced
by Railway-native isolation; the separation RULES below are stricter, not weaker.

## 1. Isolation architecture

- Railway project `Velora` (`56d1762e-…`) holds two isolated environments with
  SEPARATE service instances, runtimes, variables, and deployment histories
  (see `docs/infrastructure/railway-baseline.md`).
- Staging and production NEVER share: service instance, variables/secrets,
  deployment history, or (once attached) databases.
- GitHub mirrors this: `staging` and `production` environments with
  environment-scoped secrets (`RAILWAY_TOKEN`) and variables (`STAGING_APP_URL`
  / `PROD_APP_URL`, `STAGING_FRONTEND_URL`).

## 2. Separation rules (mandatory)

1. Staging-first: production deploys require a green staging smoke
   (`staging_gate` job) on the same commit. No exceptions, no inputs to skip it.
2. Origin contract: staging serves ONLY `https://staging-modern.veloratrade.ir`;
   the deploy preflight fails closed on any other `FRONTEND_URL` value.
3. Secret scoping: staging secrets live on the GitHub `staging` environment;
   production secrets on `production`. A staging token must never authenticate
   to production (Railway token scoping + separate `RAILWAY_TOKEN` values).
4. Namespace discipline: backup evidence, provenance records, and reports carry
   the environment name and are validated against it (`db-backup-<env>-…`,
   `environment == expected_env`). Cross-env evidence reuse fails closed.
5. No production data in staging: fixtures and synthetic users only. (Enforced
   in the database phase; stated now so no procedure violates it early.)

## 3. Staging deploy/test reference

- Deploy: dispatch `deploy-staging.yml` (dry-run default true) — see `DEPLOY_RUNBOOK.md`.
- Smoke: dispatch `healthcheck-staging.yml` (guard probes on) at any time.
- Logs: dispatch `error-log-staging.yml` with `READ`.
- Rollback: dispatch `rollback.yml` with `target_environment: staging`.

## 4. Staging checklist (before calling staging "green")

- [ ] `deploy-staging.yml` ran with `dry_run: false` and reported success.
- [ ] Post-deploy verify passed (suite: /health, headers, 404 envelope, guard probes).
- [ ] Live version recorded in the deployment report matches the released commit's intent.
- [ ] No `::warning::version drift` unresolved without a linked explanation.
- [ ] Backup path recorded: `evidence` (preferred) or `bootstrap` with justification.
