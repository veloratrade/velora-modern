# Release Checklist (human procedure)

Modern-native successor to PHP `docs/RELEASE_CHECKLIST.md`. The operator works
through this list for EVERY release; each item cites its machine evidence.

## A. Pre-release (on the release commit)

- [ ] A1. CI green on HEAD (`ci.yml`: validate + secret scan).
- [ ] A2. Quality gate green on HEAD (`quality-gate.yml` dispatched or called; link run).
- [ ] A3. PR template completed; owner review recorded (merge policy §2).
- [ ] A4. No database change in the release (deferred phase) — or explicit owner approval cited.
- [ ] A5. i18n: `i18n:check` green; new strings in both catalogs; Latin digits; brand tokens intact.

## B. Staging release

- [ ] B1. `deploy-staging.yml` dispatched with `dry_run: true` first; plan reviewed.
- [ ] B2. Backup path decided: evidence inputs ready, OR `EMPTY-TARGET-BOOTSTRAP`
      attested (only if staging provably holds no data).
- [ ] B3. `deploy-staging.yml` dispatched with `dry_run: false`; preflight + backup
      gate + battery + deploy + verify all green.
- [ ] B4. Staging checklist (`STAGING_ENVIRONMENT.md` §4) completed.
- [ ] B5. Deployment report + provenance artifact saved (retention 14d; summary persists).

## C. Production release

- [ ] C1. Staging is green ON THE SAME COMMIT (re-verify, do not assume).
- [ ] C2. Owner confirm phrase ready: `CONFIRM-PRODUCTION-DEPLOY` (typed at dispatch, never stored).
- [ ] C3. Backup path decided for production (evidence preferred; bootstrap only if
      production provably holds no data — see `BACKUP_POLICY.md`).
- [ ] C4. `deploy.yml` dispatched with `dry_run: true` first; plan reviewed.
- [ ] C5. `deploy.yml` dispatched with `dry_run: false`; gate + staging-green +
      backup + battery + deploy + verify all green.
- [ ] C6. Production smoke re-run manually within 30 minutes of release.
- [ ] C7. Deployment report + provenance artifact saved.

## D. Post-release

- [ ] D1. Watch staging/production health for 24h (any anomaly → `DIAGNOSTICS_RUNBOOK.md`).
- [ ] D2. Record release (commit, versions, backup path, reports) in the ops log.
- [ ] D3. Rollback readiness: last-known-good SHA = previous production commit
      (provenance record linked); `rollback.yml` rehearsed on staging at least once.
