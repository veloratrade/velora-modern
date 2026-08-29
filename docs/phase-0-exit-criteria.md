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
| D-06 | Repository visibility | Owner **will flip `velora-modern` to PRIVATE manually**. Agent does not change visibility. Push blocked until owner confirms the repository is private. |
| D-07 | Parity target date | **OWNER DECISION PENDING** — no date invented; do not record a date until the owner provides one. |
| D-08 | Kill criterion | **Accepted** (text below). |
| D-09 | Hosting validation | **AUTHORIZED** — evidence gathering only; no infrastructure provisioning/modification. Status stays BLOCKED until evidence complete. |
| D-10 | Phase 1 | **NOT AUTHORIZED** — blocked until all mandatory gates pass. |

## Mandatory gates (recalculated 2026-08-29)

| Gate | Requirement | Status | Evidence |
|---|---|---|---|
| 1 — Repository visibility | `velora-modern` private before push | **BLOCKED** | API-verified public (2026-08-29); D-06: owner will flip manually; push forbidden until owner confirms private |
| 2 — Ten ADRs reviewed | All reviewed + business decisions approved | **BLOCKED (5/10)** | Accepted: ADR-001, 002, 003, 005, 008 (D-01…D-05). Still Proposed: **ADR-004, 006, 007, 009, 010** |
| 2a — Trade policy | ADR-002 approved | **PASS** | D-01 (Option B), 2026-08-29 |
| 2b — Email policy | ADR-003 approved | **PASS** | D-02 (policy a), 2026-08-29 |
| 3 — Hosting validated | 20-row checklist fully evidenced | **BLOCKED** | 0/20 rows evidenced; gathering authorized (D-09) |
| 4 — Parity date | Concrete owner-committed date | **BLOCKED** | D-07 = OWNER DECISION PENDING |
| 5 — Kill criterion | Written stall-termination condition | **PASS** | D-08 accepted 2026-08-29 (text below) |
| — Phase 1 authorization | Explicit owner authorization | **NOT AUTHORIZED** | D-10 |

## Kill criterion (ACCEPTED — owner decision D-08, 2026-08-29)

> If, for 8 consecutive weeks, fewer than 50% of planned weekly parity increments
> complete, or the parity target date slips by more than one quarter without a
> formally recorded revision, the modernization effort is halted or reset with
> a written review.

## Remaining to unlock Phase 1

1. Owner: flip repository to private, then **confirm** → unlock push of Phase 0 commits.
2. Owner: review/approve the five remaining ADRs (004, 006, 007, 009, 010).
3. Execute authorized hosting validation (D-09) until 20/20 rows evidenced.
4. Owner: provide parity target date (D-07).
5. Owner: explicit Phase 1 authorization (D-10).

## Supporting exit items (complete)

Capability registry v1 (28 rows) · external contracts (14) · threat model (30 rows)
· security policy + production gates · migration strategy (rows+bytes rule)
· parity plan · observability contract · governance contract (`AGENTS.md`).
