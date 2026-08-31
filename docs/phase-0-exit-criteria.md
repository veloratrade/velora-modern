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
| D-10 | Phase 1 | **NOT AUTHORIZED** — blocked until all mandatory gates pass. |
| D-11 | ADR-004 time model | **Accepted** (2026-08-29) — timestamptz/UTC, dual-column trading timestamps, sampling procedure. Legacy-TZ interpretation remains evidence-gated (not part of approval; no timezone value recorded). |
| D-12 | ADR-006 contract tiering | **Accepted** (2026-08-29) — two-tier model + frozen external list; C-11 verification Phase 1; C-15 added as unfrozen candidate. |
| D-13 | ADR-007 job semantics | **Accepted** (2026-08-29) — pg-boss + job standard + four Redis triggers. |
| D-14 | ADR-009 SEO/locale | **Accepted** (2026-08-29) — route map, locale strategy, cache classes, CSP nonces; **checkout URL = `/fa/checkout` + `/en/checkout`** (F-03). hreflang verification Phase 2. |
| D-15 | ADR-010 delivery/repo | **Accepted as policy** (2026-08-29) — monorepo, immutable images, roles, restore-drill gate. Repository posture per **revised D-06: PUBLIC** (original PRIVATE proposal superseded by owner decision). |

## Mandatory gates (recalculated 2026-08-29)

| Gate | Requirement | Status | Evidence |
|---|---|---|---|
| 1 — Repository visibility | Visibility decision recorded (intentional posture) + pre-push secret-safety scan | **PASS** | Intentionally **PUBLIC** by owner decision D-06 (revised 2026-08-29); public-repo safety scan 2026-08-29: zero sensitive findings |
| 2 — Ten ADRs reviewed | All reviewed + business decisions approved | **PASS (10/10)** | Accepted: ADR-001, 002, 003, 005, 008 (D-01…D-05) + ADR-004, 006, 007, 009, 010 (D-11…D-15), all 2026-08-29. Evidence-gated sub-items (ADR-004 legacy TZ, ADR-009 hreflang) tracked inside their ADRs — not owner guesses |
| 2a — Trade policy | ADR-002 approved | **PASS** | D-01 (Option B), 2026-08-29 |
| 2b — Email policy | ADR-003 approved | **PASS** | D-02 (policy a), 2026-08-29 |
| 3 — Hosting validated | 20-row checklist fully evidenced | **BLOCKED** | 0/20 rows evidenced; gathering authorized (D-09). Attempt 2026-08-31 stopped: candidate host not identified, no access — see `docs/evidence/BLOCKED-REPORT-2026-08-31.md` |
| 4 — Parity date | Concrete owner-committed date | **PASS** | D-07 = **2027-03-31** (owner decision, recorded verbatim) |
| 5 — Kill criterion | Written stall-termination condition | **PASS** | D-08 accepted 2026-08-29 (text below) |
| — Phase 1 authorization | Explicit owner authorization | **NOT AUTHORIZED** | D-10 |

## Kill criterion (ACCEPTED — owner decision D-08, 2026-08-29)

> If, for 8 consecutive weeks, fewer than 50% of planned weekly parity increments
> complete, or the parity target date slips by more than one quarter without a
> formally recorded revision, the modernization effort is halted or reset with
> a written review.

## Remaining to unlock Phase 1

1. Execute authorized hosting validation (D-09) until 20/20 rows evidenced
   (candidate production network position, registry reachability, repeated-pull
   throttling, OCR-sized image pull, PostgreSQL backup + restore drill to a
   running stack, and all remaining checklist rows).
2. Owner: explicit Phase 1 authorization (D-10).

Push of the Phase 0 commits is permitted only on explicit owner authorization;
the repository's public posture (D-06) allows it at any time, and the standing
pre-push secret-safety scan must be re-run before every push.

## Supporting exit items (complete)

Capability registry v1 (28 rows) · external contracts (14 frozen + C-15 candidate) · threat model (30 rows)
· security policy + production gates · migration strategy (rows+bytes rule)
· parity plan · observability contract · governance contract (`AGENTS.md`).
