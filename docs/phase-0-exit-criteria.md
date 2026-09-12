# VELORA-MODERN — Phase 0 Exit Criteria

Phase 1 (any application code) begins only after every mandatory gate is PASS.
**Never manufacture a PASS** — missing evidence = BLOCKED; owner-owned choices =
OWNER DECISION REQUIRED.

## Owner decision record (2026-08-29)

| ID | Decision | Record |
|---|---|---|
| D-01 | ADR-002 trade ledger | **Accepted — Option B** (immutable ledger, correction events, tombstones, explicit ownership, optimistic concurrency, idempotent external IDs). Not implemented yet. |
| D-02 | ADR-003 email canonicalization | **Accepted — policy (a)** (lowercase at every write, plain UNIQUE, mandatory pre-migration duplicate scan, case-collisions resolved before import). PHP DB untouched. |
| D-03 | ADR-001 rounding | **Accepted — half-even** for new currency computations; bcmath-equivalent parity for historical recomputation; decimal-only; golden vectors mandatory. |
| D-04 | ADR-005 Argon2id | **Accepted — m=19456 KiB, t=2, p=1**; rehash-on-login; change/reset → Argon2id; bcrypt `$2y$` proof = Phase 1 gate. |
| D-05 | ADR-008 webhook tolerance | **Accepted — ±5 minutes**, configurable per source. |
| D-06 | Repository visibility | **REVISED — KEEP `velora-modern` PUBLIC** (owner decision, 2026-08-29). Public visibility is intentional and owner-approved — not a blocker. Agent does not change visibility. Secret-safety scan (2026-08-29): zero findings; a pre-push secret-safety scan remains a standing gate before every push. Push still requires explicit owner authorization. |
| D-07 | Parity target date | **Accepted — 2027-03-31** (owner decision, recorded verbatim; not reinterpreted, extended, or changed). |
| D-08 | Kill criterion | **Accepted** (text below). |
| D-09 | Hosting validation | **AUTHORIZED** — evidence gathering only; no infrastructure provisioning/modification. Status stays BLOCKED until evidence complete. |
| D-10 | Phase 1 | **AUTHORIZED (2026-08-31) — Architecture Foundation only, dev/staging environment only.** Production deployment/cutover remains gated by Gate 3B + Phase 4 rehearsal. Implementation record: `docs/adr/ADR-011-phase1-implementation-record.md`. |
| D-11 | ADR-004 time model | **Accepted** (2026-08-29) — timestamptz/UTC, dual-column trading timestamps, sampling procedure. Legacy-TZ interpretation remains evidence-gated (not part of approval; no timezone value recorded). |
| D-12 | ADR-006 contract tiering | **Accepted** (2026-08-29) — two-tier model + frozen external list; C-11 verification Phase 1; C-15 added as unfrozen candidate. |
| D-13 | ADR-007 job semantics | **Accepted** (2026-08-29) — pg-boss + job standard + four Redis triggers. |
| D-14 | ADR-009 SEO/locale | **Accepted** (2026-08-29) — route map, locale strategy, cache classes, CSP nonces; **checkout URL = `/fa/checkout` + `/en/checkout`** (F-03). hreflang verification Phase 2. |
| D-15 | ADR-010 delivery/repo | **Accepted as policy** (2026-08-29) — monorepo, immutable images, roles, restore-drill gate. Repository posture per **revised D-06: PUBLIC** (original PRIVATE proposal superseded by owner decision). |
| D-16 | ADR-012 backup gate law | **Accepted** (2026-09-12, owner directive — post-audit governance alignment) — permanent mutation-safety invariant: no staging/production mutation affecting persistent state without a valid, environment-attributed, `INTEGRITY_VERIFIED` backup gate evaluated for that exact operation before the mutation. Fail-closed; no bypass; no manual-confirmation exception; mechanism deferred to a future implementation decision. |
| D-17 | ADR-013 environment-origin safety | **Accepted** (2026-09-12, owner directive) — explicit environment identity + canonical origin binding contract, implemented as a typed validator in `packages/contracts`; canonical staging origin was **OWNER DECISION REQUIRED (ADR-013 OD-1)** — reconciliation OD-8 (2026-09-12) now approves `https://staging.veloratrade.ir` **as a candidate only**, not a production host. |

## Reconciliation gate — owner decisions OD-1…OD-10 (2026-09-12)

Full record: `docs/reconciliation/RECONCILIATION_DECISIONS.md` (owner-approved 2026-09-12; scope authorized: A0 + A-Preparation only).

| OD | Subject | Disposition |
|---|---|---|
| OD-1 | Reconciliation strategy | **APPROVED — Foundation-First Hybrid** (Local = foundation; Remote = ported feature lineage; PHP = behavioral/visual reference) |
| OD-2 | Remote lineage preservation | **APPROVED** — fetch + annotated tag `remote-snapshot-99e024c829db` + provenance manifest; NO import tree, NO history rewrite |
| OD-3 | External API/health contract | **APPROVED** — PHP `/health` = reference contract; fixture-first; no invented fields |
| OD-4 | Backup bootstrap exception | **NOT APPROVED** — investigate empty-schema dump evidence instead; no ADR-012 change |
| OD-5 | Timestamp precision | **APPROVED** — PG-native storage; UTC; PHP-parity serialization (seconds + `+00:00`) pending fixtures |
| OD-6 | ORM | **OPEN** — Phase D spike against defined criteria |
| OD-7 | Queue | **APPROVED — pg-boss** (ADR-007); no BullMQ; Redis conditional only |
| OD-8 | Staging origin | **APPROVED AS CANDIDATE ONLY** — `https://staging.veloratrade.ir`; not a production host |
| OD-9 | Ledger enforcement | **APPROVED DIRECTION** — staged: soft-launch/observability → verified → strict |
| OD-10 | Future promotion | **APPROVED FUTURE PROCESS ONLY** — branch + owner-reviewed PR/fast-forward; never reset/rewrite/force-push |

## Mandatory gates (recalculated 2026-08-29)

| Gate | Requirement | Status | Evidence |
|---|---|---|---|
| 1 — Repository visibility | Visibility decision recorded (intentional posture) + pre-push secret-safety scan | **PASS** | Intentionally **PUBLIC** by owner decision D-06 (revised 2026-08-29); public-repo safety scan 2026-08-29: zero sensitive findings |
| 2 — Ten ADRs reviewed | All reviewed + business decisions approved | **PASS (10/10)** | Accepted: ADR-001, 002, 003, 005, 008 (D-01…D-05) + ADR-004, 006, 007, 009, 010 (D-11…D-15), all 2026-08-29. Evidence-gated sub-items (ADR-004 legacy TZ, ADR-009 hreflang) tracked inside their ADRs — not owner guesses |
| 2a — Trade policy | ADR-002 approved | **PASS** | D-01 (Option B), 2026-08-29 |
| 2b — Email policy | ADR-003 approved | **PASS** | D-02 (policy a), 2026-08-29 |
| 3A — Development/Staging Foundation | Phase 1 foundation work requires only a clearly identified **non-production** dev/staging environment | **PASS (policy gate)** | Owner governance correction 2026-08-31: production hosting is NOT a prerequisite for Phase 1 Architecture Foundation. Dev/staging environment is created within Phase 1 (local/temporary non-production infra) and must never be represented as production evidence |
| 3B — Production Hosting Validation | 20-row **production** checklist fully evidenced **from a candidate production host** | **BLOCKED — NOT YET APPLICABLE** | 0/20 rows evidenced; **no production host currently exists** (planning/infrastructure decision, not a failed validation). Attempt 2026-08-31 stopped pre-execution — see `docs/evidence/BLOCKED-REPORT-2026-08-31.md`. Gates ONLY production deployment/cutover/readiness — never Phase 1 |
| 4 — Parity date | Concrete owner-committed date | **PASS** | D-07 = **2027-03-31** (owner decision, recorded verbatim) |
| 5 — Kill criterion | Written stall-termination condition | **PASS** | D-08 accepted 2026-08-29 (text below) |
| — Production deployment / cutover / readiness | Real production hosting validated + migration rehearsal + explicit owner Go | **BLOCKED** | Requires Gate 3B PASS (20/20) + Phase 4 rehearsal per `docs/migration-strategy.md`; no production host exists yet |
| — Phase 1 authorization | Explicit owner authorization (D-10) | **AUTHORIZED (2026-08-31)** — Architecture Foundation, dev/staging only | D-10 recorded; foundation implemented + verified (ADR-011 test evidence); production track unchanged |

## Kill criterion (ACCEPTED — owner decision D-08, 2026-08-29)

> If, for 8 consecutive weeks, fewer than 50% of planned weekly parity increments
> complete, or the parity target date slips by more than one quarter without a
> formally recorded revision, the modernization effort is halted or reset with
> a written review.

## Remaining to unlock Phase 1

~~Owner: explicit Phase 1 authorization (D-10)~~ — **D-10 GRANTED 2026-08-31**
(Architecture Foundation, dev/staging only). Phase 1 foundation implemented and
verified — see `docs/adr/ADR-011-phase1-implementation-record.md` for evidence
and the explicit BLOCKED items (compose startup, pg-boss live run, CI
execution, restore drill — all environment-gated, none fabricated).

## Production track (separate from Phase 1 start)

```
Phase 0 Governance (ADRs / policies / parity date)   — DONE
        ↓
Phase 1 Architecture Foundation (dev/staging only)   — awaiting D-10
  (repo/package structure, domain boundaries, contracts, DB foundation,
   auth foundation, observability, testing, CI/CD, local/dev/staging env)
        ↓
Production capacity / hosting decision               — owner, future
        ↓
Candidate production host identified + access
        ↓
Gate 3B: 20/20 Production Hosting Validation (docs/hosting-validation.md)
        ↓
Production Readiness (security gates, load tests, rehearsal)
        ↓
Migration / Cutover (docs/migration-strategy.md)
```

**Production-host status (2026-08-31):** «No production host currently exists for
`velora-modern`. This is a planning/infrastructure decision, not a failed
validation result.» Gate 3B stays BLOCKED until a real candidate production host
exists; dev/staging evidence must never be counted as production evidence.

Push of the Phase 0 commits is permitted only on explicit owner authorization;
the repository's public posture (D-06) allows it at any time, and the standing
pre-push secret-safety scan must be re-run before every push.

## Supporting exit items (complete)

Capability registry v1 (28 rows) · external contracts (14 frozen + C-15 candidate) · threat model (30 rows)
· security policy + production gates · migration strategy (rows+bytes rule)
· parity plan · observability contract · governance contract (`AGENTS.md`).
