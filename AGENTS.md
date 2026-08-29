# VELORA-MODERN — Agent Operating Contract (Governance)

This is the entry-point governance file for `veloratrade/velora-modern`.
It is deliberately **governance-only**: it does not prescribe framework internals.

## Project status

Phase 0 (Architecture & Governance) — **documentation only**. No application code
exists in this repository yet. Phase 1 starts only after the owner has explicitly
approved Phase 0 exit (see `docs/phase-0-exit-criteria.md`).

## Non-negotiable rules

1. **No secrets.** Never commit, log, or echo secret values (API keys, tokens,
   passwords, JWT/encryption keys, env contents). Names only, never values.
2. **No direct production changes.** Production (currently the PHP system) is never
   modified from this repository or by an agent working here, unless the owner
   explicitly authorizes a specific operation in writing.
3. **Domain logic lives in `packages/domain`.** It must stay framework-free and
   I/O-free. `apps/*` are thin delivery shells only.
4. **Apps are thin.** If business rules appear in `apps/web`, `apps/api`, or
   `apps/worker`, that is a defect.
5. **Financial math requires decimal arithmetic.** IEEE-754 floating point is
   prohibited for money, PnL, volume, prices, R-multiples (ADR-001).
6. **External contracts require tests.** Every item in
   `docs/external-contracts.md` must be covered by the parity/contract suite
   before it is declared implemented (ADR-006).
7. **Security-sensitive changes require explicit review.** Auth, secrets, CSP,
   webhooks, uploads, RBAC, migrations — always human-reviewed, never
   auto-merged.
8. **Migrations require validation.** Row counts, checksums, FK checks, login
   smoke, PnL recomputation, screenshot byte verification (ADR-005,
   `docs/migration-strategy.md`).
9. **Do not modify the PHP repository during modernization** unless the owner
   explicitly authorizes the specific change.
10. **Never mark a capability SYNCED without evidence** — test run + human
    sign-off recorded in the capability registry.
11. **Prefer minimal, reversible changes.** Small PRs, atomic commits,
    ADR updates in the same change when a decision is affected.
12. **Do not silently resolve business decisions.** Ambiguity in business rules
    is reported as OWNER DECISION REQUIRED, never guessed away.

## Evidence vocabulary

Every architectural claim must be tagged:

- `VERIFIED` — directly confirmed from source code, schema, or live evidence.
- `ASSUMPTION` — plausible but unconfirmed; must be listed as an open question.
- `DECISION` — a choice made (Proposed until the owner accepts).
- `OPEN QUESTION` / `OWNER DECISION REQUIRED` — unresolved; blocks dependent work.

## Artifact map

| Path | Role |
|---|---|
| `docs/adr/ADR-001…010` | Architectural decisions — all ten Accepted (2026-08-29, D-01…D-05 + D-11…D-15); evidence-gated sub-items tracked within each ADR |
| `docs/threat-model.md` | Threats, controls, detection, residual risk |
| `docs/security-policy.md` | Mandatory baseline + production security gates |
| `docs/external-contracts.md` | Frozen external contract tier |
| `docs/capability-registry.md` | Capability registry / parity matrix (PORT/SKIP/DEFER/SYNCED) |
| `docs/migration-strategy.md` | MySQL→PostgreSQL migration & validation spec |
| `docs/hosting-validation.md` | Hosting readiness checklist (evidence-based) |
| `docs/parity-plan.md` | Executable behavioral parity specification |
| `docs/observability-contract.md` | Metrics/logs/traces naming + SLOs |
| `docs/phase-0-exit-criteria.md` | Phase 0 gates and Phase 1 readiness |

## Session protocol (lean)

1. Read this file, then the ADRs relevant to your mission.
2. Work only within the scope the owner stated.
3. Report concise, evidence-tagged conclusions — no file dumps, no raw logs.
4. Commit/push only after owner approval (Phase 0 material: see Gate 1 in
   exit criteria — repository must be private before security material is pushed).
