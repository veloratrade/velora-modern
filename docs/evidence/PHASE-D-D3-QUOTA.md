# Phase D — D3 Transactional Entitlements & Account Quota

**Status: IMPLEMENTED + LOCALLY VERIFIED — real-PG execution NOT TESTED (blocked), Railway verification BLOCKED (no access).** No pass is claimed for anything that did not execute. D4/D5/D6 not started.

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

## Real-PG execution: NOT TESTED — BLOCKED (mechanical)

The `postgres-evidence` workflow must run the new battery, but the GitHub token from the D2 session did not survive the sandbox restore (`/tmp` is ephemeral by design; the token was intentionally never written into the workspace or any file). Push + dispatch require owner action: re-provide a token (transient use, rotate after) or push `3a73d2d`+ and dispatch `postgres-evidence` manually. Until that run is green, every D3 real-PG claim stays NOT TESTED.

## Railway verification: BLOCKED — no access from this workspace (probed 2026-09-13)

Per the owner's environment rule, the FIRST step was identifying the connected Railway environment. Probe results (VERIFIED): **no `railway` CLI; no `RAILWAY_*` environment variables; no `~/.railway` config; no Railway files in the repo; `api.railway.app` reachable over the network but with no credentials to authenticate.** This workspace has no Railway integration available.

Consequently — per "If you cannot prove that the Railway environment is non-production, STOP" — **zero Railway-side actions were taken**: no inspection, no deploy, no migration, no environment changes, nothing persistent. To unblock, the owner must provide a connection path (Railway project/account token, or run the deploy themselves). The 6-point pre-deploy verification (project/service/environment identity, non-production proof, deployed branch/SHA, database type, data absence) will be executed and reported BEFORE any deploy or migration once access exists. The UUID included in the authorization message (`3b26e514-…`) may be the Railway project/environment ID — unconfirmed; never treated as a credential.

## Owner's 12-point test plan — coverage map

| # | Point | Status |
|---|---|---|
| 1 | application boots | server-main wiring unchanged in D3 (no code touched); re-verification belongs to the Railway step — NOT TESTED there (blocked); local boot smoke of this wiring passed in D2 |
| 2 | PG connection works | battery harness connects via real PG — NOT TESTED (dispatch blocked) |
| 3 | migrations applied correctly | battery harness runs 0001–0005 — NOT TESTED (dispatch blocked); D2 runs 34732967635 proved the set on real PG 16.15 |
| 4 | normal account creation | battery test 1 — NOT TESTED (dispatch blocked) |
| 5 | quota enforcement | battery test 1 (exact 429 contract) — NOT TESTED (dispatch blocked) |
| 6 | concurrent creation cannot exceed quota | battery test 2 (8-way, two service instances, DB-only serialization) — NOT TESTED (dispatch blocked) |
| 7 | duplicate account behavior | unchanged code paths; identity-level duplicate-email behavior already VERIFIED real PG (D2 run) |
| 8 | ownership isolation | unchanged code paths, VERIFIED real PG in D2 (run 34732967635) and re-run on next dispatch |
| 9 | quota-exceeded response correctness | battery tests 1–2 assert the exact message/code/details — NOT TESTED (dispatch blocked) |
| 10 | DB failure ≠ false success | battery test 4 (dead DB → connection error, never a success or quota verdict) — NOT TESTED (dispatch blocked) |
| 11 | rollback leaves no partial account | battery test 2 (count===1 after the race; losers' rollbacks leave nothing) — NOT TESTED (dispatch blocked) |
| 12 | health/readiness behavior | unchanged wiring; Railway step will verify when unblocked — NOT TESTED |

**Classification summary:** implementation and local verification VERIFIED (local/PGlite where stated); every real-PG D3 claim NOT TESTED (dispatch blocked); Railway BLOCKED (no access). This record will be updated with run IDs when execution is unblocked — nothing here claims production readiness, and Railway is not claimed as production-equivalent.
