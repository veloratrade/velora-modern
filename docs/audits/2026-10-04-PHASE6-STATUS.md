# Phase 6 — Admin console · status report

**Date:** 2026-10-04 · **Branch:** `feat/telegram-journal-client` · **Phase start SHA:** `73fc5ee`
**Scope (mission §9):** admin — capability-mapped, dependency order, "no shell".
**Capability map:** `docs/audits/2026-10-04-PHASE6-ADMIN-CAPABILITY-MAP.md` (the 75-route Legacy
inventory and the disposition of every route).

**Headline:** Legacy's admin panel is no longer a missing capability. The console reads the
platform's real state (users, trading, support, subscriptions, Telegram, audit, security feeds,
analytics, live health), and every operator action it exposes is enforced by the same service that
already guarded the Phase 2/3 user-management surface — the console added no second authorization
path and no second store. What could not be migrated is named in the UI and in the map with the
substrate it waits for, not stubbed: the AI (phase 7), integrations/e-mail/worker (phase 8), and the
settings/feature-flag/billing/log-viewer modules that have no consumer in Modern yet are all
explicitly absent rather than empty panels.

---

## 1. What changed

| Area | Change | Capability |
|---|---|---|
| Migration | `db/migrations/0027_admin_console.sql` — widens the closed audit vocabulary by two actions (`USER_SESSIONS_REVOKED`, `USER_EMAIL_VERIFIED`) | ADMIN-05 |
| Store | `apps/api/src/admin/adminConsoleStore.ts` — `AdminConsoleStore` port + `PgAdminConsoleStore` (plain SQL, `pg` driver) + `MemoryAdminConsoleStore` | ADMIN-01…04 |
| Service | `apps/api/src/admin/adminConsoleService.ts` — ranges, health ranking, sensitive-field omission, platform list paging/filters | ADMIN-01…04 |
| Routes | `apps/api/src/admin/adminConsoleRoutes.ts` — 14 routes under `/api/v1/admin/*` | ADMIN-01…04 |
| Extend | `apps/api/src/admin/adminRoutes.ts` (audit trail now carries `before_state`/`after_state`), `apps/api/src/auth/adminUserService.ts` (sessions/devices/revoke/verify-email), `pgUserStore.ts`/`memoryUserStore.ts`/`userStore.ts` (the reads those need) | ADMIN-05 |
| Wiring | `kernel/server.ts` + `routes/extendedRoutes.ts` + `server-main.ts` — the console capability is injected like support/telegram; absent capability = fail-closed 503 | ADMIN-01 |
| RBAC | `packages/contracts/src/rbac.ts` — Legacy's own permission names (`overview.view`, `analytics.view`, `system.health.view`, `audit.view`, `audit.view_sensitive`, `users.verify_email`), granted to the same roles Legacy granted them | ADMIN-06 |
| Web | `apps/web/src/app/(app)/admin/page.tsx` (was a 34-line PLANNED shell) + `lib/api/resources.ts` (admin client) + `messages/{fa,en}/admin.json` (148 keys each) + `i18n/catalog.ts` | ADMIN-01…04 |
| Tests | routes 17/17 · service 16/16 · real-PG 14/14 · i18n/design guard 8/8 | — |

## 2. The console, module by module

| Legacy module | Modern home | State |
|---|---|---|
| Overview (`/admin/overview`) | Overview tab ← `GET /api/v1/admin/overview` | IMPLEMENTED · TESTED |
| Users 360 (`/admin/users/*`) | Users tab + `GET/PATCH /api/v1/admin/users/*` | IMPLEMENTED · TESTED |
| Communications (`/admin/communications/tickets`) | Support tab ← the Phase 5 admin queue | IMPLEMENTED (phase 5) · TESTED |
| Audit logs (`/admin/logs/audit`) | Audit tab ← `GET /api/v1/admin/audit-logs` with filters | IMPLEMENTED · TESTED |
| Security feed (`/admin/security/{signups,logins}`) | Security tab, sensitive-gated | IMPLEMENTED · TESTED |
| System health (`/admin/system/health`) | System tab, nine attested components | IMPLEMENTED · TESTED |
| Analytics (`/admin/analytics/{users,trading}`) | Analytics tab with five range presets | IMPLEMENTED · TESTED |
| AI (14 routes) | — | **Phase 7** (no provider registry/usage ledger in Modern) |
| Integrations (12 routes) | — | **Phase 8** (no admin-managed credential store; e-mail not yet a capability) |
| Settings (3) · Feature flags (2) · Log viewer (1) | — | **NOT MIGRATED, recorded** — no persisted store and **no reader**; building the table alone would be speculative infrastructure |
| Billing (2) · per-user subscription (1) · analytics ai/operations/revenue (3) | — | **Phase 9** (billing/subscription ledger view not built) |
| User creation + invitations (2) | — | **Recorded, owner decision** (invite policy: TTL, who may invite) |
| Per-user login history (1) | — | **Phase 6 follow-up** (the platform-wide feeds exist; the per-user filter does not) |

## 3. Gates (this phase)

| Gate | Result |
|---|---|
| Typecheck | `apps/api` + `apps/web` clean |
| Full suite | `npm test` — all test files passed (**1106 node + 63 PGlite**, 0 fail / 0 skip) |
| Real PostgreSQL | `db/tests/adminConsole.pg.test.ts` 14/14 · full battery runner: every file, forward **and** reversed order |
| Web build | `✓ Compiled successfully` — 38 routes, `/admin` and `/en/admin` both real (no longer a placeholder) |
| Secret scan | `tools/secret-scan.sh` PASS (0 findings) |
| Migrations | head `0027_admin_console.sql`; the console's own health check reports `applied == expected` |
| Real-PG batteries (final) | `tools/run-pg-batteries.sh` — **30 files × 2 orders = 60 runs, 0 failures**, `REAL-PG EVIDENCE: PASS` |
| Visual / responsive QA | **62/62 checks passed** in a real browser (Playwright/Chromium 153) against the production build + live API on PostgreSQL 17 — 20 screenshots + `visual-qa-results.json` in `docs/audits/phase6-ui/`, harness `tools/visual-qa/phase6-admin.mjs`, recipe in that folder's `README.md` |
| RBAC map guard | `rbacCapabilityMap.test.ts` 5/5 after the map moved **6 → 12 of 24** Legacy permissions to ENFORCED (rows 1, 7, 9, 10, 11, 15, 16, 22) |
| i18n + design guard | `apps/web/src/i18n/adminSurface.test.ts` 8/8 (key sets, rendered-value locale check, byte-copy check, permission-driven tabs, sensitive-field labelling, **every CSS class the page applies exists in the stylesheet**, no hard-coded strings) |

## 4. Defects found by this phase's own loop, and fixed

1. **The audit trail never showed `before_state`/`after_state`.** The console renders "what changed"
   on every mutation row; the store only ever selected the action and the actors, so the column was
   silently empty. Found by the real-PG battery, fixed in `adminRoutes.ts` (`AuditEntry` +
   `PgAdminStore.auditLog`), covered by a battery assertion.
2. **A CLOSED trade fixture violated the Phase 4 constraint `trades_closed_has_financials`.** The
   battery seeded closed trades without exit price / close time. The fixture was genuinely invalid
   (it described a state the database forbids), so the fixture was corrected — the constraint was
   not.
3. **The console shipped CSS classes the stylesheet does not define** (`.tabs`, `.tab-active`,
   `.row between`). Caught by the new design guard, which now asserts every class the page applies
   exists in `app.css`/`shell.css`; the console reuses the canonical segmented control
   (`btn-primary`/`btn-ghost` + `btn-sm`) and the glass/gold card grid like every other page.
4. **Three label families were passed to the translator as values** (`t(entry.labelKey)`,
   `t(RANGE_LABEL[preset])`, `t(componentLabel(key))`) and were missing from the catalog — the
   console would have rendered raw keys to an operator. Found by the new guard's "loose pass" over
   the page source, which now scans both shapes.
5. **A Phase 5 guard fired on the new client block** (`supportSurface.test.ts` asserts no *support*
   call sends `status`; the scan ran from the support marker to EOF, and the admin block had been
   appended after it). The block was moved above the support section — the guard's intent is
   unchanged and its strength is not reduced.

Found by the **browser QA run** (the first pass scored 49/56; every failure was fixed and the run
re-executed to 62/62 — no defect was handed over as a TODO):

6. **Wide tables widened the page on mobile.** `scrollWidth - innerWidth` was **123 px at 390**,
   **193 px at 320** and **515 px on the audit tab**: ten tables sat in plain `.card` boxes with no
   scroll container, so a 5-6 column table pushed the document wider than the viewport. Fixed with
   the canonical pattern the journal already uses (`.overflow-auto`, `app.css` line 61 — the same
   wrapper `(app)/trades/page.tsx` puts around its table); overflow is now **0 at 1440 / 390 / 320 in
   both locales on every tab**. No new CSS, no redesign.
7. **Raw enums leaked into the Persian console.** The support queue printed `open` / `closed` and the
   thread printed `admin` / `user` while the filter directly above them spoke Persian. Fixed with
   `TICKET_STATUS_LABEL` + `SENDER_LABEL`, which reuse the support chunk's own words
   (`pages.support.status.*`, `pages.support.role.support_agent`) and `admin.role.user`; an unmapped
   value still renders raw rather than blank, so nothing can silently disappear.
8. **The ticket thread offered transitions the service refuses, and closing it lost the record.**
   `close` / `reopen` / `archive` / reply were all rendered unconditionally, although
   `supportService` allows close only from `open|pending`, archive only from `closed`, reopen only
   from `closed|archived` and refuses any reply to an `archived` ticket — so three of the four
   buttons could only produce a 409/422. Worse, `close` called `setThread(null)`, which dismissed
   the thread, and `archive` is legal **only** from `closed`: the operator had to hunt the ticket
   down again to reach the next legal action. The actions are now status-driven and close/archive
   re-read the record, so the operator stays on the ticket and sees the state the server holds.

## 5. Deliberate divergences (recorded, not silent)

| Divergence | Why |
|---|---|
| ONE `POST /admin/users/{id}/session-revocations` (optional `sessionId`) instead of Legacy's two revoke paths | two paths meant two authorization decisions that could drift; ending sessions is the consequence of a suspension and must not become a way around the pair guards |
| Per-user audit served by `GET /admin/audit-logs?targetUserId=` (no per-user route) | one implementation of "read the trail" |
| Sensitive fields **omitted** (keys absent) rather than null | "you may not see it" and "not recorded" are different facts |
| Login-history, settings, flags, billing, AI, integrations: absent with a named reason | never a fabricated zero, never an empty panel that looks checked-and-clean |
| `PATCH` for status/role (Legacy used `POST`) | Modern's per-user admin API is a resource; behaviour identical |

## 6. What is still missing (mission §30 — gaps with reason/dependency/risk/next step)

| Gap | Reason | Dependency | Risk | Next step |
|---|---|---|---|---|
| AI admin module (14 routes) | no provider registry / usage ledger | phase 7 | operators cannot manage AI providers | phase 7 |
| Integrations admin (12 routes) | no admin-managed credential store | phase 8 | MetaAPI/e-mail/relay config stays env-driven | phase 8 |
| Settings, feature flags, log viewer | no persisted store **and no reader** | a consumer must exist first | operators cannot change runtime config | phase 9 / recorded |
| Billing + revenue surfaces | subscription ledger view not built | phase 9 | fiscal view of the platform is unavailable (counts only) | phase 9 |
| User creation/invitation | invite policy is a product decision | owner decision | operator cannot provision a user | needs a decision |
| Per-user login history | not included in this slice | none | smaller operator convenience gap | phase 6 follow-up |
| Device tracking has no writer | Modern records sessions, not devices (MG-DEVICE-TRACKING) | none | the devices panel is legitimately empty | unchanged |

## 7. Status vocabulary (mission §23)

`overview` · `users` · `support` · `audit` · `security` · `system health` · `analytics`:
**IMPLEMENTED** (code + tests), **TESTED** (unit, service, real-PG, browser-source guards) and
**visually verified in a real browser** against the production build on live PostgreSQL (62/62,
`docs/audits/phase6-ui/`). In the capability vocabulary of the audit this moves `ADM-01`, `ADM-04`
and `SUP-02` to **VERIFIED** (re-proved against real PostgreSQL and a live browser in this session)
and `SEC-01` from 6 to **12 of 24** Legacy permissions ENFORCED. **COMMITTED/PUSHED** state is
recorded in `docs/state/CHANGE_LOG.md` and is claimed only with the push transcript.

Nothing in §6 is claimed as implemented; each row is `MISSING` or `LEGACY_ONLY` with its dependency.
No existing user capability was removed.
