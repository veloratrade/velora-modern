# VELORA-MODERN — Phase 0 Exit Criteria

Phase 1 (any application code) begins only after every mandatory gate is PASS.
**Never manufacture a PASS** — missing evidence = BLOCKED; owner-owned choices =
OWNER DECISION REQUIRED.

## Mandatory gates

| Gate | Requirement | Status (2026-08-29) | Evidence |
|---|---|---|---|
| 1 — Repository visibility | `velora-modern` is **private** before architectural/security material is pushed. Owner flips visibility (agent must not). | **BLOCKED** — verified PUBLIC via GitHub API (2026-08-29) | API check recorded in Phase 0 report; local commit exists, **not pushed** |
| 2 — Ten ADRs reviewed | ADR-001…010 reviewed by owner; business decisions explicitly approved: (a) trade mutation/audit policy (ADR-002 Option A/B), (b) email canonicalization policy (ADR-003) | **BLOCKED** — ADRs created, all `Proposed`; no owner review recorded | `docs/adr/` |
| 3 — Hosting validated | `docs/hosting-validation.md` all rows evidenced (esp. registry reachability + throttling) | **BLOCKED** — no evidence gathered (0/20 rows) | `docs/hosting-validation.md` |
| 4 — Parity date | Concrete parity/cutover target date committed by owner | **BLOCKED** — none | — |
| 5 — Kill criterion | Written condition to terminate/reset the modernization if stalled | **BLOCKED** — none | — |

## Supporting exit items (complete)

- Capability registry v1 (28 rows, verification debts listed) — `docs/capability-registry.md`
- External contract inventory (14 contracts) — `docs/external-contracts.md`
- Threat model (30 rows, assumptions labeled) — `docs/threat-model.md`
- Security policy + production gates — `docs/security-policy.md`
- Migration strategy incl. screenshot rows+bytes rule — `docs/migration-strategy.md`
- Parity plan (executable spec model) — `docs/parity-plan.md`
- Observability contract — `docs/observability-contract.md`
- Governance contract — `AGENTS.md`

## Suggested kill criterion (draft for owner — not committed)

> If, for 8 consecutive weeks, fewer than 50% of planned weekly parity increments
> complete, or the parity target date slips by more than one quarter without a
> revised owner decision, the modernization is halted or reset with a written review.

## Suggested next actions (owner)

1. Flip `velora-modern` to private (Settings → General → Danger Zone).
2. Review/approve the ten ADRs (esp. ADR-002 Option B, ADR-003 policy).
3. Decide parity target date + kill criterion (draft above).
4. Run/authorize the hosting validation checklist (evidence into `docs/evidence/`).
5. On gates 1–5 PASS: approve Phase 1 start (scope: `docs/phase-0-exit-criteria.md` → Phase 1 foundation per ADR set).
