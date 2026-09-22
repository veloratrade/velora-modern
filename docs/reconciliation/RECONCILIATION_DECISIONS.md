# VELORA MODERN — Owner Reconciliation Decisions (OD-1 … OD-10)

**Status:** OWNER-APPROVED 2026-09-12 (explicit owner authorization message, this session).
**Authorized scope of that message:** A0 (governance decision recording) + A-Preparation (lineage preservation) **only**. Nothing else.
**Source proposal:** *Final Reconciliation Gate Report* (2026-09-12). Wherever this record differs from that report's recommendations, **this record is authoritative** — recommendations were not converted to decisions unless the owner approved them below (evidence discipline per gate §16).

---

## OD-1 — Reconciliation Strategy — **APPROVED: Foundation-First Hybrid**

- Local repository remains the architectural foundation.
- Remote implemented features are treated as product/business-logic lineage to be ported selectively.
- PHP remains the behavioral and visual reference.
- Do not discard useful existing business logic.
- Every module must be classified before porting: KEEP / KEEP+HARDEN / PORT / REFACTOR / REDESIGN / REPLACE / NOT IMPLEMENTED.

## OD-2 — Remote Lineage Preservation — **APPROVED**

1. Fetch Remote Git objects.
2. Create an annotated tag: `remote-snapshot-99e024c829db`.
3. Create a provenance manifest recording: remote repository; remote branch; exact remote SHA; fetch date/time; tag name; relationship to the Local foundation.
4. Verify that the Remote snapshot is retrievable from the local Git object database.

**NOT approved:** no `reference/remote-import/` tree; no duplicate Remote source tree; no copying the Remote application into the Local repository; no history rewrite; no rebase; no reset; no force-push. **There must remain one authoritative application tree.**

## OD-3 — External API / Health Contract — **APPROVED**

- Treat the PHP `/health` response as the current external reference contract unless later evidence proves otherwise. Known PHP shape (verified at `api/index.php:43-45` + `Response.php:36-46`, reference @ `a8eabac`):

```json
{
  "status": "success",
  "data": { "status": "ok", "time": "…" },
  "error": null,
  "timestamp": "…"
}
```

- The exact current PHP implementation and fixture evidence must be captured **before freezing** the contract.
- **Do NOT invent `data.checks.database` merely to satisfy the Local specification** (the Local parity spec `parity/specs/health.json` currently expects it — correction is a planned, separately-authorized fixture-first task, NOT yet done).
- Contract reconciliation must be **fixture-first**.

## OD-4 — Backup Bootstrap Exception — **NOT APPROVED**

- Do not modify or weaken the strict backup/restore governance (ADR-012) to create an `EMPTY-TARGET-BOOTSTRAP` exception.
- Instead: investigate and, if technically valid, use an **empty-schema PostgreSQL dump artifact** that satisfies the existing strict governance without creating a special exception.
- **No ADR modification is authorized.**

## OD-5 — Timestamp Precision — **APPROVED**

- PostgreSQL storage uses native timestamp precision appropriate to the target architecture.
- Modern canonical timestamps are UTC.
- External serialization preserves PHP behavioral compatibility where the frozen contract requires it.
- For the currently observed PHP format, use **seconds precision with `+00:00`** unless fixture evidence establishes a different required contract.
- Do not guess legacy timezone conversions.

## OD-6 — ORM — **OPEN / NOT YET DECIDED**

- Do not automatically select Prisma.
- The decision remains open until the Phase D spike compares viable approaches against: PostgreSQL control; Decimal/financial correctness; migrations; transaction semantics; concurrency; locking; idempotency; performance; maintainability; observability; long-term scaling.

## OD-7 — Queue Architecture — **APPROVED**

- Use **pg-boss** as the initial queue architecture per ADR-007.
- Do not introduce BullMQ as the target architecture. Do not introduce Redis as a queue.
- Redis may only be introduced later under ADR-007's explicit conditions (measured throughput requirement; explicitly approved shared multi-node rate-limit use case).

## OD-8 — Staging Origin — **APPROVED AS A CANDIDATE ONLY**

- `https://staging.veloratrade.ir` is a staging-origin **candidate** for parity testing (resolves ADR-013 OD-1 as a candidate — runtime canonicalization still pending owner action at staging time).
- It is **NOT a production host**. No DNS, hosting, deployment, or infrastructure changes.

## OD-9 — Ledger Enforcement — **APPROVED DIRECTION (staged)**

1. Initial soft-launch/observability phase.
2. Verify business rules, correction semantics, idempotency, concurrency, and read-model behavior.
3. Move to strict immutable enforcement at the appropriate verification gate.
4. Do not silently change existing business semantics.

## OD-10 — Future Promotion — **APPROVED FUTURE PROCESS ONLY**

When promotion is eventually authorized: use a branch; open an owner-reviewed PR or approved fast-forward; never reset or rewrite `main`; never force-push. **No promotion to GitHub `main` is authorized now.**

---

## Explicit non-authorizations (from the owner message, 2026-09-12)

Phase B security implementation · Phase C porting · Phase D PostgreSQL conversion · ORM spike · real PostgreSQL migrations · ledger implementation · concurrency implementation · pg-boss implementation · frontend migration · MetaAPI · AI/OCR · email · admin · production infrastructure · Railway changes · DNS changes · deployment · production database access · production credentials · production-readiness claims · production cutover · GitHub `main` modification · merge · force-push · history rewrite · rebase/reset · weakening or changing ADR-012 or other accepted governance · changing external contracts · changing the PHP reference implementation.

## Planned follow-ups arising from these decisions (NOT authorized by this record)

- **Fixture capture** of the exact PHP `/health`, envelope, error, validation, auth, pagination, and rate-limit responses (OD-3) — before any contract freeze or spec correction.
- **Empty-schema backup-producer investigation** (OD-4) — design-level task; no ADR-012 change.
- **Phase D ORM spike** (OD-6) — criteria listed above.
- **ROADMAP BullMQ→pg-boss amendment** (OD-7) — applies to the Remote-lineage roadmap document at reconciliation time.
- **Ledger staged-enforcement design** (OD-9) — Phase E.

## Audit trail

- Final Reconciliation Gate Report: `velora-reconciliation-gate-report.md` (2026-09-12, session artifact) — verdict APPROVED WITH CONDITIONS C1–C6; conditions satisfied by this record.
- Owner authorization message: 2026-09-12 (this session) — full text reflected above; classifications: VERIFIED FACT (PHP shapes), OWNER DECISION (OD-1…OD-10 as labeled).
- Execution commits: on branch `reconcile/foundation-first` (unpushed); Local `main` untouched.
