# Phase C Increment 6 — Entitlements Inventory & Determination (read-only)

Date: 2026-09-13. Base: `41de3abb9842b7cf91061dda1e70372af09ae7c0` (increment-5
terminal, baseline 246/246 verified). Candidate selection: the Local capability
matrix's remaining C-scope rows are Dashboard (13), Entitlements (14), and
later-phase rows (15–19 = Phase H–K, stop-listed this increment; Dashboard is
also stop-listed this increment). **Row 14 — Entitlements / plans / quotas —
is the next evidenced capability in scope order.**

Evidence sources: Remote `src/modules/entitlements/entitlement.service.ts`,
`accounts.service.ts`, `accounts.repository.ts`, `tests/unit/entitlements.test.ts`,
`tests/integration/entitlements.test.ts`; PHP `api/src/Accounts/AccountController.php`;
Local `accountService.ts` (inc-2 quota port), `users.plan` (0002), kernel.

## 1. Capability determination (authorization Step 2 table)

| Question | Remote | PHP | Local | Determination |
|---|---|---|---|---|
| Does the capability exist? | YES — `EntitlementService` (104 lines) + unit (170) + integration (228) tests | PARTIAL — flat config quota `metaapi.max_accounts_per_user` (default 10), 429 ACCOUNT_QUOTA_EXCEEDED, MetaApi-tied | PARTIAL — quota logic embedded in `accountService.getPlanQuota` (inc 2), `users.plan` column, quota 429 delivered | **PORT (complete the module extraction + missing contract details)** |
| Standalone or embedded? | standalone service module, **no routes, no table** (plan lives on `users`); consumed by accounts | embedded in AccountController | embedded in accountService | extract to a standalone module (Remote-shaped), no routes/table |
| Routes? | none (service-only) | none (embedded) | none needed | no endpoints manufactured |
| Persistence? | `users.plan` (string) | `users.plan` | `users.plan` (0002, delivered) | **no migration** |
| Ownership/security? | fail-closed: DB error in getUserPlan → 503 SERVICE_UNAVAILABLE, never silent 'free' (Blocker A test); missing user/null plan → 'free' | n/a | getPlan dep silently 'free' on error (gap) | port the fail-closed invariant |
| Validation? | plan normalize (lowercase, trim); pro/enterprise → unlimited; **any unknown plan string → free/1 (SAFE-FAIL CLOSED)**; unit-tested incl. 'PRO', ' Pro ', 'ENTERPRISE', 'unknown_plan_x' | n/a | already ported (inc 2) | KEEP; pin with the full Remote unit matrix |
| Frontend/UI dependency? | none (backend service; quota errors consumed by existing accounts UI) | none | none | no UI work (migration ≠ redesign) |
| Tests/evidence? | unit + integration (concurrency `[201,429]`, provider-bypass prevention, 429 messageKey) | implicit | accountService 1 quota test; no concurrency test; **no messageKey** | port the evidenced test matrix |

## 2. Contract inventory (verified evidence vs gaps)

Verified Remote behavior (service + tests read line-by-line):
1. `getPlanQuota(planInput?)`: normalize lowercase+trim, default 'free';
   `pro`|`enterprise` → `{plan, maxTradingAccounts: Infinity, isUnlimited: true}`
   (case-insensitive, whitespace-tolerant); **everything else — including
   unknown strings — → `{plan:'free', maxTradingAccounts:1, isUnlimited:false}`**
   (SAFE-FAIL CLOSED; unit test: 'unknown_plan_x', 'vip_gold_plan').
2. `getUserPlan(userId)`: user lookup, plan normalized; missing user or null
   plan → 'free'; **store failure → 503 SERVICE_UNAVAILABLE (non-test) — the
   documented Fail-Closed Security Invariant, never a silent 'free' fallback**.
3. `checkTradingAccountEntitlement(userId, currentCount, planInput?)`: under
   quota → `{allowed:true, limit, currentCount}`; over → 429
   `ACCOUNT_QUOTA_EXCEEDED`, message `'Trading account quota exceeded. Free
   plan allows up to 1 trading account.'`, messageKey
   `'errors.accounts.quotaExceeded'`, details/params `{plan, currentCount, maxAllowed}`.
4. Prod enforcement: DB transaction + user row lock (FOR UPDATE) + count +
   check + create (atomic). **Memory/test path: per-user async mutex
   (`userLocks` promise chain) serializing check+create** — integration test
   pins concurrent `Promise.all` creation → exactly `[201, 429]`, final count 1.
5. Provider-bypass prevention: quota counts across ALL providers (integration
   test: MANUAL 201 → MT4 429 → MT5 429).
6. 429 error envelope (integration test): `error.code` ACCOUNT_QUOTA_EXCEEDED,
   `error.messageKey` 'errors.accounts.quotaExceeded'.

PHP divergence (documented, resolved in inc 2): flat config quota
`max(1, (int) Config::get('metaapi.max_accounts_per_user', 10))` — not
plan-based, tied to MetaApi account connection (Phase H). Local follows the
Remote commercial-plan model (users.plan); PHP's flat quota is NOT ported.

Local gaps vs the evidenced contract (this increment's slice):
- G1: entitlement logic embedded in accountService; no standalone module
      (Remote shape: service consumed by accounts; also the Phase-G tiers seam).
- G2: quota 429 details lack the Remote-verified messageKey.
- G3: no fail-closed 503 on plan-lookup store errors (getPlan deps currently
      swallow errors to 'free' in some wirings).
- G4: check-then-create is unsynchronized — concurrent creations can both pass
      the count check (violates the Remote-evidenced `[201,429]` invariant in
      the memory/test path; real-DB transaction+row lock stays Phase D).

## 3. Field ownership

`users.plan`: SYSTEM field owned by identity/admin (Phase G tiers); read-only
for the entitlement path (never client-settable through accounts/trades).
Quota counters: SYSTEM_DERIVED (store counts). No trade/account fields change.
ADR-002 untouched (no trades mutation).

## 4. ADR traceability

ADR-001 n/a (no financial math; `Infinity` only as an in-memory quota marker,
never serialized as a number — JSON.stringify(Infinity) → null, and the
check-result `limit` is not exposed by any route today). ADR-002 n/a. ADR-010:
apps thin, entitlement module is application-layer, no infrastructure. Phase D
boundary: real-DB transaction/row-lock guarantees NOT claimed; the per-user
mutex is explicitly the Remote-evidenced memory-path mechanism (process-local),
documented as such.

## 5. Planned slice (smallest justified)

1. `apps/api/src/entitlements/entitlementService.ts`: `getPlanQuota` (moved),
   `EntitlementService` (`getUserPlan` fail-closed via injected user lookup;
   `checkTradingAccountEntitlement`), `EntitlementError` (AccountError-shaped).
2. accountService: consume the entitlement module; 429 details gain
   `messageKey: 'errors.accounts.quotaExceeded'` (Local convention: messageKey
   embedded in details — the envelope error-object shape is frozen C-10 and
   its exact fields remain OD-3 fixture-pending; Remote's top-level messageKey
   maps into details, as already established for trades).
3. Per-user promise-chain mutex around check+create in AccountService
   (Remote memory-path parity; DB-level guarantee remains Phase D, documented).
4. Kernel: map EntitlementError in the accounts route chain (503 fail-closed).
5. server-main: accounts `getPlan` wired through `EntitlementService.getUserPlan`.
6. Tests: full Remote unit matrix (entitlementService.test.ts); accountService
   concurrency `[201,429]` + provider-bypass; HTTP 429 messageKey + concurrent
   creates; no migration; no endpoints; no UI.
