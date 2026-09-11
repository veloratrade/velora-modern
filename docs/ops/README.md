# Velora Modern — Operations Handbook

The Modern-native successor to the PHP Engineering Operations Handbook
(`docs/README.md` runbooks RB-1..5, environment matrices, change management).
Procedures here are Railway/Node-native; safety properties are preserved from PHP.

> Structural note: this `docs/ops/` area is new. At commit time, run
> `npm run structure:check -- --update` to index it in
> `docs/architecture/STRUCTURE_BASELINE.md` (governed baseline update).

## Non-negotiables (from the Operational Contract)

1. Evidence first — no claim without machine output.
2. Secret names only — values never in git, logs, artifacts, or chat.
3. Production only via gated workflows + owner confirm — never ad hoc.
4. Backup law — evidence or empty-target attestation, XOR, no skip flag.
5. Fail closed — unknown state blocks.

## Environment matrix

| Environment | Railway env ID | Service instance | GitHub env | Deploys | Data |
|---|---|---|---|---|---|
| staging | `9e50b277-…` (see railway-baseline) | `afa44c0a-…` | `staging` | 0 | none |
| production | `a4df12df-…` (see railway-baseline) | `8ecdbf11-…` | `production` (required reviewers) | 0 | none |

Full topology: `docs/infrastructure/railway-baseline.md`.
Isolation architecture + separation rules: `STAGING_ENVIRONMENT.md`.

## Runbook map

| Operation | Runbook | Workflow |
|---|---|---|
| Release staging / production | `DEPLOY_RUNBOOK.md` | `deploy-staging.yml` / `deploy.yml` |
| Roll back code (DB restore deferred) | `ROLLBACK.md` | `rollback.yml` |
| Smoke-check a live env | `DIAGNOSTICS_RUNBOOK.md` | `healthcheck-staging.yml` / `healthcheck-production.yml` |
| Read staging log tail | `DIAGNOSTICS_RUNBOOK.md` | `error-log-staging.yml` |
| Backup law + evidence handling | `BACKUP_POLICY.md` | `backup-evidence-gate.yml` (reusable) |
| Release gate (battery) | `RELEASE_CHECKLIST.md` | `quality-gate.yml` (reusable) |
| Provision envs/secrets/variables | `PROVISIONING_RUNBOOK.md` | (owner procedures, no automation) |

## Carried-forward knowledge (still relevant, lives in PHP — not lost)

- AI production-gate / release-identity / retention patterns
  (`AI_P2_FINAL_DEPLOYMENT_GATE.md`, `AI_P2_RELEASE_IDENTITY.md`,
  `AI_RETENTION_CRON_SETUP.md`): apply when the AI phase starts.
- n8n ground truth (live relay path, disposable-instance policy, credential
  non-migration, snapshot-vs-live rule): applies when automation work starts;
  n8n itself is deferred (owner decision pending). Tooling `tools/n8n_migrate/`
  + `tools/n8n_archive/` deferred with safety properties intact-but-unmigrated
  (secret guards, HMAC/read guards, archive safety, live-client boundaries) —
  see `QUALITY_GATES.md` pending table; also contractual in
  `OPERATIONAL_CONTRACT.md` §12.
- August-2026 incident lesson (size-heuristic skip → silent security
  staleness): guards must be exact, never heuristic — encoded in the cost
  guard, secret scanner, and smoke checks above.
- TEST-01..26 pin knowledge: live-subject pins are CURRENT TEST DEBT
  (auth/security behaviors exist, pins unported); subject-absent pins are
  phase-bound (mail/UI/AI); TEST-26/NP-5 are N/A (no committed generated
  artifacts) — see the `QUALITY_GATES.md` pending table for the split.
- Historical records, adapted-dropped (not migrated, not needed live):
  `docs/pdf/` snapshots (Roadmap/Security/Structure) and
  `docs/SESSION_STATE.json` / `docs/PROJECT_STATE.json` handoffs.
  Point-in-time records; Modern live state comes from git + `npm run ops:status`.
- RB-4 document-vs-baseline comparison: NOT TRANSFERRED (no Modern doc-drift
  comparator; the structure guard covers code boundaries only) — minor and
  explicit; re-add if doc drift becomes a release risk.
- `velora-status.sh` `--check`/`--context` modes: NOT TRANSFERRED
  (`ops-status` covers snapshot + JSON output; fail-closed freshness
  validation and session-context generation have no Modern equivalent) —
  explicit.
