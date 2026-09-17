# ADR-012 — Backup Gate: Permanent Mutation-Safety Law

## Status

**Accepted — owner decision D-16 (2026-09-12), via post-audit governance-alignment
directive. Promoted to `main` as governance documentation on 2026-09-17.**

This is a **release/operational safety LAW**, not a recommendation and not a design
preference. It binds all future implementation work; implementations must satisfy it,
never loosen it.

The law and evidence semantics were adopted from the **Reference repository:
`veloratrade/veloratrade`** (legacy PHP platform) **[REFERENCE REPOSITORY]** — its
`AGENTS.md` §14, enacted 2026-09-09, and its
`ops/velora-mgmt/backup_gate.py` @ `a8eabac`. The **mechanism is not**
adopted: the Reference's PHP/cPanel one-use probes, MySQL producer and FTP retrieval are
Reference-specific. See "Future implementation boundary".

> **Path convention used in this document.** Every repository path below is labelled:
> **[CURRENT MAIN]** = exists on `main` today · **[REFERENCE REPOSITORY]** = lives in
> `veloratrade/veloratrade`, never in Modern · **[HISTORICAL SOURCE]** = existed in the
> `reconcile/foundation-first` line or a historical audit, and is **not** a current
> `main` path. No unlabelled repository path appears in this ADR.

## Context

The cross-repository capability audit (2026-09-12, finding RM-1/P0) found:

- The **[REFERENCE REPOSITORY]** `veloratrade/veloratrade` discovered (its
  `BACKUP_POLICY.md`, 2026-09) that production backups were file-only, `CREATED` but
  never `INTEGRITY_VERIFIED`, with **no database backup mechanism at all** — and
  responded by enacting a permanent backup-gate law on 2026-09-09.
- Modern's governance snapshot (D-10, 2026-08-31) **predated** that law and contained
  nothing equivalent.

Modern was pre-staging when this ADR was first written, so there was no violation at the
time — but the invariant had to exist **before** the first operational mutation, not
after.

### Current state of `main` (updated 2026-09-17, after PR #3)

The original Context stated that Modern had "no gate concept in governance, tooling, or
CI". **That statement is now out of date and is corrected here.** As of `main`
@ `c9043445d35865af08d364c09c121f002e24b777`:

| Artifact | State |
|---|---|
| `ops/backup/backup_gate.py` **[CURRENT MAIN]** | Exists — unified, target-independent validator (stdlib-only) |
| `ops/backup/tests/test_backup_system.py` **[CURRENT MAIN]** | Exists — 42 gate tests |
| `.github/workflows/backup-gate.yml` **[CURRENT MAIN]** | Exists — reusable, **`workflow_call` only**, `permissions: contents: read`, no schedule, no `continue-on-error` |
| `ops/backup/retention.py` **[CURRENT MAIN]** | Exists — 14-day retention law |
| `ops/backup/reap_retention.py`, `ops/backup/upload_backup.py` **[CURRENT MAIN]** | Exist |
| `.github/workflows/backup-retention.yml` **[CURRENT MAIN]** | Exists — weekly maintenance (QG-14 allowlisted) |
| `docs/ops/BACKUP_POLICY.md` **[CURRENT MAIN]** | Exists — policy, evidence contract, deferral boundary |
| `.github/workflows/backup-evidence-gate.yml` **[CURRENT MAIN]** | Exists — earlier evidence gate (see "Known divergence") |

**Therefore the generic gate now EXISTS but is currently INERT:** no workflow on `main`
invokes `.github/workflows/backup-gate.yml`, so it participates in no job graph today. It
becomes effective only when an approved caller invokes it. A backup **producer** is not
yet authorized (see "Future implementation boundary").

## Verified evidence

- **[REFERENCE REPOSITORY]** law text and separation rule: `veloratrade/veloratrade`
  `AGENTS.md` §14 @ `a8eabac` — "BACKUP MECHANISM EXISTS ≠ BACKUP WAS SUCCESSFULLY
  CREATED FOR THIS OPERATION"; no skip/ignore/force flags exist.
- **[REFERENCE REPOSITORY]** evidence schema (six machine-verifiable fields):
  `veloratrade/veloratrade` `ops/velora-mgmt/backup_gate.py` — `backup_id` (prefix
  `db-backup-<environment>-`), `release_tag`, `sha256` (64-hex), `source_commit_sha`,
  `verification_status == INTEGRITY_VERIFIED`, `environment` (exact target).
- **[REFERENCE REPOSITORY]** consumers of that law: the legacy deploy and
  schema-migration workflows plus the legacy database-backup workflows, all in
  `veloratrade/veloratrade`. These are cited as provenance only; **no Modern workflow is
  derived from them, and the legacy repository is not modified by this ADR.**
- **[CURRENT MAIN]** Modern implementation of the law: `ops/backup/backup_gate.py` with
  `ops/backup/tests/test_backup_system.py`, transported by
  `.github/workflows/backup-gate.yml`.

> **[REMOVED] during promotion.** The reconcile-era text cited four paths as Modern
> artifacts — an `infra/backup/` directory (a backup script, a restore script and a
> DR runbook) and a `db/` TypeScript migration runner. **[REMOVED]** — none of those
> paths exist on `main`, so the citations were deleted rather than replaced, and no
> substitute paths were invented. Restore drills and migration-runner integration are
> future work with no current `main` artifact.

## Decision — the law

> **No staging or production mutation that can affect persistent application state may
> proceed unless a valid backup gate — evaluated for that exact operation, against that
> exact target and environment — has passed immediately before the mutation.**

1. **Backup completes BEFORE the mutation begins.** A backup started alongside, or after,
   the mutation satisfies nothing.
2. **The gate fails closed.** Missing, stale, invalid, or unverifiable evidence blocks the
   mutation. Absence of a validator is not absence of the law: until a mechanism exists
   for a given operation, the only compliant outcome for a covered mutation is
   **BLOCKED — no verified backup gate**.
3. **No bypass in the generic gate.** The generic gate defined by this ADR
   (`ops/backup/backup_gate.py` **[CURRENT MAIN]**, transported by
   `.github/workflows/backup-gate.yml` **[CURRENT MAIN]**) contains no skip, force, or
   ignore path, and no bootstrap path. "Operator confirms manually" is not evidence.
   "A backup mechanism exists" is not evidence that a backup was created for this
   operation. For the separate, pre-existing empty-target attestation in the earlier
   evidence gate, see **"Known divergence / open governance issue"** below — this ADR
   neither authorizes nor expands it.
4. **No emergency bypass is created by this ADR.** Only an explicit owner decision (a new
   ADR or a revision of this one) may define one, and it must preserve a full audit record.
5. **Attribution is exact.** Evidence binds to the specific target and environment. A
   staging backup never authorizes a production mutation, and vice versa. Dev/staging
   evidence never counts as production evidence (D-09).

### Scope — covered mutations

- Schema or data migrations, backfills, and any write to staging/production databases or
  durable stores.
- Deploys/releases that change the code serving staging or production.
- Configuration or credential changes that alter persistent state or its interpretation
  (including rotations that invalidate access to state).

### Explicitly NOT covered

- Local development and disposable/test engines (ephemeral containers).
- Read-only operations (inspect, plan, parity probes, health checks).
- Repository-only changes (docs/code commits) that are not deployed — **including this
  ADR promotion itself.**

## Evidence contract

Every gate evaluation consumes a record with, at minimum:

| Field | Requirement |
|---|---|
| `environment` | Exactly `staging` or `production`, and exactly the operation's target environment |
| `target identity` | The specific persistent-state instance (database/cluster/service) the backup covers |
| `backup_id` | Non-empty, unique, namespaced by environment (prefix `db-backup-<environment>-`) |
| `created_at` | Backup creation timestamp |
| `stored_at` | Successful-storage timestamp; required when freshness checking is configured |
| `artifact reference` | Where the backup artifact lives; MUST be outside the application source tree and never in this public repository (D-06) |
| `integrity` | SHA-256 (lowercase 64-hex) of the backup artifact |
| `verification_status` | At minimum `INTEGRITY_VERIFIED` (checksum-verified). `RESTORE_VERIFIED` is stronger and required once restore drills exist. `CREATED` alone is **not** sufficient |
| `storage_status` | Exactly `STORAGE_VERIFIED` for an applicable chain — uploaded is not verified |
| `source state binding` | Commit SHA (or equivalent state identity) the environment was on when the backup was taken |
| `operation binding` | Identity of the mutation request the gate is evaluated for, where the operation carries one |

Separation rule (verbatim from the **[REFERENCE REPOSITORY]** law):

```
BACKUP MECHANISM EXISTS ≠ BACKUP WAS SUCCESSFULLY CREATED FOR THIS OPERATION
```

## Consumer responsibility

Any agent, workflow, script, or human procedure executing a covered mutation MUST:

1. Evaluate the gate against the evidence contract **before** mutating.
2. Record the evidence and the verdict in the operation log.
3. Stop and report on any missing/invalid item — reporting a block is always correct;
   silently proceeding never is.

Future consumers will include deployment and migration tooling and any agent session
performing a covered operation. **No such consumer is wired today** — see "Known
divergence" and A.6.

> **Delivery-model cross-reference.** The reconcile-era text cross-referenced an
> ADR-010 "image delivery" decision. **[HISTORICAL SOURCE]** — that ADR is not present on
> `main` and is **not** imported by this PR. The sentence has been rewritten so this ADR
> does not depend on any ADR file that is absent from current `main`.

## Failure behavior

Block + machine-readable list of failed evidence items. No partial pass, no warning-only
mode for covered mutations, no default-to-allowed under any configuration error.

## Future implementation boundary — deliberately NOT in this ADR

Mechanism beyond the validator is future work under a separate owner decision: backup
creation (a producer), CI/CD wiring, restore drills, and the freshness max-age policy.
That work:

- MUST implement this contract as a blocking precondition (review criterion).
- MUST fail closed per-field, with tests covering every failure mode.
- Adds no schema today: **this ADR authorizes no database tables, no database changes,
  and no database connection configuration.**

## Amendment A — retention law and mechanism (owner decision, 2026-09-16)

**Status: Accepted.** The original ADR deferred *mechanism* to "a separate owner
decision". That decision has been made by the owner and is recorded here. The law in the
body above is **unchanged and not weakened** — this amendment only fills the
deliberately-empty mechanism slot and adds the retention rule the original ADR did not
specify.

### A.1 Retention law

Scope is **independent per `(environment × backup_type)`** chain — i.e.
`staging×database`, `staging×persistent_files`, `production×database`,
`production×persistent_files`.

> The newest successfully verified and officially stored backup of each chain is
> **protected indefinitely**. When a newer backup of the same chain is (1) created,
> (2) integrity-verified, (3) officially stored and (4) storage-verified, the immediately
> previous backup enters a **14-day** retention window measured **from the successor's
> successful storage time** — not from the predecessor's own creation time.

Worked example (normative): A stored day 0 → protected. B stored day 5 → A expires day 19.
C stored day 12 → B expires day 26, **and A still expires day 19** (an existing expiry is
never recomputed).

A database backup never advances a `persistent_files` chain, and a staging backup never
affects production retention.

### A.2 Deletion safety

Timer expiry alone NEVER authorises deletion. All seven conditions must hold: the
candidate is not the chain head; a successor exists in the *same* chain; the successor is
still present; still `INTEGRITY_VERIFIED`; still storage-verified; the window has
genuinely expired; and the candidate is exactly the intended backup. Deletion must never
leave a chain with zero valid backups.

### A.3 Mechanism

| Slot | Decision | Deployment state |
|---|---|---|
| Producer | `pg_dump` (PostgreSQL) — the **[REFERENCE REPOSITORY]** MySQL/PHP/FTP/cPanel producer is **not** portable and is explicitly NOT adopted | **NOT YET DEPLOYED AND NOT YET AUTHORIZED.** No producer script exists on `main`. The backup database target and the operational source of its connection configuration remain an **open owner decision**. This ADR records the *choice of technology only*. |
| Storage | **Reuse** the existing private backup repository (Release assets + per-environment metadata) — no new repository | In use |
| Validator | `ops/backup/backup_gate.py` **[CURRENT MAIN]** — the **[REFERENCE REPOSITORY]** six-field contract adopted **verbatim**, extended with `backup_type`, `storage_status`, and `NOT_APPLICABLE` | Present, inert (no caller) |
| Retention | `ops/backup/retention.py` **[CURRENT MAIN]** | Present and active |
| Freshness | Enforced when `MAX_BACKUP_AGE_SECONDS` is supplied; no default is invented here | Implemented in the validator |

### A.4 `NOT_APPLICABLE` — bounded, non-bypass

Modern currently has **no persistent runtime files** (audited 2026-09-16: no storage
adapter is implemented and the API performs no filesystem writes). The `persistent_files`
chain is therefore `NOT_APPLICABLE` rather than falsely reported as successful. This is
**not** a bypass: `NOT_APPLICABLE` is accepted only for a type explicitly declared
inapplicable for that target, and can never excuse a missing database backup (enforced,
with a dedicated test). If persistent files are introduced later, the declaration must be
removed and a real file backup implemented.

### A.5 What this amendment does NOT do

It does not weaken fail-closed behaviour, add any skip/force/ignore path to the generic
gate, change the evidence contract's required fields, or authorise any production
operation.

### A.6 Remaining boundary (still an owner decision)

Making the gate a real blocking dependency of deployment requires choosing a
deployment-control model. That decision has **not** been made. Consequently there is
**no job graph in which this gate currently blocks a deploy**: the gate is enforceable
for *manually invoked* operations only, and the compliant outcome for any covered
automatic mutation remains **BLOCKED — no verified backup gate**.

## Known divergence / open governance issue — empty-target bootstrap

This section records a factual divergence between this law and a pre-existing mechanism
on `main`. **It is documentation only. This ADR does not authorize, expand, modify, or
remove that mechanism, and no code or workflow is changed by this PR.**

- The **generic Backup Gate law** defined by this ADR is **fail-closed**, with no skip,
  force, ignore, or bootstrap path. This is implemented by
  `ops/backup/backup_gate.py` **[CURRENT MAIN]** and transported by
  `.github/workflows/backup-gate.yml` **[CURRENT MAIN]**.
- Separately, the repository currently contains an **`EMPTY-TARGET-BOOTSTRAP`** path in
  the earlier evidence gate, `.github/workflows/backup-evidence-gate.yml`
  **[CURRENT MAIN]**, documented in `docs/ops/BACKUP_POLICY.md` **[CURRENT MAIN]** §4,
  `docs/governance/OPERATIONAL_CONTRACT.md` **[CURRENT MAIN]** §4, and quality gate QG-17
  in `docs/governance/QUALITY_GATES.md` **[CURRENT MAIN]**.
- That path is limited to an **empty-target attestation**: it is accepted only in place of
  evidence (XOR), only when the target **provably holds no data**, and it is recorded
  loudly in the deployment report.
- **This bootstrap path is NOT part of the new `.github/workflows/backup-gate.yml`
  [CURRENT MAIN] workflow.** The new gate
  has no bootstrap input and no bootstrap branch. The two gates are distinct artifacts.
- **This ADR does not declare the bootstrap path acceptable for a data-bearing target.**
  The attestation's own stated precondition is a provably empty target; whether that
  precondition still holds for any given environment is a question of fact to be
  established at the time of use, not a permission granted here.
- **The governance of the bootstrap path remains an OPEN OWNER DECISION.** Options
  (retire it, narrow it, or re-affirm it with explicit conditions) are out of scope for
  this documentation-only ADR promotion and must be decided separately.
- **No production or staging deployment behavior is changed by this ADR.** No workflow,
  no input, and no gate wiring is added, removed, or altered.

## Acceptance criteria

- [x] This ADR exists on `main` (this change) with decision-ledger reference D-16.
- [x] The validator fails closed on each missing/invalid field, with per-field tests —
      `ops/backup/backup_gate.py` **[CURRENT MAIN]**, 42 tests.
- [x] Retention law specified and implemented per chain (Amendment A.1/A.2) —
      `ops/backup/retention.py` **[CURRENT MAIN]**, `RETENTION_DAYS = 14`.
- [ ] A backup **producer** is authorized and deployed (target database and connection
      configuration are an open owner decision) — **NOT AUTHORIZED**.
- [ ] Gate wired as a blocking dependency of deployment — **BLOCKED** on the
      deployment-control decision in A.6.
- [ ] Bootstrap-path governance resolved — **OPEN**, see "Known divergence".
- [ ] Any future mutation mechanism references this ADR in its design and implements the
      gate as a blocking precondition (review gate).

## Audit trail

- **[REFERENCE REPOSITORY]** `veloratrade/veloratrade`: `AGENTS.md` §14 (2026-09-09),
  `ops/velora-mgmt/backup_gate.py`, `BACKUP_POLICY.md` @ `a8eabac` (2026-09-12).
- Cross-repository audit 2026-09-12: RM-1 (P0).
- Owner directive: governance-alignment task 2026-09-12 → decision D-16.
- Amendment A: owner decision 2026-09-16 (retention law + mechanism).
- **[HISTORICAL SOURCE]** Governance text originated on the `reconcile/foundation-first`
  line @ `ced4e58ff5cc49471aae063d4eef84460aefc604`, adapted for `main` on 2026-09-17:
  stale Modern paths removed, current-main state recorded, Reference-repository citations
  labelled, and the bootstrap divergence documented as open.
