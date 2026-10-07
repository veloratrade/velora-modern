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
| 1 | `overview.view` | Read the admin overview KPIs | A | **ENFORCED** | `GET /api/v1/admin/overview` → `overview.view` (Phase 6: the composed operator dashboard — platform counts plus their user / trading / Telegram / support breakdowns). The panel entry point `GET /api/v1/admin/metrics` keeps → `admin.panel.access` | `adminConsoleRoutes.test.ts`, `migratedRoutes.test.ts` ("admin routes require the admin.panel.access authority"), `rbacRoutes.test.ts` |
| 2 | `users.view` | List/inspect user accounts (never secrets) | A | **ENFORCED** | `GET /api/v1/admin/users`, `GET /api/v1/admin/users/{id}`, and (SEC-03) `GET /api/v1/admin/users/{id}/login-history` — all dispatched from `kernel/server.ts` → `users.view` | `adminUserRoutes.test.ts`, `loginHistoryRoutes.test.ts`, `rbac.test.ts` |
| 3 | `users.suspend` | Suspend an account | A | **ENFORCED (merged)** | `PATCH /api/v1/admin/users/{id}/status` → `users.manage_status`. Modern merged suspend+activate into one status operation with a validated target status, because Legacy's two permissions guarded the two directions of ONE column (`users.status`) and separating them adds a failure mode (a role that may suspend but not unsuspend) without adding a capability | `adminUserRoutes.test.ts` |
| 4 | `users.activate` | Reactivate a suspended account | A | **ENFORCED (merged)** | same as row 3 | `adminUserRoutes.test.ts` |
| 5 | `users.change_role` | Change another user's application role | SA | **ENFORCED** | `PATCH /api/v1/admin/users/{id}/role` → `users.change_role`; the pair-rules (self-action, privileged-target) are enforced in the service | `adminUserRoutes.test.ts`, `rbac.test.ts` ("users.change_role is the super_admin-exclusive permission") |
| 6 | `users.manage_subscription` | Change a user's plan/subscription state | A | **PARTIAL** — subscription capability exists (`billing/subscriptionService.ts`, `PATCH`-equivalent admin path pending) | not yet permission-gated in Modern | capability matrix `PLT-11` |
| 7 | `users.verify_email` | Admin-triggered e-mail verification | A | **ENFORCED** (Phase 6) | `POST /api/v1/admin/users/{id}/email-verification` → `users.verify_email`. Idempotent: verifying an already-verified address returns `changed:false` and writes **no** audit row, because nothing changed | `adminConsoleRoutes.test.ts`, `db/tests/adminConsole.pg.test.ts` |
| 8 | `users.create` | Create a user from the admin panel (privileged roles additionally require `users.change_role`) | A | **PARTIAL** — registration exists; the ADMIN create path does not | not yet permission-gated in Modern | capability matrix `ADM-01` (PARTIAL) |
| 9 | `audit.view` | Read the audit trail | A | **ENFORCED (split, Phase 6)** | The platform-wide signup/login feeds `GET /api/v1/admin/security/{signups,logins}` → `audit.view`. The append-only trail read `GET /api/v1/admin/audit-logs` (filters `action`, `actorUserId`, `targetUserId`, `before`, `since`, `until`, with `beforeState`/`afterState`) stays on → `admin.panel.access`, the panel-entry permission that already guarded it, so there is exactly ONE implementation of "read the trail" that the console's Audit tab and the user-360 record both call. `admin` and `super_admin` hold both permissions and no other role holds either, so the effective authority is identical | `adminConsoleRoutes.test.ts`, `migratedRoutes.test.ts`, `db/tests/extendedCapabilities.pg.test.ts` |
| 10 | `audit.view_sensitive` | See raw IP / user-agent in security listings | SA | **ENFORCED (SEC-03 + Phase 6)** | `GET /api/v1/admin/users/{id}/login-history` and the Phase 6 console feeds `GET /api/v1/admin/security/{signups,logins}`: `ipAddress`/`userAgent` are **omitted from the response body** (not nulled) for anyone who is not `super_admin`/System Owner, and the console labels the omission instead of showing a blank | `loginHistoryRoutes.test.ts` ("the raw address fields are absent for an admin and present for super_admin"), `adminConsoleRoutes.test.ts`, `db/tests/adminConsole.pg.test.ts`, browser QA `docs/audits/phase6-ui/` ("no IP address is rendered to a plain admin") |
| 11 | `system.health.view` | Read system health | A | **ENFORCED** (Phase 6) | `GET /api/v1/admin/system/health` → `system.health.view`: nine attested components (database, migrations, api, rate_limiter, worker, email, ai_provider, metaapi, n8n_relay) with latency thresholds and the migration head. A component Modern has not built is reported `not_applicable` **with its phase reason** — never a green check. The public probes `/api/v1/health` + `/ready` stay public by contract and are a different surface | `adminConsoleRoutes.test.ts`, `adminConsoleService.test.ts`, `db/tests/adminConsole.pg.test.ts` |
| 12 | `system.logs.view` | Read system logs | A | **ENFORCED** (Phase 9, AC-44) | `GET /api/v1/admin/logs/system` → `system.logs.view` (append-only, severity/source/q/pagination, newest-first) | `adminPlatformRoutes.test.ts`, `adminPlatformService.test.ts`, `db/tests/adminPlatform.pg.test.ts` |
| 13 | `settings.view` | Read system settings (Legacy: reserved, Module K) | A | **ENFORCED** (Phase 9, AC-44) | `GET /api/v1/admin/settings` → `settings.view` (supervisory inventory, never secrets, strict-allowlist) | `adminPlatformRoutes.test.ts`, `adminPlatformService.test.ts`, `db/tests/adminPlatform.pg.test.ts` |
| 14 | `system.settings.manage` | Change system settings (Legacy: reserved) | SA | **ENFORCED** (Phase 9, AC-44) | `PUT/DELETE /api/v1/admin/settings/{key}` → `system.settings.manage` (only `platform.default_locale` ∈ {fa,en}, audited) | `adminPlatformRoutes.test.ts`, `adminPlatformService.test.ts`, `db/tests/adminPlatform.pg.test.ts` |
| 15 | `communication.view` | Read the support/communication centre | A | **ENFORCED (renamed, Phase 5)** | `GET /api/v1/admin/communications/tickets` (+ `?status&waiting_for&unread&q&page`) and `GET /api/v1/admin/communications/tickets/{id}` → `support.tickets.view`. Modern names the permission after the capability it guards; the grant shape is Legacy's (both `admin` and `super_admin`) | `supportRoutes.test.ts`, `db/tests/supportTickets.pg.test.ts` |
| 16 | `communication.reply` | Reply / change ticket state | A | **ENFORCED (renamed, Phase 5 + Phase 6 UI)** | `POST /api/v1/admin/communications/tickets/{id}/messages` (`{message, internal}`) and `POST …/{id}/status` (`close` / `archive` / `reopen`) → `support.tickets.manage`. The service owns the state machine (archive only from `closed`, reopen only from `closed`/`archived`, no reply to an `archived` ticket) and the Phase 6 console renders only the transitions it allows | `supportRoutes.test.ts`, `supportService.test.ts`, `db/tests/supportTickets.pg.test.ts`, browser QA `docs/audits/phase6-ui/` |
| 17 | `billing.view` | Read subscription/billing observability | A | **ENFORCED** (Phase 9, AC-44) | `GET /api/v1/admin/billing` + `GET /api/v1/admin/billing/users/{id}` → `billing.view` (honest provider unavailable, no history) | `adminPlatformRoutes.test.ts`, `adminPlatformService.test.ts`, `db/tests/adminPlatform.pg.test.ts` |
| 18 | `feature_flags.view` | Read feature flags | A | **ENFORCED** (Phase 9, AC-44) | `GET /api/v1/admin/feature-flags` → `feature_flags.view` (closed vocabulary 4 flags, effective status) | `adminPlatformRoutes.test.ts`, `adminPlatformService.test.ts`, `db/tests/adminPlatform.pg.test.ts` |
| 19 | `feature_flags.edit` | Toggle feature flags (server-authoritative runtime switches) | SA | **ENFORCED** (Phase 9, AC-44) | `PATCH /api/v1/admin/feature-flags/{feature}` → `feature_flags.edit` (enabled boolean, rollout 0..100, SA-only) | `adminPlatformRoutes.test.ts`, `adminPlatformService.test.ts`, `db/tests/adminPlatform.pg.test.ts` |
| 20 | `integrations.view` | Read integration configuration | A | **ENFORCED** (Phase 8, AC-43) | `GET /api/v1/admin/integrations`, `GET /api/v1/admin/integrations/metaapi`, `GET /api/v1/admin/integrations/email`, `GET /api/v1/admin/integrations/relay/config` → `integrations.view` (DB-backed safe status, never secrets; relay alias reuses `ai_platform_secrets`) | `integrationRoutes.test.ts`, `integrationService.test.ts`, `db/tests/integrationAdmin.pg.test.ts` |
| 21 | `integrations.manage` | Change integration configuration | SA | **ENFORCED** (Phase 8, AC-43) | `PUT/DELETE /api/v1/admin/integrations/metaapi*`, `PUT/DELETE /api/v1/admin/integrations/email*`, `POST /api/v1/admin/integrations/{metaapi,email}/test`, `PUT/DELETE /api/v1/admin/integrations/relay/config` → `integrations.manage` (secret-bearing writes, upstream probes) | `integrationRoutes.test.ts`, `integrationService.test.ts`, `db/tests/integrationAdmin.pg.test.ts` |
| 22 | `analytics.view` | Read product/operational analytics | A | **ENFORCED** (Phase 6) | `GET /api/v1/admin/analytics/users` and `GET /api/v1/admin/analytics/trading` → `analytics.view`, over five bounded range presets (today / 7d / 30d / 90d / all). Counts only: no money is invented where Modern has no ledger, and Legacy's `ai` / `operations` / `revenue` analytics blocks stay unmigrated with phase 9 named as their owner | `adminConsoleRoutes.test.ts`, `adminConsoleService.test.ts` |
| 23 | `aiManage` | Configure AI behaviour (Legacy naming: non-dotted to avoid the `ai.*` i18n namespace) | A | **ENFORCED** (Phase 7, AC-18) | `GET /api/v1/admin/ai/*` (overview, feature-providers, flags, quotas, route, relay, usage) → `aiManage` | `aiAdminRoutes.test.ts`, `aiCapability.test.ts`, `db/tests/aiCapability.pg.test.ts` |
| 24 | `aiRouteManage` | Configure AI routing (provider/model selection) | SA | **ENFORCED** (Phase 7, AC-18) | `PUT/DELETE /api/v1/admin/ai/*`, `POST /api/v1/admin/ai/credentials/*`, `POST /api/v1/admin/providers/*/verify|test-connection` → `aiRouteManage` (secret-bearing, upstream) | `aiAdminRoutes.test.ts`, `aiCapability.test.ts`, `db/tests/aiCapability.pg.test.ts` |

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
