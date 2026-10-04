# RBAC capability map — Legacy's 24 permissions → Modern (SEC-01)

**Status of this document:** the authoritative answer to "what does each Legacy permission *mean*, who holds it, where is it enforced in Modern, and what proves it". It is kept honest by a test, not by intention: `apps/api/src/auth/rbacCapabilityMap.test.ts` reads **this file**, cross-checks every permission id against `packages/contracts/src/rbac.ts` and the Legacy constant list, and fails if a row is missing, duplicated, or claims an enforcement point that does not exist.

**Source of the Legacy side:** `api/src/Auth/Role.php` @edede31 (24 `P_*` constants; `permissionMap()` grants 18 to `admin` and 24 to `super_admin`; `can()` is a flat membership test with a fail-closed `?? []`).

**The Modern model is deliberately a different shape, and that is a decision, not a gap:**
Modern has three application roles (`user`, `admin`, `super_admin`) plus a separate **installation ownership** flag. It enumerates only permissions that guard a REAL operation. Declaring a grant for an operation that does not exist would fabricate an authorization surface and invite false confidence, so the deferred vocabulary is recorded here — with the reason — instead of being enforced in `rbac.ts`.

**Owner column** = the roles holding it: `SA` = super_admin only, `A` = admin + super_admin, `OWNER` = the System Owner satisfies it regardless of stored role (orthogonal to RBAC, `canAct()`).

---

## Part 1 — the 24 Legacy permissions

| # | Legacy permission | Meaning (what the operation does) | Owner | Modern status | Modern enforcement point | Evidence / test |
|---|---|---|---|---|---|---|
| 1 | `overview.view` | Read the admin overview KPIs | A | **ENFORCED** | `GET /api/v1/admin/metrics` → `admin.panel.access` | `migratedRoutes.test.ts` ("admin routes require the admin.panel.access authority"), `rbacRoutes.test.ts` |
| 2 | `users.view` | List/inspect user accounts (never secrets) | A | **ENFORCED** | `GET /api/v1/admin/users`, `GET /api/v1/admin/users/{id}`, and (SEC-03) `GET /api/v1/admin/users/{id}/login-history` — all dispatched from `kernel/server.ts` → `users.view` | `adminUserRoutes.test.ts`, `loginHistoryRoutes.test.ts`, `rbac.test.ts` |
| 3 | `users.suspend` | Suspend an account | A | **ENFORCED (merged)** | `PATCH /api/v1/admin/users/{id}/status` → `users.manage_status`. Modern merged suspend+activate into one status operation with a validated target status, because Legacy's two permissions guarded the two directions of ONE column (`users.status`) and separating them adds a failure mode (a role that may suspend but not unsuspend) without adding a capability | `adminUserRoutes.test.ts` |
| 4 | `users.activate` | Reactivate a suspended account | A | **ENFORCED (merged)** | same as row 3 | `adminUserRoutes.test.ts` |
| 5 | `users.change_role` | Change another user's application role | SA | **ENFORCED** | `PATCH /api/v1/admin/users/{id}/role` → `users.change_role`; the pair-rules (self-action, privileged-target) are enforced in the service | `adminUserRoutes.test.ts`, `rbac.test.ts` ("users.change_role is the super_admin-exclusive permission") |
| 6 | `users.manage_subscription` | Change a user's plan/subscription state | A | **PARTIAL** — subscription capability exists (`billing/subscriptionService.ts`, `PATCH`-equivalent admin path pending) | not yet permission-gated in Modern | capability matrix `PLT-11` |
| 7 | `users.verify_email` | Admin-triggered e-mail verification | A | **PARTIAL** — the operation exists (`markEmailVerified` in the user store; used by the verification flow) but has no admin route/permission yet | not yet permission-gated in Modern | capability matrix `ADM-02` |
| 8 | `users.create` | Create a user from the admin panel (privileged roles additionally require `users.change_role`) | A | **PARTIAL** — registration exists; the ADMIN create path does not | not yet permission-gated in Modern | capability matrix `ADM-01` (PARTIAL) |
| 9 | `audit.view` | Read the audit trail | A | **PARTIAL** — the trail exists and is written (`audit_log`, 13 actions) and `GET /api/v1/admin/audit-logs` exists; the permission that guards it is `admin.panel.access` rather than a dedicated `audit.view` | `admin.panel.access` (interim) | `migratedRoutes.test.ts` |
| 10 | `audit.view_sensitive` | See raw IP / user-agent in security listings | SA | **ENFORCED (SEC-03)** | `GET /api/v1/admin/users/{id}/login-history`: the raw fields are **omitted from the response body** for anyone who is not `super_admin`/System Owner | `loginHistoryRoutes.test.ts` ("the raw address fields are absent for an admin and present for super_admin") |
| 11 | `system.health.view` | Read system health | A | **PARTIAL** — `/api/v1/health` + `/ready` are public-by-design probes, not an admin surface | not permission-gated (public probe by contract) | `boot.test.ts`, `dbProbe.test.ts` |
| 12 | `system.logs.view` | Read system logs | A | **MISSING** — no log-viewer capability in Modern | — | capability matrix `ADM-03` |
| 13 | `settings.view` | Read system settings (Legacy: reserved, Module K) | A | **NOT DECLARED** — Legacy never shipped the surface; Modern declares no grant for a nonexistent operation | — | this file, §"Deferred vocabulary" |
| 14 | `system.settings.manage` | Change system settings (Legacy: reserved) | SA | **NOT DECLARED** — same reason | — | this file |
| 15 | `communication.view` | Read the support/communication centre | A | **PARTIAL** — support capability is Phase 5 | — | capability matrix `SUP-01`, `SUP-02` |
| 16 | `communication.reply` | Reply / change ticket state | A | **PARTIAL** — same | — | capability matrix `SUP-02` |
| 17 | `billing.view` | Read subscription/billing observability | A | **PARTIAL** — subscription state exists; the admin read surface is pending | — | capability matrix `PLT-11` |
| 18 | `feature_flags.view` | Read feature flags | A | **NOT DECLARED** — no flag capability in Modern | — | this file |
| 19 | `feature_flags.edit` | Toggle feature flags (server-authoritative runtime switches) | SA | **NOT DECLARED** — same reason | — | this file |
| 20 | `integrations.view` | Read integration configuration (Legacy: reserved, Module H) | A | **PARTIAL** — MetaAPI provisioning + Telegram exist as capabilities; no admin configuration surface | — | capability matrix `PLT-14` |
| 21 | `integrations.manage` | Change integration configuration | SA | **NOT DECLARED** — same reason | — | this file |
| 22 | `analytics.view` | Read product/operational analytics | A | **PARTIAL** — user-facing analytics exist; the ADMIN analytics surface is pending | — | capability matrix `ADM-04` |
| 23 | `aiManage` | Configure AI behaviour (Legacy naming: non-dotted to avoid the `ai.*` i18n namespace) | A | **NOT DECLARED** — Phase 7 owns the AI surface; the consent capability (`ai_consent`) is user-scoped, not admin-scoped | — | this file |
| 24 | `aiRouteManage` | Configure AI routing (provider/model selection) | SA | **NOT DECLARED** — same reason | — | this file |

### Modern-only permissions (no Legacy counterpart)

These three exist because Modern's admin surface needs them; they are NOT Legacy permissions renamed, and the distinction matters when reading the table above.

| Permission | Meaning | Owner | Enforcement point | Evidence |
|---|---|---|---|---|
| `rbac.self.view` | Read the caller's own effective role + permission set (diagnostic) | every authenticated role | `GET /api/v1/admin/rbac/self` | `rbacRoutes.test.ts` |
| `admin.panel.access` | Read-only administrative visibility that the panel entry point requires | A | `GET /api/v1/admin/metrics`, `GET /api/v1/admin/audit-logs` | `migratedRoutes.test.ts` |
| `rbac.matrix.view` | Inspect the effective authority of ANY role | SA | `GET /api/v1/admin/rbac/matrix` | `rbacRoutes.test.ts` |

---

## Part 2 — the invariants, and where each is proven

| Invariant | Statement | Proof |
|---|---|---|
| Explicit enumeration | every grant is written out for every role; no inheritance operator exists | `packages/contracts/src/rbac.test.ts` ("the permission map covers every role explicitly") |
| Proven hierarchy | `super_admin ⊇ admin ⊇ user` holds as a property of the tables, not as a runtime rule | `rbac.test.ts` ("hierarchy … holds as a PROVEN property") |
| Fail closed | an unknown role, a tampered value, `null`, a prototype-chain key: all yield NO permission | `rbac.test.ts` ("FAIL CLOSED", "prototype-chain keys cannot be smuggled in") |
| No self-elevation | a plain `admin` cannot reach a super_admin-only permission | `rbac.test.ts` ("admin cannot reach super_admin-only permissions") |
| Plan never authorizes | `plan`/subscription drives QUOTA only and grants no permission | `entitlementService.ts` + `rbac.test.ts` header contract |
| Ownership is not a role | the System Owner satisfies every permission, and ownership is never a token claim | `rbac.test.ts` ("owner authority"), `systemOwnerAuthority.test.ts` |
| Every privileged route is gated | an administrative route resolves authority from storage and refuses without the permission | `adminUserRoutes.test.ts`, `rbacRoutes.test.ts`, `loginHistoryRoutes.test.ts` |

## Part 3 — deferred vocabulary, and the rule that governs it

A Legacy permission is left **NOT DECLARED** in Modern when:
1. the operation it guards does not exist in Modern yet, **and**
2. declaring it would create a permission that guards nothing.

The rule that keeps this honest: **a capability brings its permission with it.** When Phase 5 (support), 6 (admin), 7 (AI) or 9 (secondary) lands a real operation, that change must add the permission, its grant row, its enforcement point and its test **in the same commit**, and then move the row above from NOT DECLARED/PARTIAL to ENFORCED. The guard test fails if a row claims an enforcement point that is not backed by a real route or by a `PERMISSIONS` entry, so this document cannot quietly drift ahead of the code.
