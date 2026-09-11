# Backup Policy — Law, Evidence Contract, Deferral Boundary

Modern-native successor to `ops/velora-mgmt/*.md` (README/BACKUP_POLICY/
PRIVATE_REPO/ROLLBACK/SECURITY). The LAW and the EVIDENCE CONTRACT are fully
ported and enforced. Backup EXECUTION for Railway Postgres is deferred to the
final database phase — this document states exactly what exists today and what
the final phase must add, with no silent gaps.

## 1. The law (enforced today)

No deploy or data migration proceeds without successfully created AND verified
backup evidence, validated by `npm run backup:evidence:check` via the reusable
`backup-evidence-gate.yml` workflow. No skip flag exists.

## 2. Evidence contract (unchanged from PHP)

| Field | Rule |
|---|---|
| `BACKUP_ID` | Non-empty, prefixed `db-backup-<env>-` (namespace = target env) |
| `RELEASE_TAG` | Non-empty; on production MUST equal `BACKUP_ID` and carry the `db-backup-production-` prefix (D5 binding, enforced) |
| `SHA256` | Lowercase 64-hex digest of the verified dump |
| `SOURCE_COMMIT_SHA` | Valid git SHA (7–64 hex) the backup was taken for; MUST equal the deployment commit SHA in CI (D5 binding, wired to `github.sha`) |
| `VERIFICATION_STATUS` | Exactly `INTEGRITY_VERIFIED` |
| `ENVIRONMENT` | Exactly the expected target environment |

Evidence identifiers are non-secret by design and safe in reports/artifacts.

## 3. Verification ladder (target state; producer deferred)

`CREATED → INTEGRITY_VERIFIED (sha/size re-read) → RESTORE_TESTED (periodic)`.
Only `INTEGRITY_VERIFIED` (or stronger, once defined) satisfies the gate.
The ladder state machine, lifecycle orchestration, retention automation, and
private-store client are final-phase deliverables — the CONTRACT above is what
they must emit.

## 4. Bootstrap path (empty-target attestation)

Until backup evidence exists, deploy workflows accept the exact phrase
`EMPTY-TARGET-BOOTSTRAP` INSTEAD OF evidence (XOR enforced), attesting the
target provably holds no data. Rules:

- Allowed ONLY against empty targets (today: both envs, 0 deploys, no data).
- Recorded loudly in every deployment report (`backup_path: bootstrap`).
- MUST NOT be used against a data-bearing target — doing so violates the
  Operational Contract §4.
- Disappears from procedure once evidence exists (the XOR keeps both paths
  honest in the meantime).

## 5. Retention (policy stated; automation deferred)

- Newest verified backup is immortal (never deleted by retention).
- Retention deletes nothing unless the release fully succeeded.
- Retention runs are explicit, logged, and reversible within the store's own
  history. Automation + store choice (owner decision) arrive with the final phase.

## 6. What the final database phase must add (no silent gaps)

1. Backup producer (Railway Postgres → verified dump + evidence emission).
2. Offsite store (+ owner store decision) and byte re-verification.
3. Lifecycle orchestrator + retention automation + restore rehearsal.
4. Migration-time backup binding (every migration run gated like deploys).
5. Independent store re-read for deploy binding (release existence, asset
   presence, metadata cross-check against the private store). The gate's
   commit/tag checks verify the CLAIM only, never the store — that
   verification is what this item adds.
