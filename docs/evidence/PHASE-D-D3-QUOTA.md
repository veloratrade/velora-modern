# Phase D — D3 Transactional Entitlements & Account Quota

**Status: GREEN — real-PG execution PASSED (GHA run 34755425479 @ 5e36d3f); Railway verification remains BLOCKED (no authenticated access).** D4/D5/D6 not started. No pass is claimed for anything that did not execute.

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

## Railway verification: BLOCKED — no access from this workspace (probed 2026-09-13)

Per the owner's environment rule, the FIRST step was identifying the connected Railway environment. Probe results (VERIFIED): **no `railway` CLI; no `RAILWAY_*` environment variables; no `~/.railway` config; no Railway files in the repo; `api.railway.app` reachable over the network but with no credentials to authenticate.** This workspace has no Railway integration available.

Consequently — per "If you cannot prove that the Railway environment is non-production, STOP" — **zero Railway-side actions were taken**: no inspection, no deploy, no migration, no environment changes, nothing persistent. To unblock, the owner must provide a connection path (Railway project/account token, or run the deploy themselves). The 6-point pre-deploy verification (project/service/environment identity, non-production proof, deployed branch/SHA, database type, data absence) will be executed and reported BEFORE any deploy or migration once access exists. The UUID included in the authorization message (`3b26e514-…`) may be the Railway project/environment ID — unconfirmed; never treated as a credential.

## Owner's 12-point test plan — coverage map

| # | Point | Status |
|---|---|---|
| 1 | application boots | server-main wiring unchanged in D3 (no code touched); re-verification belongs to the Railway step — NOT TESTED there (blocked); local boot smoke of this wiring passed in D2 |
| 2 | PG connection works | battery harness connected via real PG — **VERIFIED — real PostgreSQL (run 34755425479)** |
| 3 | migrations applied correctly | 0001–0005 applied by the harness on real PG — **VERIFIED — real PostgreSQL (run 34755425479)** |
| 4 | normal account creation | battery test 1 — **VERIFIED — real PostgreSQL (run 34755425479)** |
| 5 | quota enforcement | battery test 1 (exact 429 contract) — **VERIFIED — real PostgreSQL (run 34755425479)** |
| 6 | concurrent creation cannot exceed quota | battery test 2 (8-way, two service instances, DB-only serialization) — **VERIFIED — real PostgreSQL (run 34755425479)** |
| 7 | duplicate account behavior | unchanged code paths; identity-level duplicate-email behavior already VERIFIED real PG (D2 run) |
| 8 | ownership isolation | unchanged code paths, VERIFIED real PG in D2 (run 34732967635) and re-run on next dispatch |
| 9 | quota-exceeded response correctness | exact message/code/details asserted and passing — **VERIFIED — real PostgreSQL (run 34755425479)** |
| 10 | DB failure ≠ false success | battery test 4 (dead DB → connection error, never a success or quota verdict) — **VERIFIED — real PostgreSQL (run 34755425479)** |
| 11 | rollback leaves no partial account | count===1 after the race; losers' rollbacks left nothing — **VERIFIED — real PostgreSQL (run 34755425479)** |
| 12 | health/readiness behavior | unchanged wiring; Railway step will verify when unblocked — NOT TESTED |

**Classification summary:** D3 implementation and behavior — **VERIFIED — real PostgreSQL 16.15** (GHA run 34755425479, disposable service container) for quota atomicity, exact 429 contract, concurrent-creation correctness, rollback cleanliness, and DB-failure honesty; local battery 304/304 (PGlite/memory, separate evidence class). Railway — **BLOCKED** (no authenticated access; zero Railway-side actions). Points 1 and 12 of the test plan (boot/health in a deployed environment) remain Railway-scope NOT TESTED. Nothing here claims production readiness, and Railway is not claimed as production-equivalent.
