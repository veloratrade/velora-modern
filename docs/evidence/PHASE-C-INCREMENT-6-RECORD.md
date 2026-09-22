# Phase C Increment 6 Record — Entitlements / Plans / Quotas (2026-09-13)

**Scope:** Entitlements capability only (capability-matrix row 14, PORT).
Start HEAD `41de3abb9842b7cf91061dda1e70372af09ae7c0` (verified: branch, clean
tree, main/snapshot untouched, 0 remotes, baseline 246/246 before any change;
`npm ci` + dependency-order rebuild after workspace restore — snapshot-excluded
`dist`/`node_modules`, known environment property). Inventory:
`docs/reconciliation/PHASE-C-INC6-ENTITLEMENTS-INVENTORY.md`.

| # | Commit | Content |
|---|---|---|
| 1 | `cce6139` | entitlements inventory + determination (read-only) |
| 2 | `eb3600c` | entitlement module + fail-closed plan lookup + quota serialization + messageKey + the Remote test matrix |
| 3 | this commit | evidence record + matrix row 14 update + AGENTS.md row |

## 1. Capability determination

- **Remote:** standalone `EntitlementService` (service-only: no routes, no
  table; plan on `users`) + a 170-line unit matrix and 228-line integration
  suite. Fully implemented.
- **PHP:** partial/divergent — flat config quota `metaapi.max_accounts_per_user`
  (default 10), 429 ACCOUNT_QUOTA_EXCEEDED, MetaApi-tied (Phase H). NOT ported
  (documented divergence; the Remote commercial-plan model won in increment 2).
- **Local before:** quota logic embedded in `accountService` (inc 2), plan
  column delivered (0002), but no standalone module, no 429 messageKey, no
  fail-closed 503 on plan-lookup errors, unsynchronized check-then-create.
- **Determination: PORT — complete the module extraction + the missing
  contract details.** No entity/route/table invented (no migration needed).

## 2. Implemented (this increment)

| Behavior | Status | Evidence | Tests |
|---|---|---|---|
| `getPlanQuota` — normalize (lowercase/trim/default free); pro\|enterprise unlimited; unknown plans SAFE-FAIL CLOSED to free/1 | DONE (moved to the Remote-shaped module; behavior from inc 2 preserved) | Remote unit matrix ('free'/null/undefined/''/PRO/' Pro '/ENTERPRISE/'unknown_plan_x'/'vip_gold_plan') | entitlementService 9 |
| `getUserPlan` — missing user/null/empty plan → 'free'; normalized | DONE | Remote service + unit tests | entitlementService |
| `getUserPlan` FAIL-CLOSED — store error → 503 SERVICE_UNAVAILABLE, never silent 'free' | DONE (was a Local gap G3) | Remote "Blocker A" unit test | entitlementService |
| `checkTradingAccountEntitlement` — allow `{allowed, limit, currentCount}` / over → 429 ACCOUNT_QUOTA_EXCEEDED + messageKey + `{plan, currentCount, maxAllowed}` | DONE | Remote unit + integration tests | entitlementService |
| Quota 429 messageKey `errors.accounts.quotaExceeded` on the accounts path | DONE (was G2) | Remote integration test envelope assertions | accountService 2, accountRoutes 2 |
| Concurrent creation serialization — per-user mutex around check+create; exactly-one-winner `[201, 429]` | DONE (was G4) | Remote memory-path `userLocks` + integration "Blocker B" test | accountService (3-way Promise.all), accountRoutes (HTTP Promise.all, final count 1) |
| Provider-bypass prevention — quota counts across MANUAL/MT4/MT5 | DONE | Remote integration test | accountService, accountRoutes |
| Kernel EntitlementError mapping (503 fail-closed surfaces correctly) | DONE | Remote fail-closed invariant | typecheck + battery |
| server-main getPlan via EntitlementService (fail-closed) | DONE | Remote invariant | wiring |

**MessageKey placement (documented divergence mapping):** Remote carries
`messageKey` top-level on the error object; the Local envelope is the frozen
C-10 PHP contract whose error-object exact fields remain OD-3 fixture-pending,
so the established Local convention embeds messageKey in `details` (trades
precedent). Same value, same evidence; different placement — not called parity
at the envelope level.

## 3. ADR traceability

ADR-001 n/a (no financial math; `Infinity` is an in-memory quota marker only —
`JSON.stringify(Infinity)` → null, and no route exposes the check result).
ADR-002 untouched (no trades mutation). ADR-010: application-layer module, no
infrastructure. **Phase D boundary preserved:** the per-user mutex is
explicitly the Remote-evidenced memory-path mechanism (process-local); the
production guarantee (DB transaction + user row lock) remains Phase D and is
never claimed. PGlite/real-PostgreSQL tiers unchanged (real PG: NOT
IMPLEMENTED — Phase D).

## 4. Tests (exact, on committed tree)

| Command | Result |
|---|---|
| `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` | 0 errors |
| `npm test` | **259/259** (entitlementService 9 NEW, accountService 8, accountRoutes 7, + prior 235) |
| `npm run test:migrations` | 5/5 (no new migration — nothing to persist) |
| `npx tsx tools/parity-smoke.ts` | 6 pass / 0 fail |
| `bash tools/secret-scan.sh` | PASS (0 findings) |
| lint | N/A — no lint script in repo |

## 5. Security — NO REGRESSION

Fail-closed hardening ADDED (plan-lookup store errors now 503 instead of
potentially silent 'free'); no new routes; no client-controlled ownership
(plan is read from the authenticated user's record only); auth/ownership/
non-disclosure/body-size/fail-closed controls unchanged and re-verified by the
full battery; secret scan 0 findings.

## 6. Open items (evidence-backed only)

- **Phase G (tiers):** plan management/upgrade flows, additional quota
  dimensions (Remote models only `maxTradingAccounts` today), entitlement
  caching — no current evidence, deferred.
- **Phase D:** real-PostgreSQL transaction + row-lock quota enforcement
  (Remote prod path), real-PG entitlement verification.
- **Phase H:** PHP flat MetaApi quota (`metaapi.max_accounts_per_user`,
  default 10) applies to connect-metaapi paths — revisit with MetaAPI.
- **OD-3 fixture-pending:** exact PHP error-object fields (top-level
  messageKey vs details embedding) — unchanged.

## 7. Git evidence

Branch `reconcile/foundation-first`; start `41de3ab` (clean) → end = this
commit; tree clean at close. `main` (`07977504…`) and tag
`remote-snapshot-99e024c829db` (tree `83621817…`) untouched; 0 remotes.
Push **NO**; merge **NO**; deployment **NO**.
