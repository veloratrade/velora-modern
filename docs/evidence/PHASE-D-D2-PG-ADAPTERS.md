# Phase D — D2 Real-PostgreSQL Adapter Evidence Record

**Status: GREEN — all four store batteries pass on real PostgreSQL 16.15** (VERIFIED — real PostgreSQL, GitHub Actions service container; PGlite results never used as proof)

## Final green run

| Field | Value |
|---|---|
| Workflow run | `34732967635` — https://github.com/veloratrade/velora-modern/actions/runs/34732967635 |
| Commit under test (`head_sha`) | `76713647612779e8102939b5ec6b11a636fb6642` |
| Run window | 2026-09-13T02:24:24Z → 02:24:56Z, conclusion **success** (all steps) |
| Database | disposable `postgres:16-alpine` service container — **PostgreSQL 16.15** — test-only credentials, destroyed with the job; no production/staging system touched; no real user data; no secrets |
| D1 smoke (S1–S9) | re-confirmed PASS (verbatim: `PASS S1a server_version = PostgreSQL 16.15`, `PG-SMOKE: ALL CHECKS PASSED on real PostgreSQL`) |
| D2 store batteries | **26/26 pass — 0 fail — 0 skipped** (skipped=0 proves DATABASE_URL reached the batteries; the SKIP path would otherwise exit green) |

Per-battery TAP counts from the raw run log: pgUserStore **6/6**, pgAccountStore **3/3**, pgTradeStore **11/11**, pgRateLimitStore **6/6**.

## Run ledger — every attempt, root causes classified per the owner's rule

| Run | Commit | Result | Root cause (classification) |
|---|---|---|---|
| 34732496174 | `9452fb2` | D2 step fail (pgUserStore 5/6) | **TEST HARNESS** — verification count-since asserted fixed future-dated boundaries (09:00Z) against DB-server-generated `created_at` (runner clock 02:13Z) → 0 !== 2. Fix: boundaries anchored to the store's own returned timestamps. |
| 34732659194 | `baaf41a` | D2 step fail (pgAccountStore 2/3) | **TEST HARNESS** — absolute count on a user carrying rows from an earlier test in the same file → 9 !== 8. Fix: relative counting (before + 8). |
| 34732875535 | `cbd855a` | D2 step fail (pgTradeStore 8/11) | **APPLICATION CODE (real adapter bug)** — `cancelExit` returned the row as read BEFORE the tombstone UPDATE → `deletedAt: null` instead of the tombstone time (guidance adapter returns `event.at`; the mapExit refactor dropped it). DB state was correct; only the returned record lied. **Fixed in the adapter; the catching test assertion is byte-identical after the fix.** Plus **TEST HARNESS** ×2 (raw int8 compared `===` to a number — pg returns int8 as string; array compared with `assert.equal` instead of `deepEqual`). |
| **34732967635** | **`7671364`** | **GREEN** | — |

Also fixed proactively after the run-2 audit (before run 3, no extra run burned): trades-search test isolation (dedicated fresh user — earlier tests leave active trades on the shared owner) and the rate-limit composition test key (must be a REAL `RateLimitKey` — the limiter looks policy up by key; an unknown key would throw).

**No test was weakened at any point.** The assertion that caught the adapter bug is unchanged; every other fix made assertions clock- and state-independent while testing the same semantics.

## What the D2 batteries prove on real PostgreSQL 16.15 (all VERIFIED — real PG)

- **PgUserStore**: full lifecycle; sessions (rotate/revoke/revoke-all); verifications (create/count-since/latest/consume/delete); preferences (locale patch, aiConsentAt set/null-clear, email-prefs default + upsert); **23505 `users_email_unique` → `UserEmailExistsError`** via the pg error object; **6-way concurrent duplicate email → exactly one winner, 5 domain errors, one row**.
- **PgAccountStore**: SQL-level ownership isolation on every read/write; newest-first listing; count from the real table; **CHECK violations surface as SQLSTATE 23514**; **rowCount-based delete boolean** (true once, false after, ownership-scoped); exact counting under 8-way concurrent creation.
- **PgTradeStore (ADR-002 ledger)**: projection + `TRADE_CREATED` event atomicity; ownership isolation; **tombstones only — rows never physically deleted**; **version CAS → `TradeVersionConflictError` with zero partial state (no event, no update)**; journaling null-clear law; **`velora_apply_exit` allocation + over-allocation → `TradeOverAllocationError` with FULL rollback** (allocation, version, exit row, and event all unchanged); **cancelExit tombstone + allocation decrement + version bump atomically** (returned record carries the tombstone time); NUMERIC(20,8)/(20,2) exact scale-padded strings end-to-end (ADR-001); search filters / journal-q / sort whitelist / pagination on the real planner; **concurrent recordExit (same CAS version): row lock + trigger serialize — exactly one winner, no over-allocation, no lost event**; **concurrent editJournaling: exactly one CAS winner**; not-found/foreign → domain `TradeStoreError`, never a driver leak.
- **PgRateLimitStore**: PHP-parity window semantics (anchored first hit, preserved on increment, own-window expiry reset, exactly-at-edge keeps the window); longer-policy bucket not shortened by another bucket's window; 48h hygiene sweep; **12-way concurrent hits on one fresh bucket → exactly 1..12, no lost or duplicated increments** (the atomic single-statement `ON CONFLICT … RETURNING` shape, D1 risk R6); `FixedWindowRateLimiter` composition blocks at limit+1 with Retry-After 300 (`auth:login`, C-14 values).

## D2 changes (branch `reconcile/foundation-first`, base `b9b5284`)

Commits: `9452fb2` (adapters + batteries + wiring + deps), `baaf41a`, `cbd855a` (test determinism), `7671364` (cancelExit adapter fix + 2 test fixes).

| File | Change |
|---|---|
| `apps/api/src/persistence/pg.ts` | NEW — shared QueryFn, `withTransaction` (BEGIN/COMMIT/ROLLBACK, rollback-on-error, always-release), SQLSTATE helpers (23505/23514), ISO mappers |
| `apps/api/src/auth/pgUserStore.ts` | NEW — real-PG UserStore (23505 → domain error) |
| `apps/api/src/accounts/pgAccountStore.ts` | NEW — real-PG AccountStore (rowCount delete boolean) |
| `apps/api/src/trades/pgTradeStore.ts` | NEW — real-PG TradeStore (ledger/CAS/trigger/tombstones; parameterized LIMIT/OFFSET) |
| `apps/api/src/ratelimits/pgRateLimitStore.ts` | NEW — real-PG RateLimitStore (atomic single-statement upsert) |
| `apps/api/src/server-main.ts` | `PERSISTENCE=postgres` → Pg* adapters over one shared pool; memory remains dev-only (S8 gate unchanged); limiter rides configured persistence |
| `apps/api/package.json` + lockfile | `pg ^8.12.0` declared (D1 R10 hygiene fix; hoisted 8.23.0 deduped with worker) |
| `tools/run-tests.mjs` | `*.pg.test.ts` excluded from the local battery (evidence separation) |
| `db/tests/pg{User,Account,Trade,RateLimit}Store.pg.test.ts` | NEW — 26 real-PG tests, env-gated (SKIP without DATABASE_URL, verified locally) |
| `.github/workflows/postgres-evidence.yml` | D2 battery step (sequential, same disposable container) |

Memory and PGlite adapters untouched and still the dev/test-local path. No ORM anywhere. Ports unchanged.

## Local verification on the final tree

typecheck 0 errors · battery **304/304** (33 files, 0 skipped — unchanged) · migrations **5/5** · `.pg` SKIP paths 6/3/11/6 skipped, 0 fail · boot smoke: memory mode boots (`db: missing`); postgres mode with dead DATABASE_URL boots and stays honestly red, never crashes (S2/S8 posture) · secret-scan **PASS**.

## What this does NOT prove (scope boundaries — do not silently cross)

- **D3**: transactional entitlements/account quota (users-row `FOR UPDATE`, atomic count+create). The concurrent-create test proves exact counting only, not quota serialization.
- **D4**: full trade-concurrency verification beyond the store-level races proven here.
- **D5**: `db/roles.sql` privilege layer (still applied by nothing) and the full application battery on real PG.
- **D6**: consolidated real-PG evidence across all phases.
- PGlite battery results remain in-wasm evidence only; the `.pg` batteries run exclusively in the `postgres-evidence` workflow.

## Observations for the record (no action taken without owner direction)

1. `createVerification`'s `input.createdAt` is not persisted by DB adapters (column DEFAULT `now()` instead) — identical to the PGlite-evidenced guidance; the memory adapter uses it for deterministic tests; services pass real clocks, so observable behavior is the same. Port-clarity note only.
2. Each dispatch required the temporary default-branch switch (~3 s window, restored immediately, main content untouched) — GitHub's documented `workflow_dispatch` default-branch rule; direct API dispatch returns 404 otherwise.
3. GitHub Actions was already enabled repo-wide before this session (verified via `/actions/permissions`); the owner may re-disable it per the cost policy now that the evidence window is closed. Public-repo standard runner minutes are free.
4. The owner-provided token was used transiently (push + dispatch + read-only run/log access), never written to any file or git config; rotation recommended since it transited chat.
