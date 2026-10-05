# Phase 6 — Legacy admin panel → Modern admin console · capability map

**Date:** 2026-10-04 · **Branch:** `feat/telegram-journal-client`
**Modern sources:** `apps/api/src/admin/{adminRoutes,adminConsoleRoutes,adminConsoleService,adminConsoleStore}.ts`,
`apps/api/src/auth/adminUserService.ts`, `apps/api/src/kernel/server.ts`, `apps/api/src/support/supportRoutes.ts`,
`apps/web/src/app/(app)/admin/page.tsx`, `packages/contracts/src/rbac.ts`, `db/migrations/0027_*`
**Legacy sources (read-only @ `edede31`):** `api/index.php` (admin block, lines 109–251),
`api/src/Admin/*` (28 files), `api/src/Auth/Role.php`, `api/database/{schema.sql,migrations/v1.6_feature_flags.sql}`,
`public/admin/v2/index.html`, `public/locales/chunks/fa/admin.json` (454 keys)

This map is the contract behind the console. Every Legacy admin route is listed with a
disposition, and every disposition names the Modern route that carries the capability — or the
substrate that is still missing, the phase that owns it, and what an operator loses until then.
Nothing here is "done" by resemblance: a row is **MIGRATED** only when a Modern route implements it
and a test exercises the rule.

---

## 1. Method (and the count)

Legacy's admin surface was re-derived from `api/index.php` by parsing the `$router->` statements
that carry an `/api/v1/admin` path, taking the HTTP method **and the permission constant on the same
statement** (multi-line statements included). That yields **75 route statements across 19 path
segments**:

| Segment | Routes | Segment | Routes | Segment | Routes |
|---|---|---|---|---|---|
| `users` | 17 | `integrations` | 12 | `settings` | 3 |
| `ai` | 10 | `communications` | 7 | `system` | 3 |
| `analytics` | 6 | `feature-flags` | 2 | `logs` | 2 |
| `billing` | 2 | `providers` | 2 | `security` | 2 |
| `ai-usage` | 1 | `config` | 1 | `me` | 1 |
| `overview` | 1 | `permissions` | 1 | `trading-accounts` | 1 | 

(19th segment: `trades` — 1 route.)

**Why this number and not the 73 in the earlier audit notes:** the previous count was a hand
tally that grouped `feature-flags` as three routes (only two exist: `GET` + `PATCH`), folded
`/admin/overview`, `/admin/me` and `/admin/permissions` into their neighbours, and missed the two
platform-wide trading reads (`/admin/trades`, `/admin/trading-accounts`). The method above is the
one kept: **method + path + permission, per `$router` statement**. The reading is reproducible from
the file, and this document is the only place the count is stated.

## 2. Permission model

Legacy declares 20 admin permissions in `api/src/Auth/Role.php`; the console uses the Modern names
that were carried over **verbatim** where the capability exists. Six are super-admin-exclusive in
Legacy (`users.change_role`, `audit.view_sensitive`, `settings.manage`, `feature_flags.edit`,
`integrations.manage`, `ai.route_manage`); Modern keeps `users.change_role` and
`audit.view_sensitive` exclusive, and does not declare the other four because their capability is
not implemented yet — a permission with nothing to guard would be a fabricated authorization
surface.

| Legacy permission | Modern | Holders | Guards |
|---|---|---|---|
| `P_OVERVIEW_VIEW` | `overview.view` | admin, super_admin | `GET /admin/overview` |
| `P_ANALYTICS_VIEW` | `analytics.view` | admin, super_admin | `GET /admin/analytics/{users,trading}` |
| `P_SYSTEM_HEALTH_VIEW` | `system.health.view` | admin, super_admin | `GET /admin/system/health` |
| `P_AUDIT_VIEW` | `audit.view` | admin, super_admin | `GET /admin/audit-logs`, `/admin/security/{signups,logins}` |
| `P_AUDIT_SENSITIVE_VIEW` | `audit.view_sensitive` | super_admin (+ System Owner) | the `ip_address`/`user_agent` fields on those reads |
| `P_USERS_VIEW` | `users.view` | admin, super_admin | user list/detail, sessions, devices, accounts, trades, platform trading reads |
| `P_USERS_SUSPEND` | `users.manage_status` | admin, super_admin | `PATCH …/status`, `POST …/session-revocations` |
| `P_USERS_CHANGE_ROLE` | `users.change_role` | super_admin | `PATCH …/role` |
| `P_USERS_VERIFY_EMAIL` | `users.verify_email` | admin, super_admin | `POST …/email-verification` |
| `P_COMM_VIEW` / `P_COMM_REPLY` | `support.tickets.view` / `support.tickets.manage` | admin, super_admin | the Phase 5 admin queue |
| `P_USERS_CREATE`, `P_USERS_MANAGE_SUBSCRIPTION` | — | — | see §4 |
| `P_SETTINGS_*`, `P_FEATURE_FLAGS_*`, `P_INTEGRATIONS_*`, `P_BILLING_VIEW`, `P_AI_*`, `P_SYSTEM_LOGS_VIEW` | — | — | see §4 |

## 3. Route-by-route disposition

### 3.1 MIGRATED — implemented in this phase, with a Modern equivalent

| Legacy | Modern | Rule that had to survive |
|---|---|---|
| `GET /admin/overview` | `GET /api/v1/admin/overview` | one consistent snapshot (counts come from a SINGLE query, so the sections cannot disagree with each other); tombstoned trades excluded exactly as the user's own dashboard excludes them |
| `GET /admin/users` | `GET /api/v1/admin/users` (kernel, Phase 3) | search + role/status filters, page/perPage bounded (25 default, 100 max), passwords never projected |
| `GET /admin/users/{id}` | `GET /api/v1/admin/users/{id}` | the safe projection is an allow-list (`AdminUserView`), never spread-and-delete |
| `POST /admin/users/{id}/status` | `PATCH /api/v1/admin/users/{id}/status` | suspend/reactivate + **session revocation** on suspend; owner immutability, peer protection, self-action, last-super-admin all preserved (see §5) |
| `POST /admin/users/{id}/role` | `PATCH /api/v1/admin/users/{id}/role` | privilege-granting is super_admin-only; changing a role revokes sessions |
| `GET /admin/users/{id}/sessions` | `GET /api/v1/admin/users/{id}/sessions` | raw network identity is permission-gated by OMISSION (`ip_address`/`user_agent` keys absent) — Phase 2's shape, reused |
| `POST /admin/users/{id}/revoke-sessions` | `POST /api/v1/admin/users/{id}/session-revocations` (body `{}`) | see §5: ONE endpoint for both scopes |
| `POST /admin/users/{id}/sessions/{sid}/revoke` | `POST /api/v1/admin/users/{id}/session-revocations` (body `{"sessionId": "…"}`) | see §5 |
| `GET /admin/users/{id}/devices` | `GET /api/v1/admin/users/{id}/devices` | devices are a read-only inventory; Modern has **no writer** yet (MG-DEVICE-TRACKING), so the list is legitimately empty and the UI says so |
| `GET /admin/users/{id}/accounts` | `GET /api/v1/admin/users/{id}/accounts` | account numbers masked; money as exact NUMERIC strings (ADR-001) |
| `GET /admin/users/{id}/trades` | `GET /api/v1/admin/users/{id}/trades` | tombstoned trades excluded; `net_pnl` numeric string |
| `GET /admin/trades`, `GET /admin/trading-accounts` | `GET /api/v1/admin/{trades,trading-accounts}` | platform-wide reads with the SAME filters/paging rules as the per-user reads |
| `GET /admin/users/{id}/audit` | `GET /api/v1/admin/audit-logs?targetUserId={id}` | see §5(b) |
| `GET /admin/logs/audit` | `GET /api/v1/admin/audit-logs` | filters `action`, `actorUserId`, `targetUserId`, `before`, `since`, `until`; keyset-safe limit; `before_state`/`after_state` carried through to the console |
| `GET /admin/security/signups` | `GET /api/v1/admin/security/signups` | `auth_events` as the source of truth; result/reason/since/until filters; sensitive fields gated |
| `GET /admin/security/logins` | `GET /api/v1/admin/security/logins` | same rules as signups |
| `GET /admin/analytics/users` | `GET /api/v1/admin/analytics/users` | totals + byRole/byStatus/byLocale/byPlan + a per-day registration trend over a half-open `[from,to)` window |
| `GET /admin/analytics/trading` | `GET /api/v1/admin/analytics/trading` | win/loss/break-even split by net P&L SIGN, net P&L as a numeric string, and the explicit note that trading P&L is **not** platform revenue (Legacy's own `isRevenue: false` / `note` semantics) |
| `GET /admin/system/health` | `GET /api/v1/admin/system/health` | see §3.3 — every status is derived from a fact, never assumed |
| `GET /admin/communications/tickets*` (4 of 7) | Phase 5 `supportRoutes.ts` admin queue | the Phase 5 rules, unchanged; the console's Support tab consumes that API rather than restating it |
| `POST /admin/users/{id}/verify-email` | `POST /api/v1/admin/users/{id}/email-verification` | idempotent; a second attempt is 200 with `changed: false`, not an error; one audit row per real transition, written in the SAME transaction (rollback = no change) |
| `GET /admin/me` | `GET /api/v1/admin/rbac/self` (Phase 2) | the caller's role + effective permission set; the console derives its tab set from this, so a permission is never assumed client-side |
| `GET /admin/permissions` | `GET /api/v1/admin/rbac/matrix` (Phase 2) | **tighter than Legacy:** the matrix is `rbac.matrix.view` (super_admin only) because it enumerates every role's authority; Legacy gated it with `settings.view` |

### 3.2 MAPPED with a recorded divergence

| Legacy | Modern | Divergence and why |
|---|---|---|
| `GET /admin/analytics/overview` | the console's **Overview tab**, composed from `/admin/overview` + `/admin/analytics/*` | Legacy's endpoint bundled `users`, `trading`, `ai`, `operations`, `revenue` into one payload. Modern has no `analytics/overview` route because the composition is the tab, and two of the five sections have no substrate yet (§4). Legacy itself returned `revenue` as an explicitly unavailable section (`AnalyticsService::revenueUnavailable()`), so Modern is not the first to answer "we cannot compute this" — it is the first to stop pretending the other four are one number. |
| `POST /admin/users/{id}/status`, `POST /admin/users/{id}/role` | `PATCH` on the same paths | Modern's per-user admin API is a resource; `PATCH` states that the operation updates part of it. Behaviour is identical and the divergence is method-level only. |
| `GET /admin/users/{id}/activity` | the per-user **audit trail** (`?targetUserId=`) plus the sessions/devices/trades blocks | Legacy's "activity" was a merged stream of session, audit and trade events. Modern shows the same facts as separate, individually-authorized blocks: the audit trail needs `audit.view`, and folding it into one feed would leak audit rows to a caller who only holds `users.view`. |
| `POST /admin/users/{id}/revoke-sessions` + `POST /admin/users/{id}/sessions/{sid}/revoke` | ONE `POST /api/v1/admin/users/{id}/session-revocations` with an optional `sessionId` | Both Legacy paths made the same authorization decision twice, and a second decision is a second chance to disagree. One endpoint, one guard chain, `{sessionId: null}` = every session. |
| `GET /admin/users/{id}/audit` | `GET /admin/audit-logs?targetUserId={id}` | one implementation of "read the trail"; the per-user page is a filter, not a second reader. |

### 3.3 System health — what is attested, and what is honestly `not_applicable`

`GET /api/v1/admin/system/health` probes nine components in a fixed order and reports each with one
of `healthy | degraded | unhealthy | not_configured | not_applicable | unknown`:

| Component | Basis |
|---|---|
| `database` | a real round trip, timed; ≥ 400 ms is `degraded`, ≥ 2000 ms `unhealthy` |
| `migrations` | applied count vs the count the RUNNING BUILD expects; **ahead** or **behind** is `degraded`; an unreadable expectation is `unknown`, never "all applied" |
| `api` | process uptime + Node version |
| `rate_limiter` | the live bucket count from the rate limiter's own store |
| `worker`, `email`, `ai_provider`, `metaapi`, `n8n_relay` | `not_applicable` + the phase that owns the capability |

`not_applicable` is deliberately **not** a failure and **not** a pass: it is the only status that
does not let a component's absence read as a green check. The two Legacy diagnostics routes
(`/system/diagnostics`, `/system/diagnostics/refresh`) are NOT migrated: they ran deep probes
against the queue, the mail provider, the AI provider and the integrations registry, and probing a
subsystem that does not exist would produce exactly the fabricated status this project forbids.
They arrive with their substrates in phases 7–8.

## 4. NOT MIGRATED in this phase (with the dependency that blocks each)

| Legacy capability | Routes | Why not now | Owner | What an operator loses until then |
|---|---|---|---|---|
| AI configuration + usage + global route + provider verification | 10 (`ai/*`) + 1 (`ai-usage`) + 2 (`providers/*`) + 1 (`config/effective` = 14) | no AI provider registry, credential store or usage ledger in Modern | **Phase 7 (AI)** | no provider/credential management, no usage drilldown, no route pinning |
| Ticket translate + copilot + copilot draft | 3 (`communications/*`) | requires the AI capability | **Phase 7 (AI)** | no translation or draft assistance inside a ticket |
| Integration configuration: MetaAPI, e-mail, n8n relay (view/update/clear/test) | 12 | the Modern MetaAPI sync exists in the worker, but there is no admin-managed credential/registry store, and e-mail delivery is not yet a Modern capability | **Phase 8 (integrations/worker/email)** | no credential entry, no "test connection", no relay config |
| Feature flags | 2 | no flags table and **no consumer** for one: Modern reads configuration at boot. A flags table nothing reads would be speculative infrastructure | **Phase 9 (secondary parity)**, if a consumer is introduced | operators cannot dark-launch a feature |
| System settings (index/update/reset) | 3 | same class as flags: no persisted settings store and no runtime reader | **Phase 9**, with a settings consumer | operators cannot change runtime configuration |
| System log viewer | 1 (`logs/system`) | Modern writes structured logs to stdout; there is no persisted `system_logs` table, and inventing one before the worker/observability work would create a second, unused log store | **Phase 8** | no in-console log search (logs remain in the process/journal stream) |
| Billing: platform overview + per-user subscription detail | 2 | Modern's billing capability is user-facing; the admin-side reads need a subscription ledger view and a plan catalogue that are not built yet | **Phase 9** | no revenue/subscription console view. Recorded as a real gap, not hidden: `/admin/overview` reports subscription COUNTS, not money |
| Analytics: `ai`, `operations`, `revenue` | 3 of 6 | no `ai_requests`, `integration_health` or revenue substrate in Modern | **Phases 7/8/9** | the AI/operations/revenue panels are absent; Legacy reported `revenue` as unavailable too |
| User creation + invitations | 2 | not part of the console's read/inspect capability; Public registration is Modern's provisioning path and admin-created accounts need a policy decision (invite token TTL, who may invite) that Legacy answers only partly | **recorded, owner decision** | operators cannot create or invite users from the console |
| Per-user subscription management | 1 (`users/{id}/subscription`) | depends on the billing/subscription write path above | **Phase 9** | operators cannot change a user's plan |
| Per-user login history | 1 (`users/{id}/login-history`) | Modern has `auth_events` and the platform-wide feeds; the per-user filter is a small addition that this slice did not include | **Phase 6 follow-up** — recorded as a gap, not claimed | operators cannot see one user's sign-in history (they can see the sessions and the global feeds) |

**Nothing in this table is "implemented".** Each row states the missing substrate and the phase
that owns it; the capability matrix carries the same rows as `MISSING` / `LEGACY_ONLY` with these
reasons.

## 5. Invariants the console had to preserve

**(a) The pair guards on every mutating path.** `AdminUserService` is the single owner of the
rules, and the console does not restate them. Frozen order, unchanged: self-action 403 →
404 `USER_NOT_FOUND` → `SYSTEM_OWNER_PROTECTED` → `PRIVILEGED_TARGET` → 403
`SUPER_ADMIN_PEER_PROTECTED` → `PRIVILEGE_ESCALATION_DENIED` → no-op without revoking →
`LAST_SUPER_ADMIN` 409. Revoking a user's sessions now runs through the SAME chain, because ending
sessions is the consequence of a suspension and must not become the way around one: without it an
`admin` could sign the System Owner out of every device — precisely the denial the owner rule
exists to prevent.

**(b) Sensitive fields by omission.** Without `audit.view_sensitive` the keys `ipAddress` and
`userAgent` are **absent from the response body**, not nulled, and the response carries
`sensitive: false` so the client can label the gap honestly. "You may not see this" and "this was
not recorded" are different facts, and a `null` would conflate them. The console renders
«در دسترس نیست» / "Not available" for the first and «—» for the second.

**(c) A tab is not a security boundary.** The tab set is computed from the permission set the
SERVER reports (`/admin/rbac/self`), and every route re-authorizes. `apps/web/src/i18n/adminSurface.test.ts`
asserts both halves: the client filters, and the permission each tab names is really checked by a
server route module.

**(d) Money stays a string.** `net_pnl`, `balance`, `equity` and every aggregate of them are NUMERIC
carried out of the store as exact strings (ADR-001). No `Number()` touches a money value; the
console prints what the database computed.

**(e) The audit vocabulary is closed, and widening it was a schema change.** The console needed two
new actions — `USER_SESSIONS_REVOKED`, `USER_EMAIL_VERIFIED` — so `0027` widens the
`audit_log_action_check` CHECK to the 15-action set. Both rows are written in the SAME transaction
as the change they describe: a failed audit rolls the change back.

## 6. Evidence

| Claim | Where it is proven |
|---|---|
| 14 console routes answer with the documented statuses/codes | `apps/api/src/admin/adminConsoleRoutes.test.ts` — 17/17 |
| Ranges, health ranking, sensitive omission, paging/filter validation | `apps/api/src/admin/adminConsoleService.test.ts` — 16/16 |
| Real PostgreSQL: windows, NUMERIC strings, keyset, conditional revoke, `verifyEmailOnce` race, audit rollback, catalogue-derived health | `db/tests/adminConsole.pg.test.ts` — 14/14, 0 skipped |
| The console's copy is Legacy's, in both locales, and its classes exist | `apps/web/src/i18n/adminSurface.test.ts` — 8/8 |
| Typecheck + full suite + build | `apps/api` tsc clean · `npm test` all files passed · web build succeeds, `/admin` + `/en/admin` present |

## 7. Status (mission §23 vocabulary)

`overview`, `users`, `support`, `audit`, `security`, `system health`, `analytics (users/trading)`:
**IMPLEMENTED + TESTED + COMMITTED/PUSHED** — the state is recorded per row in `docs/state/` and in
the phase report. Every capability in §4 is **MISSING** or **LEGACY_ONLY** with the reason above —
none of them is CLAIMED, and the console says so in the UI where an operator would look for it.
