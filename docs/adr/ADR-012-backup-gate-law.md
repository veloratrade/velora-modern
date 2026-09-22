# ADR-012 — Backup Gate: Permanent Mutation-Safety Law

## Status

**Accepted — owner decision D-16 (2026-09-12), via post-audit governance-alignment directive.**
This is a **release/operational safety LAW**, not a recommendation and not a
design preference. It binds all future implementation work; implementations
must satisfy it, never loosen it.

Adopted from the Reference repository's permanent law
(`veloratrade/veloratrade` `AGENTS.md` §14, enacted 2026-09-09, and
`ops/velora-mgmt/backup_gate.py` @ `a8eabac`). The **law and evidence
semantics** are ported; the **mechanism is not** (PHP/cPanel one-use probes and
FTP retrieval are Reference-specific — see "Future implementation boundary").

## Context

The cross-repository capability audit (2026-09-12, finding RM-1/P0) found:

- The Reference discovered (BACKUP_POLICY.md, 2026-09) that its production
  backups were file-only, `CREATED` but never `INTEGRITY_VERIFIED`, with **no
  database backup mechanism at all** — and responded by enacting a permanent
  backup-gate law on 2026-09-09.
- Modern's governance snapshot (D-10, 2026-08-31) **predates** that law and
  contains nothing equivalent. Modern has backup/restore *interfaces*
  (`infra/backup/{backup.sh,restore.sh,DR-RUNBOOK.md}` — authored, execution
  sandbox-blocked) but no gate concept in governance, tooling, or CI.

Modern is pre-staging, so there is no violation today — but the invariant must
exist **before** the first operational mutation, not after.

## Verified Evidence

- Reference law text and separation rule: `AGENTS.md` §14 @ `a8eabac`
  — "BACKUP MECHANISM EXISTS ≠ BACKUP WAS SUCCESSFULLY CREATED FOR THIS
  OPERATION"; no skip/ignore/force flags exist.
- Reference evidence schema (six machine-verifiable fields):
  `ops/velora-mgmt/backup_gate.py` — `backup_id` (prefix
  `db-backup-<environment>-`), `release_tag`, `sha256` (64-hex),
  `source_commit_sha`, `verification_status == INTEGRITY_VERIFIED`,
  `environment` (exact target).
- Reference consumers: `deploy-staging.yml`, `app-schema-migration-staging.yml`
  (v1.7/v1.8 allowlist + `APPLY-APP-SCHEMA-MIGRATION` confirmation phrase),
  `velora-db-backup{,-staging}.yml`.
- Modern gap: PROVEN ABSENT by full-tree enumeration @ `e75b575` (audit §10
  row 8) — no gate law, validator, or CI wiring.

## Decision — the law

> **No staging or production mutation that can affect persistent application
> state may proceed unless a valid backup gate — evaluated for that exact
> operation, against that exact target and environment — has passed
> immediately before the mutation.**

1. **Backup completes BEFORE the mutation begins.** A backup started
   alongside, or after, the mutation satisfies nothing.
2. **The gate fails closed.** Missing, stale, invalid, or unverifiable
   evidence blocks the mutation. Absence of a validator is not absence of the
   law: until the mechanism exists, the only compliant outcome for a covered
   mutation is **BLOCKED — no verified backup gate**.
3. **No bypass.** No skip/force/ignore flags. "Operator confirms manually" is
   not evidence. "A backup mechanism exists" is not evidence that a backup was
   created for this operation.
4. **No emergency bypass exists today.** Only a future explicit owner decision
   (a new ADR or a revision of this one) may define one, and it must preserve
   a full audit record.
5. **Attribution is exact.** Evidence binds to the specific target and
   environment. A staging backup never authorizes a production mutation, and
   vice versa. Dev/staging evidence never counts as production evidence (D-09).

### Scope — covered mutations

- Schema or data migrations, backfills, and any write to staging/production
  databases or durable stores (including `db/migrate.ts` when pointed at a
  non-disposable environment).
- Deploys/releases that change the code serving staging or production.
- Configuration or credential changes that alter persistent state or its
  interpretation (including rotations that invalidate access to state).

### Explicitly NOT covered

- Local development and disposable/test engines (PGlite, ephemeral containers).
- Read-only operations (inspect, plan, parity probes, health checks).
- Repository-only changes (docs/code commits) that are not deployed.
- Anything production-side today: Gate 3B remains BLOCKED 0/20; no production
  operation of any kind is authorized regardless of backups.

## Evidence contract

Every gate evaluation consumes a record with, at minimum:

| Field | Requirement |
|---|---|
| `environment` | Exactly `staging` or `production`, and exactly the operation's target environment |
| `target identity` | The specific persistent-state instance (database/cluster/service) the backup covers |
| `backup_id` | Non-empty, unique, namespaced by environment (prefix `db-backup-<environment>-` — convention adopted from Reference) |
| `created_at` | Backup creation timestamp; must be fresh for this operation (max-age policy fixed at mechanism time — see boundary below) |
| `artifact reference` | Where the backup artifact lives; MUST be outside the application source tree and never in this public repository (D-06) |
| `integrity` | SHA-256 (lowercase 64-hex) of the backup artifact |
| `verification_status` | At minimum `INTEGRITY_VERIFIED` (checksum-verified). `RESTORE_VERIFIED` is stronger and required once restore drills exist. `CREATED` alone is **not** sufficient |
| `source state binding` | Commit SHA (or equivalent state identity) the environment was on when the backup was taken |
| `operation binding` | Identity of the mutation request the gate is evaluated for, where the operation carries one |

Separation rule (verbatim from the Reference law):

```
BACKUP MECHANISM EXISTS ≠ BACKUP WAS SUCCESSFULLY CREATED FOR THIS OPERATION
```

## Consumer responsibility

Any agent, workflow, script, or human procedure executing a covered mutation
MUST:

1. Evaluate the gate against the evidence contract **before** mutating.
2. Record the evidence and the verdict in the operation log.
3. Stop and report on any missing/invalid item — reporting a block is always
   correct; silently proceeding never is.

Known future consumers: deploy pipelines (ADR-010 image delivery),
staging/production migration tooling, Phase 2+ operational workflows, and any
agent session performing a covered operation.

## Failure behavior

Block + machine-readable list of failed evidence items. No partial pass, no
warning-only mode for covered mutations, no default-to-allowed under any
configuration error.

## Future implementation boundary — deliberately NOT in this ADR

This ADR enacts the **law and evidence contract only**. Mechanism is future
work under a separate owner decision: backup creation (e.g. `pg_dump`),
artifact storage (the Reference uses a private GitHub repository's Release
assets — a pattern to re-evaluate, not inherit), a gate validator module, CI/CD
wiring, restore drills (interface already staged in
`infra/backup/DR-RUNBOOK.md`), and the freshness max-age policy. That work:

- MUST implement this contract as a blocking precondition (review criterion).
- MUST fail closed per-field, with tests covering every failure mode.
- Adds no schema today: this ADR authorizes **no database tables or changes**.

## Amendment A — retention law and mechanism (owner decision, 2026-09-16)

**Status: Accepted.** The original ADR deferred *mechanism* to "a separate owner
decision" (see "Future implementation boundary"). That decision has now been
made by the owner and is recorded here, in the same change that implements it,
per AGENTS.md Rule 11. The law in the body above is **unchanged and not
weakened** — this amendment only fills the deliberately-empty mechanism slot and
adds the retention rule the original ADR did not specify.

### A.1 Retention law (new — the ADR previously had none)

Scope is **independent per `(environment × backup_type)`** chain — i.e.
`staging×database`, `staging×persistent_files`, `production×database`,
`production×persistent_files`.

> The newest successfully verified and officially stored backup of each chain is
> **protected indefinitely**. When a newer backup of the same chain is
> (1) created, (2) integrity-verified, (3) officially stored and
> (4) storage-verified, the immediately previous backup enters a **14-day**
> retention window measured **from the successor's successful storage time** —
> not from the predecessor's own creation time.

Worked example (normative): A stored day 0 → protected. B stored day 5 → A
expires day 19. C stored day 12 → B expires day 26, **and A still expires day
19** (an existing expiry is never recomputed).

A database backup never advances a `persistent_files` chain, and a staging
backup never affects production retention.

### A.2 Deletion safety

Timer expiry alone NEVER authorises deletion. All seven conditions must hold:
the candidate is not the chain head; a successor exists in the *same* chain; the
successor is still present; still `INTEGRITY_VERIFIED`; still storage-verified;
the window has genuinely expired; and the candidate is exactly the intended
backup. Deletion must never leave a chain with zero valid backups.

### A.3 Mechanism (fills the deferred slot)

| Slot | Decision |
|---|---|
| Producer | `pg_dump` (PostgreSQL) — the Reference's MySQL/PHP/FTP/cPanel producer is **not** portable and is explicitly NOT adopted |
| Storage | **Reuse** the existing private `veloratrade/velora-backups` (Release assets + `backups/<env>/` metadata) — no new repository |
| Validator | `ops/backup/backup_gate.py` — the Reference six-field contract adopted **verbatim**, extended with `backup_type`, `storage_status`, and `NOT_APPLICABLE` |
| Retention | `ops/backup/retention.py` |
| Freshness | Enforced when `MAX_BACKUP_AGE_SECONDS` is supplied; no default is invented here |

### A.4 `NOT_APPLICABLE` — bounded, non-bypass

Modern currently has **no persistent runtime files** (audited 2026-09-16: the
only Railway volume is `postgres-volume`, the API performs no filesystem writes,
and no storage adapter is implemented). The `persistent_files` chain is
therefore `NOT_APPLICABLE` rather than falsely reported as successful. This is
**not** a bypass: `NOT_APPLICABLE` is accepted only for a type explicitly
declared inapplicable for that target, and can never excuse a missing database
backup (enforced, with a dedicated test). If persistent files are introduced
later, the declaration must be removed and a real file backup implemented.

### A.5 What this amendment does NOT do

It does not weaken fail-closed behaviour, add any skip/force/ignore path, change
the evidence contract's required fields, or authorise any production operation.
Deployment wiring remains outstanding — see "Remaining boundary" below.

### A.6 Remaining boundary (still an owner decision)

Modern deploys via **Railway GitHub triggers**, not GitHub Actions, and those
triggers do not wait for CI (`checkSuites=false`). There is consequently **no
job graph in which this gate can currently block a deploy**. Making the gate a
real blocking dependency requires choosing a deployment-control model (move
deploys into Actions, or adopt a platform-native pre-deploy check). Until that
is decided, the gate is enforceable for *manually invoked* operations only, and
the compliant outcome for any covered automatic mutation remains
**BLOCKED — no verified backup gate**.

## Acceptance criteria

- [x] This ADR + decision-ledger entry D-16 exist (this change).
- [x] AGENTS.md carries the law as a non-negotiable rule pointing here.
- [ ] Any future mutation mechanism references this ADR in its design and
      implements the gate as a blocking precondition (review gate).
- [x] When implemented, the validator fails closed on each missing/invalid
      field, with per-field tests (mechanism acceptance) — `ops/backup/`,
      42 tests, Amendment A.
- [x] Retention law specified and implemented per chain (Amendment A.1/A.2).
- [ ] Gate wired as a blocking dependency of deployment — **BLOCKED** on the
      deployment-control decision in A.6.

## Audit trail

- Reference: `AGENTS.md` §14 (2026-09-09), `ops/velora-mgmt/backup_gate.py`,
  `BACKUP_POLICY.md` @ `a8eabac` (2026-09-12).
- Cross-repository audit 2026-09-12: RM-1 (P0), dependency chain §16.
- Owner directive: governance-alignment task 2026-09-12 → decision D-16.
