# Velora Modern — Backup + Release Gate

Implements **ADR-012 Amendment A** (owner decision, 2026-09-16).

```
create → verify → official storage → verify storage → evidence → GATE → deploy
```

## Files

| File | Role |
|---|---|
| `backup_gate.py` | Unified, **target-independent** gate. Pure logic, no I/O, no platform coupling. |
| `retention.py` | `(environment × backup_type)` retention chains + fail-closed deletion safety. |
| `create_pg_backup.sh` | PostgreSQL producer: `pg_dump` → `gzip -t` → sha256 → evidence. |
| `sample_e2e.py` | Offline structural proof of the whole chain. |
| `tests/` | 42 tests covering all 22 mandated cases. |

## Provenance — what was reused vs adapted

**Reused verbatim** from `veloratrade/veloratrade :: ops/velora-mgmt/backup_gate.py`:
the six-field evidence contract (`backup_id`, `release_tag`, `sha256`,
`source_commit_sha`, `verification_status`, `environment`), the
`db-backup-<env>-` namespace, and fail-closed semantics with no skip/force path.

**Adapted, with reasons:**

- *Producer* — the Reference uses MySQL via a one-use PHP probe over FTP into a
  cPanel docroot. Modern is PostgreSQL on a container platform, and contacting
  the legacy host is prohibited. Only the producer changed; the contract did not.
- *Retention* — the Reference expires a backup relative to **its own** creation.
  The owner's law expires it **14 days after the successor's successful storage**.
  These are genuinely different rules, so `retention.py` is new logic.
- *Storage verification* — the Reference treats `release_tag` as proof of
  storage. Here `storage_status == STORAGE_VERIFIED` is a separate required
  field: *uploaded is not verified*.
- *`backup_type`* — the law is scoped per chain, so the gate must know which
  chain evidence belongs to.

## Retention law

Newest verified+stored backup of each chain: **protected indefinitely**.
Each predecessor expires **14 days after its successor's `stored_at`** — never
recomputed when a later backup arrives.

```
A stored day 0             → protected
B stored day 5  → A expires day 19
C stored day 12 → B expires day 26,  A still day 19
```

Chains are independent: `staging×database`, `staging×persistent_files`,
`production×database`, `production×persistent_files`.

## Deletion safety

Expiry alone never authorises deletion. All seven must hold: not the chain head ·
successor exists in the same chain · successor still present · still
`INTEGRITY_VERIFIED` · still storage-verified · window genuinely expired ·
candidate is exactly the intended backup. A chain is never left empty.

## `persistent_files` = NOT_APPLICABLE

Audited 2026-09-16: the only Railway volume is `postgres-volume`, the API
performs no filesystem writes, and no storage adapter exists. The chain is
declared inapplicable rather than reported as a fake success. This can **never**
excuse a missing database backup — enforced by test `test_22b`.

## Usage

```bash
DATABASE_URL=… ENVIRONMENT=staging SOURCE_COMMIT_SHA=$(git rev-parse HEAD) \
  bash ops/backup/create_pg_backup.sh ./backup-artifacts
# then upload to veloratrade/velora-backups and set storage_status=STORAGE_VERIFIED

EXPECTED_ENV=staging \
EXPECTED_COMMIT_SHA=$(git rev-parse HEAD) \
INAPPLICABLE_BACKUP_TYPES=persistent_files \
BACKUP_EVIDENCE_FILE=evidence.json \
  python3 ops/backup/backup_gate.py      # exit 0 = PASS, 1 = BLOCK
```

## Not yet wired — see ADR-012 A.6

Modern deploys via **Railway GitHub triggers**, which do not wait for CI
(`checkSuites=false`). There is currently no job graph in which this gate can
block a deploy. Making it a real blocking dependency needs a deployment-control
decision. Until then the gate is enforceable for manually invoked operations,
and any covered automatic mutation is **BLOCKED — no verified backup gate**.

**Never commit dump bytes.** `.gitignore` blocks `*.dump`, `*.dump.gz`,
`*.sql.gz`, `backup-artifacts/`, `backups/`.
