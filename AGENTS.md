# VELORA-MODERN — Agent Operating Contract (Governance)

This is the entry-point governance file for `veloratrade/velora-modern`.
It is deliberately **governance-only**: it does not prescribe framework internals.

## Project status

Phase 1 (Architecture Foundation) — **IN PROGRESS under D-10 (2026-08-31),
dev/staging only**. Foundation implemented: contracts, pure domain (decimal/
PnL/ledger), PostgreSQL migrations + roles, auth primitives (bcrypt `$2y$`
proof gate PASSED), queue semantics, API/web kernels, CI/infra/parity
scaffolding — see `docs/adr/ADR-011-phase1-implementation-record.md`.
Post-audit governance alignment (2026-09-12): backup-gate law (ADR-012) and
environment-origin safety contract (ADR-013) adopted; capability registry
re-verified against Reference `main` @ `a8eabac`.
Reconciliation gate (2026-09-12): **Foundation-First Hybrid APPROVED**
(OD-1…OD-10, `docs/reconciliation/RECONCILIATION_DECISIONS.md`); Remote
lineage pinned by annotated tag + provenance manifest
(`docs/provenance/REMOTE_LINEAGE.md`); authorized scope was A0 +
A-Preparation only — Phases B–O remain unauthorized.
Production hosting validation (Gate 3B) gates production deployment/cutover,
not Phase 1.

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
13. **No covered mutation without a backup gate.** Any staging/production
    operation that can affect persistent application state requires a valid
    backup gate — satisfied for that exact operation, target, and environment —
    immediately before the mutation. Fail-closed; no bypass flags; no
    "operator confirms manually" exception; mechanism-exists is not
    backup-exists (ADR-012, D-16).
14. **Environment identity is explicit.** `APP_ENV` and `APP_ORIGIN` must be
    explicitly configured and validated against the canonical
    environment↔origin map. Unknown environments and missing origins never
    receive implicit defaults; staging↔production cross-bindings are blocked
    (ADR-013, D-17).

## Evidence vocabulary

Every architectural claim must be tagged:

- `VERIFIED` — directly confirmed from source code, schema, or live evidence.
- `ASSUMPTION` — plausible but unconfirmed; must be listed as an open question.
- `DECISION` — a choice made (Proposed until the owner accepts).
- `OPEN QUESTION` / `OWNER DECISION REQUIRED` — unresolved; blocks dependent work.

## Artifact map

| Path | Role |
|---|---|
| `docs/adr/ADR-001…013` | Architectural decisions — ADR-001…010 accepted 2026-08-29 (D-01…D-05 + D-11…D-15); ADR-011 Phase-1 implementation record; **ADR-012 backup-gate law + ADR-013 environment-origin safety law** (2026-09-12, D-16/D-17); evidence-gated sub-items tracked within each ADR |
| `docs/threat-model.md` | Threats, controls, detection, residual risk |
| `docs/security-policy.md` | Mandatory baseline + production security gates |
| `docs/external-contracts.md` | Frozen external contract tier |
| `docs/capability-registry.md` | Capability registry / parity matrix (PORT/SKIP/DEFER/SYNCED) |
| `docs/migration-strategy.md` | MySQL→PostgreSQL migration & validation spec |
| `docs/hosting-validation.md` | Hosting readiness checklist (evidence-based) |
| `docs/evidence/PHASE-B-SECURITY-RECORD.md` | Phase B (2026-09-12) S1–S8 hardening dispositions, evidence, and limitations |
| `docs/evidence/PHASE-C-INCREMENT-1-RECORD.md` | Phase C increment 1 (2026-09-12): envelope/health contracts + identity capability port, evidence labels, deferrals |
| `docs/evidence/PHASE-C-INCREMENT-2-RECORD.md` | Phase C increment 2 (2026-09-12): identity completion (change-password/preferences/email-preferences), PnL golden-vector reconciliation (per-value classification), accounts capability (ownership-scoped port + 0004 ALTER migration); documented differences, deferrals, full battery |
| `docs/evidence/PHASE-C-INCREMENT-3-RECORD.md` | Phase C increment 3 (2026-09-12): trades capability on the ADR-002 ledger (correction events, tombstones, EXIT_CANCELLED, optimistic 409s), 0005 migration, ADR-004 time model, documented divergences (403 financial PUT, dead search params, scale-2 costs) |
| `docs/evidence/PHASE-C-INCREMENT-4-RECORD.md` | Phase C increment 4 (2026-09-13): journal capability on the trades ledger — field ownership matrix, PHP-evidenced q/order search, journal replay proof, null-clear bug fixed in the PGlite store |
| `docs/evidence/PHASE-C-INCREMENT-5-RECORD.md` | Phase C increment 5 (2026-09-13): strategies determination — NO standalone capability in either lineage (verified); strategyTag journal contract regression-tested; dashboard stats formulas inventoried and deferred; no CRUD/entity/migration manufactured |
| `docs/evidence/PHASE-C-INCREMENT-8-RECORD.md` | Phase C increment 8 (2026-09-13): PnL risk-semantics parity (CAP-TRADE-01 tail) — directional risk, no-SL/zero-SL/wrong-side SL → undefined risk (rMultiple null, both lineages evidenced); VECTOR C/D fixtures resolved from PHP source; ADR-001 divergences preserved; no migration/UI; 304/304 |
| `docs/evidence/PHASE-C-INCREMENT-7-RECORD.md` | Phase C increment 7 (2026-09-13): rate limiting (CAP-PLAT-02 PORT) — PHP dispatch-level fixed-window throttle on the 5 implemented auth routes (C-14 values), 429 TOO_MANY_REQUESTS + messageKey + Retry-After, trusted-proxy client-IP (fail-closed), store-failure 503, memory store + PGlite boundary proof; taxonomy RATE_LIMITED→TOO_MANY_REQUESTS correction; no migration/UI |
| `docs/evidence/PHASE-C-INCREMENT-6-RECORD.md` | Phase C increment 6 (2026-09-13): entitlements — standalone EntitlementService module (Remote shape), fail-closed 503 plan lookup, per-user quota serialization ([201,429]), 429 messageKey, provider-bypass prevention; no migration/routes; DB-level guarantees stay Phase D |
| `docs/reconciliation/PHASE-C-CAPABILITY-MATRIX.md` | Phase C capability classification (27 domains) + external contract inventory |
| `docs/parity-plan.md` | Executable behavioral parity specification |
| `docs/observability-contract.md` | Metrics/logs/traces naming + SLOs |
| `docs/phase-0-exit-criteria.md` | Phase 0 gates, decision ledger (D-01…D-17), and reconciliation decisions (OD-1…OD-10) |
| `docs/reconciliation/RECONCILIATION_DECISIONS.md` | Owner-approved reconciliation gate record (2026-09-12) — Foundation-First Hybrid, scope + non-authorizations |
| `docs/provenance/REMOTE_LINEAGE.md` | Remote lineage provenance manifest (pinned snapshot, annotated tag, verification evidence) |

## Session protocol (lean)

1. Read this file, then the ADRs relevant to your mission.
2. Work only within the scope the owner stated.
3. Report concise, evidence-tagged conclusions — no file dumps, no raw logs.
4. Commit/push only after owner approval. The repository is intentionally PUBLIC
   (owner decision D-06, revised 2026-08-29); visibility and secret safety are
   separate concerns — the standing pre-push secret-safety scan must be re-run
   with zero findings before every push.
