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
| `docs/adr/ADR-001…016` | Architectural decisions — ADR-001…010 accepted 2026-08-29 (D-01…D-05 + D-11…D-15); ADR-011 Phase-1 implementation record; **ADR-012 backup-gate law + ADR-013 environment-origin safety law** (2026-09-12, D-16/D-17); **ADR-014 MetaAPI platform token as a distinct secret class** (2026-09-15, D-19); **ADR-016 credential encryption & key management** (2026-09-15, D-18); ADR-015 unused; evidence-gated sub-items tracked within each ADR |
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
| `docs/evidence/PHASE-C-CLOSURE-AUDIT.md` | Phase C final closure & exit audit (2026-09-13): **PASS — PHASE C CLOSED** — increment 1–9 reconciliation verified from tree evidence, security/ADR/test-integrity/git-lineage audits clean, scope-contamination none, stale inc-1 matrix labels corrected (rows 1/4/22 + §B), exit boundary recorded |
| `docs/evidence/PHASE-D-D5-ROLES.md` | Phase D D5 (2026-09-13): PostgreSQL roles & privilege enforcement — **GREEN: GHA run 34768881278 @ 790535d9, D5 battery 18/18 (0 fail, 0 skipped) on real PostgreSQL 16.15; D1 S1–S9 + D2/D3/D4 44/44 re-confirmed in the same run (62/62 total)**; `db/roles.sql` rewritten (previously applied by nothing — D1 risk R9) and split with new `db/roles-bootstrap.sql`; ownership model **SUPERSEDED 2026-09-13 by the ADR-010 amendment** — application objects are owned by `velora_owner` (NOLOGIN) and `velora_migrator` owns nothing, reaching DDL only via explicit `SET ROLE` (a PostgreSQL owner implicitly holds all privileges on its objects and they cannot be revoked, so a migrator-as-owner contradicts P13); the original D5 run proves the **privilege grid**, not the ownership model (harness ran `migrate()` before role bootstrap under a superuser, and no test asserts ownership) — ownership verification is a D6 item; defects D-1 ordering / D-2 ALTER DEFAULT PRIVILEGES / D-3 no invented credentials / D-4 false pgboss claim removed / D-5 ownership all fixed; append-only enforced on `trade_events`+`webhook_events` for app_readwrite+velora_worker (INSERT allowed, UPDATE/DELETE/TRUNCATE → **42501**), readonly SELECT-only, migrator DDL but no runtime DML, future-table default privileges, trigger-driven exit path unbroken under least privilege; negative control (removing a REVOKE) correctly fails 4 tests; **privileges proven via SET ROLE = authorization grid, NOT login authentication (no test passwords created)**; deployment does NOT yet apply the layer (`railway.json` startCommand runs migrate only) — documented, not silently changed; local: typecheck 0, battery 304/304, migrations 5/5, scan PASS; B-3 full-battery-on-PG deferred to D6 |
| `docs/evidence/PHASE-D-D4-TRADE-CONCURRENCY.md` | Phase D D4 (2026-09-13): service-level trade-concurrency verification — **GREEN: GHA run 34764562392 @ 185c02e, D4 battery 14/14 (0 fail, 0 skipped) on real PostgreSQL 16.15; D1 S1–S9 + D2/D3 30/30 re-confirmed in the same run**; two TradeService instances over one pool, explicit statement/lock timeouts; mixed same-trade races (exit/edit/tombstone/cancel — winner-set invariants, exact 409/404/422 contracts), different-trade isolation, stale CAS, 8-way full+partial allocation races (exact scale-8 allocation, never over-allocated), over-allocation full rollback, lock release after failure, duplicate event_uid constraint honesty + full rollback, tombstone finality (no resurrection, non-disclosing 404), NUMERIC exact-string preservation, bounded projection==replay for every raced sequence; **production code/schema/deps UNCHANGED (verification-only, per authorization)**; first run 34764232409 failed 5 assertions — root causes classified as battery expectation defects (service pre-read is advisory ⇒ serialized both-succeed is legal; domain zero "0" ≡ PG "0.00000000"), fixed test-side in 185c02e, no production race found; Railway NOT used for D4; local: typecheck 0, battery ALL PASS, SKIP-safe 14/14, scan PASS |
| `docs/evidence/PHASE-D-D3-QUOTA.md` | Phase D D3 (2026-09-13): transactional account quota — optional `createWithQuotaGuard` port method (users-row FOR UPDATE + count + insert in ONE tx, `AccountQuotaExceededError`), PgAccountStore implementation on direct pg, service maps to the byte-identical 429 contract; memory/PGlite paths untouched (mutex only for non-transactional stores); pgQuota battery (4 tests: exact 429, 8-way concurrent across two service instances, unlimited plan, dead-DB no-false-success); local 304/304 + typecheck 0 + scan PASS (commit `3a73d2d`); **real-PG GREEN: GHA run 34755425479 @ 5e36d3f — batteries 30/30 (pgQuota 4/4, 0 skipped), 8-way concurrent quota race across two service instances = exactly one success**; **Railway deployed-app integration verification COMPLETE (staging env only, production untouched): app live @ `86f091a3` on `1cc057b` (fixes: tsx→dependencies for RAILPACK, HOST=0.0.0.0 bind; EO-008/SC-007 staging boot gates confirmed fail-closed in deployment — OD-1 still open, test env classified APP_ENV=development pending owner ratification); all 12 plan points executed — 8-way public-edge race 1×201/7×429 exact contract, ownership 404 non-disclosing, DB-outage fail-closed (app exit + 502s, zero false verdicts, auto-recovery ~150 s); documented assists: temporary psql helper for verification tokens (Phase I email absent; helper deleted), volumeless postgres redeploy wiped test data AFTER assertions captured (lesson: attach volume)**; 12-point coverage map (GHA + Railway columns) in the record |
| `docs/evidence/PHASE-D-D2-PG-ADAPTERS.md` | Phase D D2 (2026-09-13): real-PG store adapters (direct pg, no ORM) — **GREEN: run 34732967635 @ 7671364, batteries 26/26 (0 fail, 0 skipped) + S1–S9 re-confirmed on PostgreSQL 16.15**; four Pg* adapters + shared persistence/pg.ts (withTransaction, SQLSTATE mapping), server-main PERSISTENCE=postgres wiring, pg ^8.12.0 declared in apps/api (R10 fix), run-tests.mjs .pg separation, postgres-evidence.yml D2 step; full run ledger with root-cause classifications (2 test-harness runs, 1 real adapter bug cancelExit deletedAt — fixed, catching assertion unchanged); local: typecheck 0, 304/304, 5/5, scan PASS; boundaries D3–D6 not proven |
| `docs/evidence/PHASE-D-D1-PG-EVIDENCE.md` | Phase D D1 real-PG evidence (2026-09-13): **GREEN — S1–S9 ALL PASSED on PostgreSQL 16.15** (GHA run 34731411400, commit `cad84f35`, postgres:16-alpine service container, disposable test-only); verbatim PASS lines + anti-SKIP verification + dispatch mechanics (default-branch switch ~3s, restored; Actions already enabled; branch push triggered nothing); D1 direct-pg decision CONFIRMED; D2 gate open; NOT proven: full battery on PG, roles.sql, service-level concurrency (D3–D6) |
| `docs/reconciliation/PHASE-D-D1-ORM-SPIKE.md` | Phase D D1 (2026-09-13): ORM spike — **recommendation direct `pg`, no ORM** (OD-6 owner-confirmed 2026-09-13 — direct pg, no ORM; D2 conditionally authorized pending green real-PG S1–S9); criteria matrix vs Drizzle/Kysely/Prisma; pg driver-shape evidence from installed pg-types source (NUMERIC scalar unregistered → raw string; int8 → string; timestamptz → Date; numeric[] → float hazard); 10 risks R1–R10 for D2–D6; apparatus prepared: `.github/workflows/postgres-evidence.yml` (dispatch-only, postgres:16-alpine, test-only creds) + `tools/pg-smoke.ts` (S1–S9, env-gated, SKIP path verified; real-PG execution BLOCKED until owner pushes + enables Actions); battery 304/304 + 5/5 unchanged |
| `docs/evidence/PHASE-C-INCREMENT-9-RECORD.md` | Phase C increment 9 (2026-09-13): remaining-scope re-evaluation — **NO ELIGIBLE CAPABILITY** (correct outcome, nothing manufactured); inc-8 serialization open item resolved from source (PHP API layer trims — Local PHP-faithful; time wire format = ADR-004 D-11 owner decision); stale matrix labels corrected (rows 2/5/6/7/9/20, §B); docs-only, 304/304 unchanged |
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
