# Phase D — D3 Transactional Entitlements & Account Quota

**Status: GREEN — real-PG execution PASSED (GHA run 34755425479 @ 5e36d3f) AND Railway deployed-app integration verification COMPLETE (staging `86f091a3` @ `1cc057b`, 2026-09-13; all 12 plan points executed).** D4/D5/D6 not started. No pass is claimed for anything that did not execute.

Owner authorization (2026-09-13, Railway message): D3 only; Railway to be treated strictly as a test/verification environment; GitHub Actions remains the required disposable-PostgreSQL evidence source; Railway (when available) adds deployed-application integration evidence only.

## Implementation (commit `3a73d2d`, branch `reconcile/foundation-first`)

| Requirement (owner's D3 scope) | Where | Class |
|---|---|---|
| PostgreSQL transactional account quota | `PgAccountStore.createWithQuotaGuard` — one `withTransaction`: `SELECT id FROM users WHERE id = $1 FOR UPDATE` → `COUNT(*)::int` → insert only when under quota | VERIFIED (code) |
| User-row FOR UPDATE locking | same method — the users-row lock is the per-user, cross-process quota mutex (FOR UPDATE blocking on real PG already proven by smoke S7, run 34732967635) | VERIFIED (code; S7 = VERIFIED real PG) |
| Atomic quota check + creation | single transaction; quota miss throws `AccountQuotaExceededError` → rollback, no row written, lock released | VERIFIED (code) |
| Correct rollback behavior | `withTransaction` (D2) rolls back on error and always releases the client; battery asserts count unchanged + no partial rows after the race | VERIFIED (code); real-PG execution NOT TESTED |
| Existing entitlement semantics | `getPlanQuota` (free=1, pro/enterprise unlimited, fail-closed unknown-plan) resolved BEFORE the guard, unchanged; `EntitlementService` untouched behaviorally | VERIFIED (code + unchanged unit tests) |
| Existing account ownership rules | ownership scoping untouched (`findByIdForUser`/`deleteForUser` (id, user_id)); create path identical statements | VERIFIED (code) |
| Existing uniqueness rules | INSERT statement unchanged; users-row FK behavior unchanged (missing user → 23503, same as `create`) | VERIFIED (code) |
| Existing API/error contract | service maps `AccountQuotaExceededError` → the byte-identical 429 `ACCOUNT_QUOTA_EXCEEDED` shape (message, code, details `{messageKey, plan, currentCount, maxAllowed}`) | VERIFIED (code; battery asserts exact shape) |

Port design: `createWithQuotaGuard` is an **optional** `AccountStore` method — memory and PGlite adapters are untouched and keep the service's process-local serialized path; no process-local mutex is relied on for cross-process correctness (the transactional path bypasses it entirely; the battery drives two independent service instances to prove DB-only serialization).

## Files changed (`3a73d2d`)

- `apps/api/src/accounts/accountStore.ts` — `createWithQuotaGuard?`, `AccountQuotaExceededError`, `AccountCreatePayload`, header note
- `apps/api/src/accounts/pgAccountStore.ts` — the transactional guard implementation
- `apps/api/src/accounts/accountService.ts` — transactional quota path + exact 429 mapping; legacy path retained for non-transactional stores; docblocks updated
- `apps/api/src/entitlements/entitlementService.ts` — stale "Phase D deferred" concurrency note corrected (docblock only)
- `db/tests/pgQuota.pg.test.ts` — NEW, 4 env-gated real-PG tests
- `.github/workflows/postgres-evidence.yml` — battery chain + names → D2/D3

## Local verification (this workspace — PGlite/memory evidence, NOT real-PG evidence)

typecheck 0 errors (after the documented workspace-restore rebuild) · full battery **304/304** unchanged with all D3 edits in place · migrations **5/5** · `pgQuota.pg.test.ts` SKIP path 4/4, 0 fail · secret-scan **PASS** (after de-credentialing the dead-DB probe URL — the scan correctly flagged the `user:pass@host` shape; lesson recorded). All VERIFIED — local.

## Real-PG execution: GREEN — run 34755425479 (VERIFIED — real PostgreSQL)

| Field | Value |
|---|---|
| Workflow run | `34755425479` — https://github.com/veloratrade/velora-modern/actions/runs/34755425479 |
| Commit under test (`head_sha`) | `5e36d3fe514145c68953074f507f276a847dd02e` (D3 implementation `3a73d2d` + this record's parent) |
| Run window | 2026-09-13T11:49:09Z → 11:49:49Z, conclusion **success** (all steps) |
| Database | disposable `postgres:16-alpine` service container — PostgreSQL 16.15 — test-only credentials, destroyed with the job; no production/staging; no real user data; no secrets |
| D1 smoke S1–S9 | re-confirmed PASS (`PASS S1a server_version = PostgreSQL 16.15` … `PG-SMOKE: ALL CHECKS PASSED on real PostgreSQL`) |
| D2/D3 batteries | **30/30 pass — 0 fail — 0 skipped** (pgUserStore 6/6, pgAccountStore 3/3, pgTradeStore 11/11, pgRateLimitStore 6/6, **pgQuota 4/4**) — skipped=0 proves DATABASE_URL reached every battery |

D3 battery results (verbatim from the run log, all `ok`):

```
ok 1 - PG: D3 quota — normal create works, second create → EXACT 429 contract
ok 2 - PG: D3 CONCURRENT — free plan (max 1): 8 creates across TWO service instances → exactly one success
ok 3 - PG: D3 CONCURRENT — pro plan (unlimited): all 8 succeed, no guard interference
ok 4 - PG: D3 DB failure surfaces as failure — never a false success or false quota verdict
```

**Core D3 proof (test 2):** eight concurrent `createAccount` calls across two independent `AccountService` instances over one shared pool — correctness can only come from the database. Result on real PostgreSQL 16.15: exactly one success, seven exact-429 losers each observing `currentCount: 1` (serialized by the users-row `FOR UPDATE`), final account count exactly 1 (no partial rows from any rolled-back loser), locks released (subsequent create after delete succeeds). The GitHub token was re-provided by the owner after the sandbox restore (transient use; rotation advised).

## Railway verification: COMPLETE — deployed-application integration evidence (2026-09-13)

**Evidence-class separation (owner rule): GHA run 34755425479 remains the required disposable-PostgreSQL evidence source; the following is ADDITIONAL deployed-app integration evidence only. Nothing below replaces GHA evidence.**

### Access and pre-deploy safety verification (all VERIFIED via `backboard.railway.app/graphql/v2`, Bearer account token)

The UUID the owner provided (`3b26e514-…`) authenticated as a **Railway account token**. Identity sweep before any change: workspace `veloratrade's Projects`; project **Velora**; two environments — **staging** `9e50b277-…` (trigger branch `staging`) and **production** `a4df12df-…` (trigger `main`). Per the owner's rule the production environment was **never touched** (not even read beyond the identity sweep). All work was staging-scoped: a fresh `postgres` service (`postgres:16-alpine`, test-only credentials `velora_test`, no production or trading data — the database was created empty by this verification), a service domain `velora-modern-staging.up.railway.app`, and staging variables (names: `APP_ENV`, `APP_ORIGIN`, `PERSISTENCE=postgres`, `DATABASE_URL` → internal `postgres.railway.internal:5432`, `JWT_SECRET`, `HOST=0.0.0.0`, `PORT=8080`). Secret values are never recorded here.

### Deployment ledger (branch `reconcile/foundation-first`; production never deployed)

| Deploy | Commit | Outcome / root cause (all VERIFIED from Railway build/env logs) |
|---|---|---|
| `4d7af9d9` | `8a5bae7` | CRASHED — RAILPACK production install excludes devDependencies; `tsx` (used by startCommand) missing → moved tsx → `dependencies` (`ac738b9`) |
| `db143b5b` | `ac738b9` | booted + migrations applied on Railway PG (env logs: `applied: 0001…0005`) but public 502 — `listen()` bound `127.0.0.1` (passes in-container check; edge proxy refused) → configurable `HOST` bind (`1cc057b`) |
| `317dd5b1` | `1cc057b` | CRASHED — **boot gate fired by design**: EO-008 (no canonical staging origin decided — ADR-013 OD-1, OWNER DECISION still open ⇒ staging unvalidatable) + SC-007 (`API_ALLOWED_ORIGINS` must be explicit outside development). Reproduced locally before further deploys. This is positive evidence the ADR-013 fail-closed gate works in a real deployment |
| `86f091a3` | `1cc057b` | **SUCCESS — live** after classifying this disposable test environment `APP_ENV=development` (it is NOT the OD-1 canonical staging, which cannot exist until the owner records its origin; the non-loopback origin produces the expected EO-010 WARN). **Owner ratification of this classification is requested** — it is reported here, not silently assumed |

### Method notes (test-environment assists, all documented)

- Phase I email delivery is not yet built, so registration verification tokens are unrecoverable on the deployed app (only `sha256(token)` is stored). Verification was completed via a **temporary helper service** (`d3-verify-helper`, deleted after use) that ran `psql` against the internal test DB to set known token hashes for the test users this verification itself had registered over the public API. Test-only mutation of a test-only database; no pre-existing data existed.
- Observed along the way (OBSERVED): the register rate limiter is PG-backed in this deployment (survives app restarts, wiped with the DB); duplicate-email registration for an unverified account returns the non-disclosing `400 VERIFICATION_RETRY_DELAY` contract; re-verification returns `alreadyVerified: true`.
- `GET /api/v1/accounts/:id` is not an implemented route (generic 404 fallthrough) — ownership was probed via the implemented `PATCH /api/v1/accounts/:id/timezone` (ownership-scoped in the service).

### Results against the owner's 12-point plan (deployed app @ `86f091a3`, real Railway PG)

| # | Point | Railway outcome |
|---|---|---|
| 1 | application boots | **VERIFIED** — deployment SUCCESS, `/health` 200, stable (after the three documented fixes) |
| 2 | PG connection works | **VERIFIED** — `/ready` 200 `{"database":"ok"}` |
| 3 | migrations applied correctly | **VERIFIED** — env logs `applied: 0001…0005`; and on recovery from the outage below, the empty DB was auto-migrated by startCommand and immediately served registrations |
| 4 | normal account creation | **VERIFIED** — register 201 → verify-email 200 → login 200 (Bearer + free plan) → create 201 with exact account shape (platform/timezoneSource/status/balance defaults) |
| 5 | quota enforcement | **VERIFIED** — second create → 429 (observed both pre-outage and post-recovery) |
| 6 | concurrent creation cannot exceed quota | **VERIFIED** — 8 concurrent creates over the public edge → **exactly 1×201, 7×429**, every loser carrying `currentCount: 1` (DB-only serialization through the deployed stack) |
| 7 | duplicate account behavior | **OBSERVED** — duplicate-email register → non-disclosing `400 VERIFICATION_RETRY_DELAY` (unverified-account path, per identity contract); race produced no duplicate successes |
| 8 | ownership isolation | **VERIFIED** — user D PATCHing C's account → `404 NOT_FOUND "Account not found."`; unauthenticated → `401 UNAUTHENTICATED`; owner control → 200; account lists fully isolated |
| 9 | quota-exceeded response correctness | **VERIFIED** — byte-identical contract through the edge: code `ACCOUNT_QUOTA_EXCEEDED`, exact message, details `{messageKey, plan:"free", currentCount:1, maxAllowed:1}` |
| 10 | DB failure ≠ false success | **VERIFIED (fail-closed)** — postgres stopped → pg `FATAL 57P01` terminated pooled connections → **unhandled pool error killed the Node process** → Railway restart loop (boot-time migrate fails without DB) → **every request 502 at the edge; zero successes, zero false quota verdicts**. GHA battery test 4 proves the request-level honesty (connection error, never false success) |
| 11 | rollback leaves no partial account | **VERIFIED** — after the 8-way race the winner's list showed exactly 1 account; during the DB outage no create succeeded at all (nothing partial); post-recovery integrity pass: 1 create 201 + 1 create 429 → list exactly 1 |
| 12 | health/readiness behavior | **VERIFIED** — `/health` 200 + `/ready` 200 database ok under load and after recovery; during DB outage both honestly unavailable (fail-closed); automatic recovery ~150 s after postgres restart |

### Incident during P10 (reported, not hidden)

The postgres service was created **without a persistent volume** (verifier's infrastructure oversight — Railway volumes exist but were not attached). Consequence: the `serviceInstanceRedeploy` that ended the planned DB-outage window provisioned a **fresh, empty database** — the verification data created minutes earlier was destroyed. All pre-outage assertions (P1–P9, P11, race + serial) had already been captured; the outage window itself behaved fail-closed (above); and the recovery path was re-verified end-to-end on the fresh DB (register → verify → login → 201 → exact 429 → list=1). Lesson recorded: any Railway test needing persistence across restarts must attach a volume (`volumeCreate`).

### Findings for future phases (no action taken — D4+ unauthorized)

1. **OD-1 remains open**: canonical staging origin still undecided; `APP_ENV=staging` boots stay blocked (EO-008) until the owner records it and `API_ALLOWED_ORIGINS` is set. The test environment's `APP_ENV=development` classification should be ratified (or rejected) by the owner.
2. **Availability note (not a D3 defect)**: the deployed app exits on DB outage via an unhandled pg-pool error (57P01) instead of serving per-request 500s — maximally fail-closed but reduces observability; candidate for a future hardening pass (pool error handler), out of D3 scope.
3. Deployed-startCommand requirements discovered: RAILPACK installs are production-mode (runtime tools must be in `dependencies`) and the server must bind `0.0.0.0` (both already fixed on this branch).

## Owner's 12-point test plan — coverage map (combined)

| # | Point | GHA real-PG (required evidence) | Railway deployed-app (additional) |
|---|---|---|---|
| 1 | application boots | n/a (harness boots stores, not the server) | **VERIFIED** (deploy SUCCESS, `/health` 200) |
| 2 | PG connection works | **VERIFIED** (run 34755425479) | **VERIFIED** (`/ready` database ok) |
| 3 | migrations applied correctly | **VERIFIED** (0001–0005 by harness) | **VERIFIED** (env logs + fresh-DB auto-migrate on recovery) |
| 4 | normal account creation | **VERIFIED** (battery test 1) | **VERIFIED** (register→verify→login→201 exact shape) |
| 5 | quota enforcement | **VERIFIED** (battery test 1, exact 429) | **VERIFIED** (429 on 2nd create, pre- and post-recovery) |
| 6 | concurrent creation cannot exceed quota | **VERIFIED** (8-way, two service instances) | **VERIFIED** (8-way over public edge: 1×201, 7×429) |
| 7 | duplicate account behavior | **VERIFIED** (identity duplicate-email, D2 run) | **OBSERVED** (`400 VERIFICATION_RETRY_DELAY`, non-disclosing) |
| 8 | ownership isolation | **VERIFIED** (D2 run 34732967635) | **VERIFIED** (404 non-disclosing + 401 unauth + list isolation) |
| 9 | quota-exceeded response correctness | **VERIFIED** (exact message/code/details) | **VERIFIED** (byte-identical through the edge) |
| 10 | DB failure ≠ false success | **VERIFIED** (battery test 4: connection error, never false success) | **VERIFIED fail-closed** (app exit + 502s; zero false verdicts) |
| 11 | rollback leaves no partial account | **VERIFIED** (count===1 after race) | **VERIFIED** (list exactly 1 after race; nothing during outage; post-recovery 1) |
| 12 | health/readiness behavior | n/a | **VERIFIED** (200s; honest unavailability during outage; auto-recovery ~150 s) |

**Classification summary:** D3 implementation and behavior — **VERIFIED — real PostgreSQL 16.15** (GHA run 34755425479, disposable service container) for quota atomicity, exact 429 contract, concurrent-creation correctness, rollback cleanliness, and DB-failure honesty; local battery 304/304 (PGlite/memory, separate evidence class). Railway deployed-app integration — **VERIFIED COMPLETE** (staging-scoped, `86f091a3` @ `1cc057b`, real Railway PostgreSQL): all 12 plan points executed with VERIFIED outcomes except point 7 (OBSERVED — the non-disclosing duplicate contract). Railway was used strictly as a test/verification environment and is **not claimed as production-equivalent**; nothing here claims production readiness. D4/D5/D6 remain not started.
