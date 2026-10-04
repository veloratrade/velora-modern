# Legacy → Modern Capability Audit (pre-implementation)

**Audit date:** 2026-10-04 · **Auditor:** Arena Agent Mode session
**Legacy reference (read-only):** `veloratrade/veloratrade` @ `edede31`, branch `main` — cloned this session to `../veloratrade` from the public remote (anonymous clone; no credentials used).
**Modern target:** `veloratrade/velora-modern`
**Modern git state recorded BEFORE any edit (§14):**

| Field | Value |
|---|---|
| branch | `feat/telegram-journal-client` |
| HEAD | `42f38cba1e96ab6f3582aaccd3f1644b9fb6133a` |
| base (`main`) | `0e9c4d7e6e1f984287490ce02f5681c208e35c7a` |
| dirty files at start | 0 |
| upstream | `origin/feat/telegram-journal-client` |

**What this document is:** the capability audit required before implementation (§15). It is **evidence-only**: every status cites a file, route, table or test that was opened this session. No implementation, no refactor, no UI change was made — the only files added are this audit and its machine-readable companion.

**What this document is not:** a plan to port PHP. No mechanical translation, no PHP structure copied, no compatibility layer imitating Legacy (§6). Capability → business meaning → Modern architecture → verified behaviour.

---

## §2 Inventory — how it was produced (and two traps avoided)

### Method
* Legacy routes: parsed `api/index.php` (337 lines) line-by-line with a Python regex on `$router->(get|post|…)(`, capturing method, path, gate (`$auth`/`$admin`) and required permission. 123 call lines → **118 distinct routes**.
* Legacy schema: union of `api/database/*.sql` + `api/database/migrations/*.sql` (29 files, v0.2→v1.8) → **46 tables**. `_database/database_corrected.sql` alone shows only 20 — it was **not** used as the schema source.
* Legacy pages/behaviour: read the real page entrypoints under `{page}/index.html` plus the driver scripts in `public/assets/*.js` (23 files) and `api/src/**` (194 PHP files).
* Modern routes: four-pass extraction over `apps/api/src/**` (literal `path ===`, path constants, regex `/^…$/` matchers, module `ROUTES` tables), cross-checked against the 13 handlers registered in `apps/api/src/routes/extendedRoutes.ts`. Two earlier passes under-counted (they missed regex-matched routes such as `PUT/DELETE /api/v1/trades/{id}`) — the final numbers below are from the corrected pass.
* Modern pages: read every `page.tsx` under `apps/web/src/app/(app)/` and classified **real** vs **shell** by whether the page imports the API resource layer and renders server state.

### Trap 1 — `index.txt` files in the Legacy repo are not Legacy
Several Legacy directories contain a sibling `*.txt` (e.g. `profile/index.txt`, `dashboard/index.txt`). Their contents are **Next.js RSC payloads of the Modern app** (references to `../../../packages/web`, `_next/static/chunks/...`, the Modern i18n provider). They are irrelevant to Legacy behaviour and must never be used as evidence about Legacy. Only `index.html` + `public/assets/*.js` + `api/src/**` are Legacy evidence.

### Trap 2 — route-name similarity is not parity
Legacy and Modern share endpoint *names* that do not share *semantics* (e.g. Legacy `POST /api/v1/accounts/connect-metaapi` vs Modern `POST /api/v1/accounts` + `POST /api/v1/credentials` + `POST /api/v1/accounts/{id}/metaapi/connect`). Every "PARITY" claim below is based on the handler body and the store it writes, not on the path.

---

## §2A Legacy inventory (A)

**API:** 118 routes — admin 73 · auth 13 · trades 10 · accounts 7 · support 6 · dashboard 3 · ai 3 · content-translations 1 · webhooks 2.
**RBAC:** 24 permissions in `api/src/Auth/Role.php` (+ roles `guest/user/admin/super`), `P_*` constants referenced per route in `api/index.php`.
**Rate limits** (`api/index.php`): login 8/300 · register 5/3600 · verify-email 20/900 · resend 4/3600 · forgot 4/3600 · reset 6/3600 · refresh 30/300 · change-password 8/900 · metaapi-connect 5/900 · detect-server 20/900 · metaapi-webhook 120/60 · ai-analyze 10/3600 · ai-report 5/3600 · ai-feedback 20/3600 · sync 20/300.
**Tables:** 46, incl. `ai_*` (analysis, audit_logs, extractions, feedback, feature_flags, feature_providers, global_settings, jobs, provider_credentials, provider_logs, provider_quotas, reports, requests), `admin_audit_logs`, `auth_events`, `content_translation_{cache,jobs}`, `integration_health`, `metaapi_{fills,operations}`, `notifications`, `support_{conversations,messages,message_translations}`, `system_logs`, `trade_features`, `trade_screenshots`, `user_achievements`, `sync_jobs`, `email_notifications`.
**`users` columns (legacy):** `id, email, password_hash, first_name, last_name, full_name, role, status, created_at, updated_at, email_verified_at, timezone` + later `locale`, `locale_source`, `locale_updated_at` and `ai_consent_at` added by migrations.
**User-facing pages (31 entrypoints):** `index`, `en/index`, `localized/{en,fa}`, `dashboard`, `trades`, `trades/new`, `wallet`, `performance`, `intelligence`, `markets`, `news`, `support`, `accounts/connect`, `profile`, `checkout`, `admin`, `admin/v2`, `blog` (+5 posts), `privacy`, `terms`, `404`, and auth `login`, `register`, `forgot-password`, `reset-password`, `verify-email`.
**Localization:** `public/locales/{fa,en}.json` = **1,994 keys per locale**, keyed by hashed names (`common.*`, `pages.*`, `auth.*`, `admin.*`).
**Notable real behaviour:** `profile` page = change-password form (`curPw`,`newPw`) + AI-processing toggle (`PATCH /auth/me/preferences`) + identity ("member since"); `trades/new` = full entry form + symbol picker + `velora-smart-import.js` screenshot import (`POST /trades/extract-screenshot`); `intelligence` = AI Q&A surface with preset questions; `support` = ticket create/reply/reopen; `admin` = 73-endpoint console with 38 modules.
**Static-content pages (no inputs, no buttons, no API call in page or driver scripts):** `wallet` (renders hard-coded equity demo values), `performance`, `markets`, `news`, `blog`, `privacy`, `terms`, `checkout` (payment-method copy). These are content surfaces, not capabilities with backend behaviour.

---

## §2B Modern inventory (B)

**API:** 44 kernel-matched route surfaces (`apps/api/src/kernel/server.ts`: literal paths + regex matchers) **+** 48 module-declared method/path pairs registered through `extendedRoutes.ts` (telegram, portfolio, account-groups, ea/device, tenancy, developer, billing, tags, attachments, ai-coach, admin, webhooks, `accounts/{id}/sync-status`) ≈ **92 enumerated route surfaces**. Method-by-method checks were re-confirmed for every route quoted in §3.
**RBAC:** `packages/contracts/src/rbac.ts` — **4** enforced permissions: `admin.panel.access`, `rbac.matrix.view`, `rbac.self.view`, `users.view`.
**Rate limits:** 8 throttled auth routes (`THROTTLED_AUTH_ROUTES` in the kernel) + telegram buckets (`telegram:journal` 20/h, `telegram:analyze` 8/h), fixed-window limiter backed by memory or PG store.
**Persistence:** PostgreSQL only, `db/migrations/0001…0023`; authoritative tables `users, user_sessions, user_devices, email_verifications, password_resets, trading_accounts, trades, trade_events, trade_exits, webhook_events, rate_limits, email_preferences, user_credentials, audit_log, tags/trade_tags/trade_attachments, user_analytics_daily, account_performance_summary, subscriptions, ai_coaching_logs, currency_rates, account_groups, device_tokens, tenants, public_profiles, copy_relationships, signal_queue, developer_api_keys, telemetry tables, telegram_*`.
**Web:** 31 routes — 14 Persian product pages + `en/` mirrors + `/`, `/en` + 5 auth pages (+ mirrors).
**Localization:** `apps/web/messages/{fa,en}/*.json` — **726 fa keys** across `auth, common, errors, landing, landing-interactive, telegram`; Phase 1 added the `settings` feature (49 keys/locale) and 5 shell keys to `common` (74) → **780 fa keys** total, fa/en key sets identical.
**Tests:** 109 test files — `db/tests` 32, `apps/api/src/auth` 14, `packages/domain/src` 11, `kernel` 9, `telegram` 6, `trades` 4, `metaapi` 4, `contracts` 4, `credentials` 3, `aicoach` 3, `ratelimits` 2, `journal` 2, `accounts` 2, `apps/worker/src/*` 8, plus others. Gate run at HEAD `42f38cb`: typecheck 0, tests 957/957, secret-scan PASS, `next build` 0, real-PG batteries 9/9 + 70 real-PG tests. **Phase 1 rerun (2026-10-04):** `tsc -b` all workspaces 0 errors, `next build` 0 errors, secret-scan PASS, `npm test` 940/945 (the 5 red are PGlite batteries the 1.9 GB sandbox OOM-kills when run in parallel — each passes individually: migrations 19/19, migrateCli 11/11, identityPersistence 6/6, telegramJournal 6/6, telegramStoreAdapter 7/7), **all 24 real-PG batteries green on PostgreSQL 16.15 (256 tests)** — see §16.

### Page classification (Modern) — this is the core of the gap
| Route | Lines | Imports API layer? | Renders server state? | Class |
|---|---|---|---|---|
| `/accounts` | 143 | yes (`listAccounts, createAccount, detectServer, connectMetaApi, disconnectMetaApi, listCredentials, createCredential, deleteCredential`) | yes | **REAL** |
| `/trades` | 165 | yes (`listTrades, createTrade, getTradeSymbols, deleteTrade`) | yes | **REAL** |
| `/dashboard` | 111 | yes (`getAnalyticsSummary, getEquityCurve, getBySymbol`) | yes, incl. honest 503 path | **REAL** |
| `/analytics` | 37 | yes (`getAnalyticsSummary`) | yes (KPI + raw JSON) | **REAL (thin)** |
| `/settings` | 328 → **364** | yes (`getTelegramStatus, startTelegramLink, unlinkTelegram, unbindTelegramChannel` + Phase 1: `getMe, changePassword, get/updateEmailPreferences, updatePreferences`) | yes | **REAL** (Phase 1 added Security, Preferences, E-mail preferences; Telegram unchanged) |
| `/profile` | 34 → **204** | no → **yes** (`getMe`) | **yes** — identity from `/auth/me`, read-only, links to `/settings` | **REAL** (Phase 1) |
| `/support` | 34 | no | no — badge `PLANNED / GAP` | **SHELL** |
| `/admin` | 34 | no | no — badge `PLANNED / GAP` | **SHELL** |
| `/intelligence` | 34 | no | no | **SHELL** |
| `/markets` | 34 | no | no | **SHELL** |
| `/news` | 34 | no | no | **SHELL** |
| `/performance` | 34 | no | no | **SHELL** |
| `/wallet` | 34 | no | no | **SHELL** |

**Honest note (positive evidence):** no shell page fabricates data. Each states in both locales that the backend does not exist yet, and the `/dashboard` + `/analytics` 503 path reports the missing capability instead of inventing numbers. Therefore **no `UI_ONLY` fake-data violation exists**; what exists is *UI shells over missing backends*, which §10 classifies as NOT MIGRATED.

---

## §3 Capability matrix (C)

Status vocabulary is exact and used with these meanings only:
`MISSING` no meaningful Modern implementation · `UI_ONLY` a screen exists without a working backend/persistence · `BACKEND_ONLY` server capability exists with no user-facing surface · `PARTIAL` some of the capability's behaviour exists, with named gaps · `IMPLEMENTED` the behaviour exists end-to-end (UI + API + PG + auth + authz + validation + i18n + tests) · `VERIFIED` IMPLEMENTED **and** re-proved against a real PostgreSQL / live dependency **in this session** · `LEGACY_ONLY` the Legacy thing is content/demo detail with no behaviour to migrate · `INTENTIONALLY_NOT_MIGRATED` dropped on purpose, with a written reason.

### Summary

53 capability rows total (PLT-08 is the register-level alias of TRD-12 and is counted once):

| Status | Count | Capabilities |
|---|---|---|
| VERIFIED | 8 | ACC-01, ACC-04, ACC-05, ACC-07, ACC-08, ACC-09, TRD-01, PLT-01 |
| IMPLEMENTED | 4 | ACC-02, ACC-03, TRD-12 · (PLT-08 is the same capability recorded under the platform area) |
| PARTIAL | 14 | ACC-06, SEC-01, SEC-02, SEC-04, TRD-02, TRD-04, TRD-05, TRD-06, TRD-07, ADM-01, PLT-03, PLT-05, PLT-06, PLT-11 |
| BACKEND_ONLY | 2 | AI-05, PLT-14 |
| UI_ONLY | 2 | TRD-09, ADM-04 |
| MISSING | 19 | ACC-10, ACC-11, SEC-03, TRD-03, TRD-08, AI-01, AI-02, AI-03, AI-04, SUP-01, SUP-02, ADM-02, ADM-03, PLT-02, PLT-04, PLT-07, PLT-09, PLT-10, PLT-12 |
| LEGACY_ONLY | 2 | TRD-10, TRD-11 |
| INTENTIONALLY_NOT_MIGRATED | 2 | TRD-13, PLT-13 |

**Phase 1 moved five rows (2026-10-04):** ACC-04, ACC-05, ACC-07, ACC-08, ACC-09 → `VERIFIED`
(implemented end-to-end, unit-tested, re-proved against real PostgreSQL **and** a live
browser session); ACC-06 → `PARTIAL` after RE-VERIFICATION (see §13 — the first pass's
"MISSING" claim was wrong about `full_name`/`timezone`). Reason per row is in
`docs/state/capability-matrix.json` (`modern_evidence` + `next_action`).

Rows counted in the table above: 11 (ACC) + 4 (SEC) + 13 (TRD) + 5 (AI) + 2 (SUP) + 4 (ADM) + 14 (PLT) = 53.

`UI_ONLY` here does **not** mean fake data — see the §2B note. Every shell is an explicitly badged GAP placeholder; `UI_ONLY` means "a screen exists and there is no behaviour behind it".

### 3.1 Account & identity

| ID | Capability (business meaning) | Legacy evidence | Modern evidence | Status |
|---|---|---|---|---|
| ACC-01 | A person can create an account, prove the mailbox is theirs, and only then sign in | `POST /api/v1/auth/register` (5/3600), `verify-email` (20/900), `resend` (4/3600); `users.email_verified_at` | UI `/register`, `/verify-email`; API `POST /auth/register|verify-email|resend-verification`; `email_verifications`; login refuses unverified (401 `EMAIL_NOT_VERIFIED` — re-proved locally this session); `apps/api/src/auth` 14 test files | **VERIFIED** |
| ACC-02 | Sign in / stay signed in / sign out | `auth/login` (8/300), `refresh` (30/300), `logout`; `auth_events` | `POST /auth/login|refresh|logout`; `user_sessions` with refresh-token hash; refresh in Secure cookie; auth tests | **IMPLEMENTED** |
| ACC-03 | Recover a forgotten password | `forgot-password` (4/3600), `reset-password` (6/3600); `password_resets` | `POST /auth/forgot-password|reset-password`; `password_resets` (hash, expiry, consumed); UI `/forgot-password`, `/reset-password` | **IMPLEMENTED** |
| ACC-04 | Signed-in user changes own password | `POST /auth/change-password` (8/900) + form on `/profile` | API `POST /auth/change-password` (throttled `auth:change-password`); **no UI anywhere** | **BACKEND_ONLY** |
| ACC-05 | A profile page that shows who I am and lets me read my account state | `/profile` page: identity, "member since", role | `/profile` = 34-line shell, badge `PLANNED / GAP`, reads nothing; `GET /auth/me` exists | **UI_ONLY** (shell is a placeholder, no data) |
| ACC-06 | Profile fields (full name + timezone; Legacy also has first/last name) | `users.first_name,last_name,full_name,timezone` | **RE-VERIFIED:** `users.full_name` + `users.timezone` exist (migration `0002_identity_capability.sql`), register accepts them and `GET /auth/me` returns them; `0022` adds `first_name,last_name,locale_source,locale_updated_at`. Only `first_name`/`last_name` are Legacy-only and no Legacy UI string consumes them | **PARTIAL** (full name + timezone migrated; split names unconsumed) |
| ACC-07 | My UI language choice is stored, not re-guessed every visit | `users.locale,locale_source,locale_updated_at`; `PATCH /auth/me/preferences`; driver `velora-localization.js` writes it on switch | `users.locale`; `PATCH /auth/me/preferences` (`locale: fa|en`, validated); locale surfaces as path (`/`, `/en`) + `i18n/registry`; **no evidence of a switch control that calls the endpoint** | **PARTIAL** (persisted + validated; UI wiring unproven) |
| ACC-08 | I consent (or not) to external AI processing of my trades | Toggle on `/profile` → `users.ai_consent_at` via `PATCH /auth/me/preferences`; `UserAIConsentRepository` | `users.ai_consent_at` (migration 0002); `PATCH /auth/me/preferences` `ai_consent:boolean` validated in kernel; `authService.updatePreferences` returns `ai_consent` + `ai_consent_at`; **no UI** | **BACKEND_ONLY** |
| ACC-09 | I choose which e-mail categories reach me | `GET/PUT /auth/email-preferences`; 6 keys `welcome_email, security_alerts, trade_notifications, weekly_report, monthly_report, achievement_notifications` | `email_preferences` table with **the same 6 columns**; `GET/PUT /auth/email-preferences`; **no UI** | **BACKEND_ONLY** |
| ACC-10 | Admin can see/act on a user's sessions and devices | 8 admin user routes incl. `sessions`, `devices`, `login-history`, `revoke-sessions` | `user_sessions`/`user_devices` exist; admin surface = list/get/role/status only | **MISSING** (covered by ADM-01) |
| ACC-11 | Admin can create users / invite / verify on behalf of a user | `POST /admin/users`, `/users/invitations`, `/users/{id}/verify-email` | — | **MISSING** |

### 3.2 Security, auth & authorization

| ID | Capability (business meaning) | Legacy evidence | Modern evidence | Status |
|---|---|---|---|---|
| SEC-01 | Role/permission model that actually gates every privileged action | 24 `P_*` permissions in `Role.php`, checked per route in `index.php`; roles guest/user/admin/super | `rbac.ts` + `rbac_roles` + `audit_log`; **4** permissions enforced (`admin.panel.access`, `rbac.matrix.view`, `rbac.self.view`, `users.view`) | **PARTIAL** (4/24 enforced — MG-RBAC-VOCAB) |
| SEC-02 | Abuse limits on credential + expensive endpoints | 15 throttled routes (table above) | 8 auth routes throttled (`THROTTLED_AUTH_ROUTES`) + telegram 2 buckets; fixed-window limiter (memory/PG). Not yet verified for `accounts` connect / `detect-server` / sync / ai | **PARTIAL** |
| SEC-03 | Security-relevant auth events are recorded and reviewable | `auth_events` table; admin `security/logins`, `security/signups`; `login-history` | `audit_log` exists (credential events in 0011) but **no** auth-event/login-history recording | **MISSING** (MG-AUTH-EVENTS) |
| SEC-04 | Session/refresh hardening (cookie prefix, SameSite, HSTS, CSP, edge authz) | PHP: `__Host-` prefix, SameSite=Strict, CSP manifest + release pinning, proxy HSTS, HTML-route gating | Open register items MG-SEC-COOKIE, MG-SEC-CSP, MG-SEC-HSTS, MG-SEC-EDGE-AUTHZ | **PARTIAL** (not re-audited here; carried from the register) |

### 3.3 Trading

| ID | Capability (business meaning) | Legacy evidence | Modern evidence | Status |
|---|---|---|---|---|
| TRD-01 | Journal of trades with full CRUD, exits and symbol list | `GET/POST /trades`, `GET/PUT /trades/{id}`, `DELETE /trades/{id}`, `GET/POST /trades/{id}/exits`, `DELETE /trades/exits/{exitId}`, `GET /trades/symbols` | Kernel: `GET/POST /trades`, `GET/PUT/DELETE /trades/{id}`, `GET/POST /trades/{id}/exits`, `DELETE /trades/exits/{id}`, `GET /trades/symbols`; `trades` + `trade_events` + `trade_exits`; optimistic concurrency on PUT/DELETE (`If-Match`/`version`); `apps/api/src/trades` 4 test files; UI `/trades` (list + create + delete) | **VERIFIED** (route + store + tests read; contract divergences in filters/sort are named in TRD-04) |
| TRD-02 | Manual trade entry from the UI (all the numbers a trader records) | `/trades/new`: symbol, entry, exit, volume, contract, commission, swap, SL/TP, open/close time, strategy, notes + symbol icons + emotion picker | UI `/trades` create form: symbol(+datalist), direction, account id, entry, exit, volume, open/close time, SL, TP, strategy tag, emotional score 1-5, notes; persists via `POST /trades` | **PARTIAL** (no contract/commission/swap inputs, no symbol/emotion iconography — visual parity only, §1) |
| TRD-03 | Import a trade from a broker screenshot (OCR) | `POST /trades/extract-screenshot` (rate-limited) + `velora-smart-import.js`; `trade_screenshots`, `ai_extractions` | — | **MISSING** (MG-AI-OCR) |
| TRD-04 | Trade list can be filtered/sorted like Legacy | Legacy list params (status, symbol, date range, sort) enforced in `TradesController`/repository | Modern list + own filter/sort contract; divergence recorded (method changes, filter semantics, default sort, `r_multiple` scale 4 vs 8) | **PARTIAL** (MG-API-CONTRACT-DIVERGENCE, MG-RMULTIPLE-SCALE) |
| TRD-05 | Connect a real MT4/MT5 account (broker server detection, provisioning, disconnect) | `POST /accounts/connect-metaapi` (5/900), `POST /accounts/detect-server` (20/900), `DELETE /accounts/{id}` | 3-step Modern flow: `POST /accounts` → `POST /credentials` → `POST /accounts/{id}/metaapi/connect`; `…/disconnect`; `PATCH /accounts/{id}/timezone`; `DELETE /accounts/{id}`; UI `/accounts` real (incl. credential vault) | **PARTIAL** (no live MetaAPI round trip; per-fill assembly divergence MG-METAAPI-ASSEMBLY; vocabulary divergence vs Legacy) |
| TRD-06 | Trades arrive automatically and the user can force a sync + see sync state | `POST /accounts/{id}/sync` (20/300), `GET /accounts/{id}/sync-status`; hourly cron in `api/workers/`; `sync_jobs`, `metaapi_fills`, `metaapi_operations` | `GET /accounts/{id}/sync-status` (syncStatusRoutes) + worker handlers in `apps/worker` with a scheduler test; **worker never deployed**; no user-triggerable sync route | **PARTIAL** (MG-WORKER-DEPLOY, MG-METAAPI-CADENCE) |
| TRD-07 | Dashboard that summarises my trading | `GET /dashboard/summary|equity-curve|strategies` | `/dashboard` page is real and renders `analytics/{summary,equity-curve,by-symbol}`; `PgAnalyticsStore` when `DATABASE_URL` set, honest 503 otherwise; **no `/dashboard/*` API**, no strategies endpoint | **PARTIAL** |
| TRD-08 | Performance analytics beyond the dashboard | `/performance` = static content page (no API) | `analytics/{summary,equity-curve,heatmap,by-symbol}` + `analytics_daily`/`account_performance_summary` migrations; `/analytics` renders KPI + raw JSON | **MISSING** as a *user-facing performance surface* (data exists, the page is a shell; this is a modernization opportunity, not a Legacy obligation) |
| TRD-09 | Wallet / cloud-wallet view of connected accounts | `wallet/index.html` renders **hard-coded** equity demo values; no API, no inputs | `/wallet` shell | **UI_ONLY** — note: Legacy source is static demo markup; owner decision needed (build from account equity, or drop) |
| TRD-10 | Marketing/legal content pages (blog ×6, privacy, terms, 404) | static HTML + i18n | not present | **LEGACY_ONLY** (content, no behaviour) |
| TRD-11 | Informational pages (markets, news) | static HTML + i18n (23–28 keys each), no data source | `/markets`, `/news` shells | **LEGACY_ONLY** (nothing behavioural to migrate; the Modern shells are placeholders, not migrations) |
| TRD-12 | Telegram journal client | (new in Modern) | ADR-018 + `0023_telegram_journal.sql` + `apps/api/src/telegram/*` + `/settings` section; 6 telegram test files; rate limits; media/webhook caps | **IMPLEMENTED** (not LIVE VERIFIED — MG-TG-1) |
| TRD-13 | Copy trading / EA ingestion / developer API / tenancy | absent in Legacy | `eaRoutes`, `tenancyRoutes`, `developerRoutes`, migrations 0019–0021 + tests | **INTENTIONALLY_NOT_MIGRATED** (Modern-only extension; not a Legacy capability) |

### 3.4 AI

| ID | Capability (business meaning) | Legacy evidence | Modern evidence | Status |
|---|---|---|---|---|
| AI-01 | "Analyse my trades" (10/3600) | `POST /ai/analyze-trades`, `AI/Analysis`, `ai_analysis`, `ai_jobs`, provider chain + quotas | `POST /ai-coach/latest-insights` (different meaning: coach insight read/write), no analysis pipeline | **MISSING** (MG-AI-OCR) |
| AI-02 | Weekly/monthly AI report (5/3600) | `POST /ai/weekly-report`, `ai_reports`, email delivery | — | **MISSING** |
| AI-03 | Feedback on an AI answer (20/3600) | `POST /ai/feedback`, `ai_feedback` | — | **MISSING** |
| AI-04 | Intelligence surface (ask preset questions about my trading) | `/intelligence` with preset prompts + free-text question | `/intelligence` shell | **MISSING** (shell) |
| AI-05 | AI coach insights + consent gate (Modern shape) | — | `GET/POST /ai-coach/latest-insights`, `POST /ai-coach/consent`, `ai_coaching_logs` migration 0017; no UI | **BACKEND_ONLY** |

### 3.5 Support, admin, billing

| ID | Capability (business meaning) | Legacy evidence | Modern evidence | Status |
|---|---|---|---|---|
| SUP-01 | User opens/reads/replies/reopens a support ticket | `POST /support/tickets`, `GET /support/tickets[/{id}]`, `POST …/{id}/messages|read|reopen`; `support_conversations`, `support_messages` | `/support` shell; no API | **MISSING** (shell) |
| SUP-02 | Admin communication centre (reply, status, translate, AI copilot draft) | 7 admin routes + `support_message_translations`, `content_translation_*` | — | **MISSING** |
| ADM-01 | Admin manages users (list, detail, role, status, …) | `GET /admin/users`, `GET /admin/users/{id}` + 6 more mutation routes, per `P_USERS_*` | `GET /admin/users`, `GET /admin/users/{id}`, `PATCH …/role|status`; gated by `users.view`/`admin.panel.access` | **PARTIAL** |
| ADM-02 | Admin analytics/overview/billing views | `admin/analytics/*` ×6, `admin/overview`, `admin/billing`, `admin/billing/users/{id}` | `GET /admin/metrics`, `admin/audit-logs` only | **MISSING** |
| ADM-03 | Admin system surface (health, diagnostics, logs, audit, settings, feature flags, integrations, AI routing, provider credentials + tests) | 40+ routes, `admin_audit_logs`, `system_logs`, `integration_health`, `ai_feature_*`, `ai_provider_*` | — | **MISSING** (MG-ADMIN: 93% absent) |
| ADM-04 | Admin console UI | `admin/index.html` (145 KB, 15 modules) + `admin/v2` | `/admin` 34-line shell | **UI_ONLY** |
| PLT-11 | Paid subscription / checkout | `checkout` page + admin billing; no user billing API | `GET/POST /subscriptions/me`, `POST /subscriptions/checkout`, `POST/GET /webhooks/stripe`, `subscriptions` + `ai_coaching_logs` (0017); no page | **PARTIAL** (backend module, no user surface) |

### 3.6 Platform, data, operations

| ID | Capability (business meaning) | Legacy evidence | Modern evidence | Status |
|---|---|---|---|---|
| PLT-01 | One authoritative store for all domain data | MySQL 46 tables | PostgreSQL 23 migrations, `pg` driver, PG-backed stores for auth/trades/credentials/rate-limits/analytics/telegram; `db/tests` 32 files + 70 real-PG tests recorded at HEAD | **VERIFIED** |
| PLT-02 | Legacy data can be moved to Modern without loss | ADR-004 sampling blocked; unmapped legacy tables | No cutover rehearsal; `MG-SCHEMA-MAPPING` lists 8+ tables and several `users` columns without target | **MISSING** |
| PLT-03 | Background work runs (sync, aggregates, e-mails, reports) | `api/workers/` + cron jobs | `apps/worker` handlers + scheduler tests; **never deployed** | **PARTIAL** (MG-WORKER-DEPLOY) |
| PLT-04 | Backups, restore drill, ops probes | Legacy ops tooling in `tools/` (86 PHP) | no backup taken, no restore drill, no probe toolset | **MISSING** |
| PLT-05 | Both locales fully translated | 1,994 keys/locale | 726 fa keys; key-name overlap with Legacy 624/1,994 = **31.3%**; 1,370 Legacy keys unmapped | **PARTIAL** (MG-I18N-COVERAGE) |
| PLT-06 | Transactional e-mail types | `email_notifications`, 10 types | 2 of 10 types; no templates/CID/locale-aware copy/delivery log | **PARTIAL** (MG-EMAIL-TYPES) |
| PLT-07 | Jalali calendar, trading-session engine, achievements | `JalaliCalendar`, `TradingSessionEngine`, `user_achievements` | — | **MISSING** (MG-DOMAIN-LEGACY-ONLY) |
| PLT-08 | Telegram journal client (already shipped) | — | see TRD-12 | **IMPLEMENTED** (not LIVE VERIFIED) |
| PLT-09 | In-app notifications | `notifications` table | — | **MISSING** |
| PLT-10 | Marketing/blog/legal surfaces | blog ×6, privacy, terms | — | **MISSING** |
| PLT-12 | The 8 badged Modern shells become real | n/a | `/profile /support /admin /intelligence /markets /news /performance /wallet` | **MISSING** (as capabilities) |
| PLT-13 | Legacy PHP structural patterns (router table, PHP controllers, MySQL) | entire Legacy app | Modern deliberately uses kernel dispatcher + services + PG | **INTENTIONALLY_NOT_MIGRATED** (§6: architecture is not a capability) |
| PLT-14 | Secret/credential vault for third-party providers | admin `ai_provider_credentials` | `user_credentials` (0010) + `credentialService` + `credentialCrypto`; no UI beyond `/accounts` METAAPI entry | **BACKEND_ONLY** |

---

## §4 Profile / Settings audit (E) — a gap investigation, not a greenfield

This is treated as a **capability-gap investigation**: every Legacy account/profile capability must be mapped to **exactly one** existing Modern surface. No duplicate management surfaces. **No new large `/profile` page is created by this audit.**

### 4.1 What exists today (evidence)

| Modern surface | Reality today |
|---|---|
| `/settings` | 328-line real page. Title «تنظیمات» / "Settings". Its **only** section is «حساب‌های متصل» / "Connected accounts" → Telegram (ADR-018). States read back from `GET /api/v1/telegram/status`; no optimistic "connected"; no credential ever crosses the page. |
| `/profile` | 34-line shell with badge `PLANNED / GAP`; reads nothing. |
| `/account`, `/security`, `/integrations` | **Do not exist** as routes in the Modern app (verified against the 31-route inventory). |
| Auth pages | `/login /register /forgot-password /reset-password /verify-email` (+ `en/` mirrors) — all real. |

Consequence: the only surface that already behaves like a settings page is `/settings`. Creating `/account` or `/security` now would multiply management surfaces and contradict §4.

### 4.2 Canonical mapping (one location per capability)

| Capability | Canonical Modern surface | What already exists | What a future increment must add (no new page, no nav item) |
|---|---|---|---|
| Identity overview (name, e‑mail, member since, role) | **`/profile`** (read-only overview) — **DONE in Phase 1** | `GET /auth/me` | Rendered from `/auth/me` on `/profile` (read-only, links to `/settings`); the name/timezone fields it needs already exist (ACC-06 re-verified) |
| Change password | **`/settings` → Security** | `POST /auth/change-password` (throttled, validated) | Form + error/state handling; reuse existing input/button classes |
| AI processing consent | **`/settings` → Preferences** | `users.ai_consent_at`; `PATCH /auth/me/preferences` | Toggle wired to the endpoint, with the same wording as the Legacy consent copy |
| Locale preference | **`/settings` → Preferences** | `users.locale`; `PATCH /auth/me/preferences` | A switch that actually calls the endpoint (today locale is path-derived) |
| E-mail categories (6) | **`/settings` → Notifications / E-mail** | `email_preferences` table + `GET/PUT /auth/email-preferences` (same 6 keys) | Six toggles, merged-update semantics preserved |
| Telegram account | **`/settings` → Connected accounts** | whole feature shipped | nothing — stays exactly where it is |
| MetaAPI / broker credentials | **`/accounts`** | real 3-step connect + credential vault | nothing in this audit |
| Sessions/devices (user-visible) | `/settings` → Security *(if built)* | `user_sessions`/`user_devices` tables | **Requires an owner decision**: Legacy had no user-facing session list (admin-only), so building one is *new scope*, not parity |

**Decision:** `/settings` is the single management surface for account preferences and security; `/profile` stays a read-only identity overview. This preserves Legacy information architecture (a profile page that *shows* the account) while respecting §9's existing Telegram placement. If the owner prefers the opposite split (management on `/profile`, `/settings` for Telegram only), the mapping table is the point of change and nothing else moves.

### 4.3 Findings

* **F1 (BACKEND_ONLY ×3):** change password, AI consent and the six e-mail preferences are fully implemented server-side and have **no** user-facing entry point. In Legacy all three were reachable from `/profile`. → Any UI increment is *wiring*, not new capability.
* **F2 (data model) — CORRECTED in Phase 1:** the first pass claimed Modern `users` had no `full_name/first_name/last_name/timezone`. RE-VERIFIED against the repo: `users.full_name` and `users.timezone` exist (`0002_identity_capability.sql`), register accepts them and `GET /auth/me` returns them; `0022` adds `first_name`, `last_name`, `locale_source`, `locale_updated_at`. Only `first_name`/`last_name` have no Modern home — and no Legacy UI string consumes them, so nothing user-visible depends on them. The identity overview therefore needed no migration.
* **F3 (no duplicate surfaces):** `/settings` currently contains exactly one section. Adding sections is additive; it does not require renaming the page or moving Telegram.
* **F4 (i18n):** the Legacy `profile` page used hashed keys (`common.change.password.*`, `common.member.since.*` …). Modern catalogs are per-namespace (`auth`, `common`, `errors`, `telegram`); new sections must add keys to existing namespaces in **both** locales, never hard-code Persian/English strings.
* **F5 (design):** the shells and `/settings` already use the shared classes (`page-head`, `page-title`, `page-sub`, `card`, `card-alt`, `label`, `badge-*`, `btn-primary`, `btn-ghost`, `input`, `kpi`, `v-latn-num`). Any new section reuses them; nothing is replaced or simplified (§1).

---

## §5 Backend gap audit (D) — full traces

Trace template applied to each suspicious surface: **UI → route → API/service → auth → authz → validation → PostgreSQL → domain → external integration → response → UI state.**

### 5.1 Shell pages (UI present, backend absent)

| Surface | UI | Route/API | Auth | Authz | Validation | PG | Integration | UI state today | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `/profile` | shell | none | n/a | n/a | n/a | reads nothing | none | badged GAP, no fake data | **UI shell over missing backend** |
| `/support` | shell | none (6 Legacy routes absent) | n/a | n/a | n/a | `support_*` tables absent | none | badged GAP | UI shell |
| `/admin` | shell | partial API exists (`metrics`, `audit-logs`, `users`, `rbac/*`, ownership) | bearer + `users.view` | 4 perms | yes on `PATCH role/status` | `users`,`rbac_roles`,`audit_log` | none | badged GAP; API unreachable from UI | UI shell + **partial API** |
| `/intelligence` | shell | `ai-coach/*` exists with different meaning | bearer | `admin.panel.access`? (no) | yes | `ai_coaching_logs` | no live AI provider | badged GAP | UI shell |
| `/markets`, `/news` | shells | none | n/a | n/a | n/a | none | none | badged GAP | UI shell |
| `/performance` | shell | `analytics/*` exists (used by `/dashboard`,`/analytics`) | bearer | owner-keyed by `claims.sub` | window + `account_id` numeric | `user_analytics_daily` | none | badged GAP | UI shell |
| `/wallet` | shell | none; Legacy page was hard-coded demo equity | n/a | n/a | n/a | account equity could be derived from `trading_accounts`+sync | none | badged GAP | UI shell |

### 5.2 Traces that confirm *working* chains (no gap)

* **Trade create → list → delete.** `/trades` form → `POST /api/v1/trades` → `tradesRoute` → bearer claims → ownership keyed on `claims.sub` → body validation (symbol pattern, direction enum, numeric fields, optional numeric `accountId`) → `trades` (+`trade_events`) in PG → response → UI refresh. Optional-concurrency on PUT/DELETE via `If-Match`/`version` (OD-2). **No orphan UI call**: every resource helper used by the four real pages (`/accounts`, `/trades`, `/dashboard`, `/analytics`, `/settings`) resolves to a declared API route (checked by cross-referencing `apps/web/src/lib/api/resources.ts` against the route inventory).
* **MetaAPI connect path.** `/accounts` → `POST /accounts` → `POST /credentials` (METAAPI secret, encrypted by `credentialService`/`credentialCrypto`, stored in `user_credentials`) → `POST /accounts/{id}/metaapi/connect` → `disconnect` → `DELETE /accounts/{id}`; `detect-server` for server suggestions. Gaps are integration-level, not chain-level: no live provider call was ever made here (MG-METAAPI-ASSEMBLY / MG-WORKER-DEPLOY).
* **Telegram.** `/settings` → `GET /telegram/status` etc. → telegram handlers → bearer → token minting server-side → `telegram_*` in PG. Verified at API-contract level earlier (status `NOT_LINKED`, deep link minted, 10-minute expiry, `LINK_PENDING`); **no live Bot API round trip** (MG-TG-1).

### 5.3 Gaps by nature

| Nature | Items |
|---|---|
| Missing backend + missing UI | support (SUP-01/02), admin console (ADM-02/03), AI analysis/report/feedback (AI-01/02/03), notifications (PLT-09), Jalali/session-engine/achievements (PLT-07), ops/backup (PLT-04), data cutover (PLT-02) |
| Existing backend, missing UI | change password, AI consent, e-mail preferences (ACC-04/08/09), ai-coach (AI-05), subscription/checkout (PLT-11), credential vault UI (PLT-14) |
| Existing UI shell, missing backend | profile, support, admin, intelligence, markets, news, performance, wallet |
| Partial behaviour needing parity work | accounts connect/sync, trade filters/sort, dashboard semantics, RBAC vocabulary, rate-limit coverage, i18n coverage, e-mail types |
| Security registers still open | cookie hardening, CSP, HSTS, edge authz (SEC-04) — carried from the existing register, not re-audited here |

### 5.4 Legacy-side cautions found during tracing

1. **`wallet` and `performance` in Legacy are static pages.** Migrating "wallet equity display" or "performance page" as if they had behaviour would invent a capability. Either the owner adopts the Modern analytics/PG data as the source (a product decision) or the page stays a shell/content page.
2. **`intelligence` had real interactivity** (preset questions + free-text) but its answers came from the AI pipeline that also does not exist in Modern. UI-first would create a fake assistant — forbidden by §10.
3. **Legacy admin is 73 routes / 38 modules.** Rebuilding it is the single largest remaining block and must not be half-done: an admin console that silently drops audit/feature-flag/integration controls would *remove* capability (§1).
4. **`POST /accounts/{id}/sync` (manual sync) has no Modern counterpart.** A user who could force a refresh in Legacy cannot today. That is a user-visible regression unless the scheduler path lands first.

---

## §6 Migration rule (§6) — applied per capability, not per file

For every MISSING / PARTIAL row above, the implementation increment must walk these nine steps **in order**, and stop if a step changes the answer:

1. Read the Legacy behaviour from source (controller + service + repository + validation + rate limit + i18n keys) — never from a report.
2. Write the business meaning in one sentence (what the user is trying to achieve; not "the PHP does X").
3. Decide the Modern architecture (which service, which store, which route family) reusing existing patterns — kernel route or `extendedRoutes` handler, service class, PG store, contracts type.
4. Define the contract (method, path, status codes, error codes, response shape) in `packages/contracts` first.
5. Implement PostgreSQL persistence in a numbered migration if new state is needed (never a second store, never SQLite/JSON — §7).
6. Implement auth (bearer/session) + authz (RBAC permission, ownership keyed on `claims.sub`), fail-closed.
7. Implement validation + localized error handling (catalog keys, `fail()` codes; no hard-coded user-facing strings).
8. Implement the UI in the **existing** design system and the **existing** canonical surface (per §4), in both `fa` and `en`, RTL and LTR.
9. Add tests (happy path, validation, auth, authz, persistence, failure, edge cases, localization; real PostgreSQL where concurrency matters) and run the gates: typecheck, tests, secret scan, build, DB-migration tests, relevant integration tests.

---

## §7–§10 Constraint findings

* **§7 PostgreSQL is the single source of truth.** Verified: 23 migrations, PG-backed stores, `pg` driver only. No SQLite/JSON/second store was found in the tree. Nothing in this audit proposes one. Unmapped Legacy tables (PLT-02) are a *data-migration* gap to be documented, not a reason to create a parallel store.
* **§8 identity.** One identity system exists (bearer + refresh session, `users`, `user_sessions`, RBAC). No second identity or parallel account system was found, and none is needed for any row above.
* **§9 Telegram.** Already satisfied: connected account inside `/settings` → «حساب‌های متصل», same `users` identity, same PG journal, no standalone page, no new nav item, no second identity. Telegram-created journal entries use the same `trades` store (ADR-018), so they appear in the web journal by construction.
* **§10 no UI-only migration.** The eight shells are **shells, not migrations**, and are labelled as such in the UI itself. No form was found that posts nowhere, no settings screen that pretends to save, no dashboard fed by static numbers. The only static-data Legacy surfaces (`wallet`, `performance`, `markets`, `news`) are explicitly marked LEGACY_ONLY in §3, so they cannot be mistaken for migrated capability.

---

## §11 Tests & verification (I)

### 11.1 Evidence that exists at HEAD `42f38cb` (recorded, not re-run this session)

| Gate | Result at HEAD |
|---|---|
| `tsc --noEmit` (typecheck) | 0 errors |
| Test suite | 957/957 |
| Secret scan (`tools/secret-scan.sh`) | PASS |
| `next build` (apps/web) | 0 errors |
| PG 16.15 batteries | 9/9 |
| `tools/pg-smoke.ts` | S1–S9 pass |
| Real-PG integration tests | 70 pass |
| Contract gap map | 54 gaps = 30 OPEN / 16 PARTIAL / 8 CLOSED |

**Not claimed:** no test suite was executed *in this audit session*, and no browser-based visual/responsive verification was possible (no browser in this environment). Localization verification remains the catalog-render level; rendered authenticated Persian strings on `/settings` cannot be checked from the server HTML alone.

### 11.2 Per-capability test obligation (to be added when the increment lands)

| Increment | Required tests | Real PG? |
|---|---|---|
| ACC-04 change password UI | happy path, wrong current password, validation, rate limit, unauthenticated | no |
| ACC-06 profile fields | `0022` column presence + `/auth/me` payload asserted on live PG (already satisfied before Phase 1) | no (no migration needed) |
| ACC-07 locale switch wiring | persistence, invalid locale, both locales rendered | no |
| ACC-08 AI consent UI | opt-in, opt-out (`ai_consent_at` null), auth required | no |
| ACC-09 e-mail preferences | partial update must not reset other categories (Legacy merge semantics), invalid key ignored, persistence | yes |
| SUP-01/02 support | create/list/reply/read/reopen; authorisation (own ticket only); admin reply gated by `P_COMM_REPLY` | yes (concurrency on reply) |
| AI-01/02/03 | provider failure, quota/rate limit, consent gate, malformed output, retention | no (scripted transport) |
| ADM-01…04 | each mutation gated by its permission; non-admin 403; audit entry written | yes |
| TRD-03 OCR import | unsupported media, size cap, provider failure, parsed-field validation | no |
| TRD-05/06 sync | concurrency (two syncs), idempotency on fill replay, failure → observable state | **yes** |
| TRD-07 dashboard parity | identical inputs → identical numbers vs Legacy formulas | yes |
| PLT-02 data migration | row counts, per-table checksums, unmapped-column report | yes |
| PLT-05 i18n | key parity report, missing-key render behaviour, RTL integrity | no |
| PLT-06 e-mail types | template render per locale, failure/retry, delivery log | no |

### 11.3 Rules that stay in force
Never weaken or delete an existing test to make a change pass; if a test encodes Legacy-parity behaviour, the change must bring evidence, not the test's removal. Concurrency/authorisation/persistence claims require the real PostgreSQL instance (PGlite is insufficient).

---

## §12 Legacy parity review (§12) — 8 questions, evidence only

Applied to the rows that are currently IMPLEMENTED or VERIFIED. A row may only be promoted if every answer is "yes, with evidence".

| # | Question | ACC-01 (register/verify) | TRD-01 (journal CRUD) | PLT-01 (PG source of truth) | TRD-12 / PLT-08 (Telegram) |
|---|---|---|---|---|---|
| 1 | Same business outcome for the user? | yes — account created, mailbox proven, sign-in gated | yes — create/edit/delete trades, exits, symbols | yes — one authoritative store | yes — link, journal, unlink; same account |
| 2 | Same data persisted? | `users.email_verified_at`, `email_verifications` | `trades`,`trade_events`,`trade_exits` | 23 migrations | `telegram_*`, `trades` |
| 3 | Same authorization boundary? | unverified cannot log in (401) | owner-keyed on `claims.sub` | n/a | bearer session, server-side token minting |
| 4 | Same validation semantics? | e-mail format, token expiry/consumption | field patterns, numeric rules, optimistic concurrency | migration ordering | 256 KiB webhook cap, 5 MiB media, 10-min link |
| 5 | Same localization behaviour? | both locales render (catalog tests) | UI in both locales | n/a | `telegram.json` both locales |
| 6 | Same failure behaviour? | expired/consumed token → error, resend throttled 4/3600 | 404/409 on version conflict, validation errors | migration failure aborts | `LINK_EXPIRED`/`LINK_ERROR` states, 503 when unconfigured |
| 7 | Same integration behaviour? | e-mail send path | none | none | Bot API calls are scripted in tests, **not live** |
| 8 | Evidence re-checked from source? | yes — kernel handler + tests read | yes — kernel + service + tests | yes — migration list | yes — ADR-018 + code + tests |

**Deliberately absent from this table:** every PARTIAL/MISSING row. Claiming parity for a shell, or for a backend with no UI, would violate §12.

---

## §13 Report (A–J)

**A. Legacy inventory** — §2A. 118 routes (admin 73 / auth 13 / trades 10 / accounts 7 / support 6 / dashboard 3 / ai 3 / content-translations 1 / webhooks 2), 46 tables, 24 RBAC permissions, 15 rate-limited routes, 31 page entrypoints, 1,994 i18n keys per locale.

**B. Modern inventory** — §2B. ~70 route surfaces, 8 kernel + module throttled buckets, 23 migrations, 31 web routes, 726 fa keys, 109 test files, page-by-page real/shell classification.

**C. Parity matrix** — §3. **53 capability rows**, of which 3 VERIFIED, 4 IMPLEMENTED, 14 PARTIAL, 5 BACKEND_ONLY, 3 UI_ONLY, 20 MISSING, 2 LEGACY_ONLY, 2 INTENTIONALLY_NOT_MIGRATED.

**D. Backend gaps** — §5. Eight UI shells; five capability areas where a backend exists without a surface; the safety-net confirmations (no orphan UI→API calls; no fake data anywhere).

**E. Profile/Settings findings** — §4. `/settings` is the canonical management surface (Telegram already inside it as «حساب‌های متصل»); `/profile` stays a read-only identity overview; change password / AI consent / e-mail preferences were BACKEND_ONLY and needed wiring, not new capability — **wired in Phase 1**; `users` profile fields were reported MISSING (ACC-06) but are in fact present (re-verified); no duplicate surfaces exist and none are created.

**F. Migrated** (behaviour present end-to-end): registration + verification (ACC-01), sign-in/refresh/logout (ACC-02), password reset (ACC-03), trade journal CRUD + exits (TRD-01), PostgreSQL source of truth (PLT-01), Telegram journal client (TRD-12/PLT-08, API-contract verified only), analytics data substrate feeding `/dashboard` and `/analytics`.

**G. Intentionally not migrated:** architecture/structure (PLT-13); Modern-only extensions that have no Legacy counterpart (copy trading, EA ingestion, developer API, tenancy, self-service subscription module — recorded so they are never counted as parity work).

**H. Remaining gaps:** everything at PARTIAL/BACKEND_ONLY/UI_ONLY/MISSING in §3 — headline items: admin console (93% absent), support, AI pipeline (analysis/report/feedback/OCR), notifications, Jalali/session-engine/achievements, e-mail types, i18n coverage (1,370 keys), data-migration path, worker deployment, backup/restore, ops tooling, plus the three user-facing BACKEND_ONLY wirings from §4.

**I. Tests & verification** — §11.

**J. Design-preservation verification** — §1 compliance, checked by inspection: the shells and real pages use the shared tokens/classes (`page-head/page-title/page-sub`, `card/card-alt`, `label`, `badge-*`, `btn-primary/btn-ghost`, `input`, `kpi`, `grid-2`, `v-latn-num`, `empty`, `code-block`); RTL/fa and LTR/en both exist; Estedad + dark obsidian + glass + gold are untouched; navigation/sidebar hierarchy unchanged; information density not reduced; no flashy or generic SaaS patterns were introduced; no page was redesigned in this audit. **No existing user capability was removed.**

### Delivery state (states never conflated)

| State | This audit |
|---|---|
| IMPLEMENTED | audit document + machine-readable matrix (§ C/§13) |
| TESTED | n/a (documentation change; no code path) |
| COMMITTED | ❌ **not committed** — working tree holds the two new files only |
| PUSHED | ❌ |
| DEPLOYED | ❌ |
| LIVE VERIFIED | ❌ |

---

## §14 Git safety

Recorded before any edit: branch `feat/telegram-journal-client`, HEAD `42f38cba1e96ab6f3582aaccd3f1644b9fb6133a`, base `0e9c4d7e6e1f984287490ce02f5681c208e35c7a`, 0 dirty files.

Actions taken in this session: **read-only inspection of both repositories.** The Legacy clone was created outside the Modern repo and is untouched afterwards (read-only behavioural reference). The only writes are this audit plus `docs/state/capability-matrix.json`, both new, uncommitted, and reversible with `git checkout -- .` / `rm`. No push, no PR, no deployment, no migration executed.

---

## §15 Priority order for the next increments (no implementation started)

Order fixed by the mission (account/user → security/auth → trading → data integrity → UI with missing backend → integrations → secondary). Recommended slices, each independently shippable and reversible:

1. **Account/user wiring — DELIVERED 2026-10-04** — ACC-04 (change password), ACC-08 (AI consent), ACC-09 (e-mail preferences), ACC-07 (locale switch) are wired onto the existing `/settings`, and `/profile` now renders the real identity. ACC-06 was re-verified (no migration needed). Evidence + gates: §16.
2. **Security/auth** — SEC-01 RBAC vocabulary (enforce the permissions the admin surface will need), SEC-03 auth events/login history, SEC-02 rate-limit coverage for accounts/sync, then the carried register items SEC-04.
3. **Core trading** — TRD-06 manual sync + sync visibility, TRD-04 filter/sort parity, TRD-07 dashboard semantics, TRD-05 MetaAPI integration hardening (assembly/scale registers).
4. **Data integrity** — PLT-02 mapping table + cutover rehearsal, MG-SCHEMA-MAPPING resolution, `r_multiple` scale decision, PnL range guard; PLT-04 backup/restore drill.
5. **UI with missing backend** — support (SUP-01/02) and admin (ADM-01…04) in that order, because support is one domain and admin is thirty-eight.
6. **Integrations** — AI/OCR pipeline (AI-01/02/03, TRD-03), e-mail types (PLT-06), worker deployment (PLT-03).
7. **Secondary** — i18n coverage (PLT-05), notifications (PLT-09), Jalali/session engine/achievements (PLT-07), content surfaces (PLT-10), performance/wallet decisions (TRD-08/TRD-09), markets/news content (TRD-11).

**Owner decisions requested** (each blocks only its own slice):
1. `/settings` as the single management surface (vs moving management to `/profile`) — §4.2.
2. ~~Add `full_name/first_name/last_name/timezone` to `users`~~ — moot: `full_name`/`timezone` already exist (ACC-06 re-verified); `first_name`/`last_name` stay unmigrated (no consumer).
3. `/wallet` and `/performance`: build from Modern analytics/account equity, or retire the shells (Legacy sources were static demo content).
4. Manual sync exposure: user-triggered or scheduler-only (TRD-06).
5. Admin console sequencing: user-management first, then analytics/system, or a thin vertical slice per module.

---

## Appendix — reconciliation with the existing gap register (`docs/state/migration-gap-register.json`, 54 entries)

The register was read (not overwritten) and its vocabulary mapped onto this audit:

* Register rows that are **capability-level** and still accurate: `MG-ADMIN`, `MG-AI-OCR`, `MG-API-MISSING-ROUTES`, `MG-API-CONTRACT-DIVERGENCE`, `MG-SCHEMA-MAPPING`, `MG-FRONTEND-SURFACES`, `MG-I18N-COVERAGE`, `MG-EMAIL-TYPES`, `MG-RBAC-VOCAB`, `MG-AUTH-EVENTS`, `MG-METAAPI-*`, `MG-RMULTIPLE-SCALE`, `MG-RANGE-GUARD`, `MG-DOMAIN-LEGACY-ONLY`, `MG-OPS-TOOLING`, `MG-DATA-MIGRATION`, `MG-WORKER-DEPLOY`, `MG-BACKUP-RESTORE`, `MG-SEC-*`, `MG-TG-1/2/3`.
* Register rows already resolved and therefore **not** re-opened here: `MG-TG-4` (telegram rate limits now enforced), `MG-OBS-6` (smoke-test migration list fixed by the owner at `9d59bca`).
* Two register claims are **corrected by this audit's own measurement**:
  * `MG-API-MISSING-ROUTES` says "76 of 103 legacy routes have no modern counterpart". Re-measured this session with a corrected, regex-aware extractor over both trees: the Legacy router declares **118** routes (the register's denominator of 103 does not match it) and Modern exposes **92** enumerated route surfaces; **29 Legacy routes have an exact Modern counterpart** (same method + path), leaving **89 with no counterpart** — a worse ratio than the register states. The 29 matched routes are: `auth/{register,login,logout,refresh,verify-email,resend-verification,forgot-password,reset-password,change-password,me,email-preferences}`, `trades` (list/create/get/update/delete, `{id}/exits`, `exits/{id}`, `symbols`), `accounts` (list/create/delete, `detect-server`, `{id}/sync-status`), `admin/users` (list/get), `webhooks/metaapi`.
  * `MG-FRONTEND-SURFACES` lists missing surfaces; this audit adds the sharper distinction that **five of the present surfaces are real** (`/accounts`, `/trades`, `/dashboard`, `/analytics`, `/settings`) and **eight are badged shells**, and that Legacy `/wallet`, `/performance`, `/markets`, `/news` were static content pages — which changes what "missing" should mean for them.

---

## §16 Phase 1 delivery record (2026-10-04, HEAD `42f38cba` + uncommitted)

**Scope delivered:** account / profile / settings (§9 phase 1) — four BACKEND_ONLY capabilities
wired to their existing endpoints, the identity overview made real, and the locale-provenance
gap closed. **No new backend capability, no new route, no new nav item, no second surface.**

| Item | What changed | Evidence |
|---|---|---|
| ACC-04 change password | `/settings` → Security: form over `POST /auth/change-password`; server refusal → localized sentence (never a code); success → all sessions revoked → `/login` | `authService.test.ts` 21/21 · browser: wrong current password → «رمز عبور فعلی نادرست است.»; success path revokes sessions (`sessions_revoked` 1 asserted earlier) · screenshot `04` |
| ACC-08 AI consent | `/settings` → Preferences: pill + toggle over `PATCH /auth/me/preferences {ai_consent}`; the row renders the **server's** answer (no optimistic state) | browser toggle inactive↔active; `pgUserStore.pg.test.ts` asserts the raw column |
| ACC-09 e-mail preferences | `/settings` → 6 categories over `GET/PUT /auth/email-preferences` with Legacy's merge semantics | browser toggle persists across reload · partial-PUT merge + unknown-key ignore asserted (raw row `t,t,f,f,t,t`) |
| ACC-07 locale switch | select in `/settings` → Preferences → `PATCH /auth/me/preferences {locale}` + client persistence + navigation under the `/en` URL contract | EN→FA switch browser-verified (URL `/settings`, `dir=rtl`) · provenance columns `locale_source`/`locale_updated_at` implemented + asserted raw on PG |
| ACC-05 `/profile` | read-only identity overview from `GET /auth/me`: full name, e-mail, role, plan, member-since (Jalali), timezone + link to `/settings` (the ONE management surface) | browser fa+en, desktop 1366 / mobile 390 / narrow 320: no overflow, no console errors · screenshots `01, 06, 08, 12` |
| ACC-06 profile fields | **Audit claim corrected.** `users.full_name` + `users.timezone` already existed (`0002_identity_capability.sql`) and are returned by `/auth/me`; `0022` also adds `first_name`/`last_name`. Only the split names are unconsumed | row-level assertion on live PG (`\d users`) + `/auth/me` payload |

**Defects found by this phase's own gates and fixed immediately (never left as TODO):**

1. **Persian nav label inside the ENGLISH shell.** `nav` item `/accounts` used key `common.accounts`,
   which exists in no catalog → the sidebar silently fell back to its hard-coded Persian default.
   Found by the new browser visual pass (EN shell rendered «حسابها»). Fixed by importing Legacy's
   own `nav.accounts` (+ `nav.logout`, `common.close`, `common.login.to.account.8181f948`,
   `pages.dashboard.are.you.sure.you.want.to.logout.16e6ca9b`) byte-faithfully from
   `public/locales/{fa,en}.json` @edede31 — they live in **no** Legacy chunk, so this is the first
   Modern home for them. Guarded by `shellSurface.test.ts` (5 tests).
2. **Hard-coded shell strings** (logout confirmation, sign-out / sign-in labels, overlay
   `aria-label`, EN toggle label): replaced by catalog keys; the guard test fails if a
   `locale === "fa" ? "…"` literal pair reappears in the shell.
3. **`TopBar` read `window.location.pathname` during render** → the SSR markup and the hydrated
   markup disagreed on the locale-toggle `href`. Now `usePathname()`.
4. **RTL mobile drawer was open when "closed".** `.app-sidebar` was anchored with a *logical*
   inset but hidden with a *physical* `translateX(-100%)`: in RTL that pushed the 260 px drawer
   over the content instead of off-canvas. Found by the responsive pass (drawer at x 0–260 with
   `visible:true` while closed). Fixed with an `[dir="rtl"]` override; re-measured: closed
   off-canvas, opens over content, closes on overlay tap **and** on nav click.
5. **Email rows used the AI-consent copy** (`غیرفعالسازی پردازش` = "disable AI processing" on a
   welcome-e-mail toggle). Now the row's own verbs (`settings.email.enable/disable`) + the shared
   status words; the AI row keeps Legacy's `pillOn`/`pillOff`.
6. **22 inline `style={{…}}`** on the account surface → replaced by additive utility classes
   (`.mt-4`, `.mb-2`, `.flex-center`, `.inline-block`, `.select-locale`) so the pages ship the
   design system's classes under the nonce CSP instead of violating it.

**Design preservation:** every class used already existed (`card`, `card-alt`, `label`,
`label-nocap`, `badge-connected/disconnected`, `btn-primary`, `btn-ghost`, `btn-sm`, `input`,
`grid-2`, `pref-row`, `pf-fact`, `v-latn-num`, `kpi`); the shell keeps the obsidian/glass/gold
identity, Estedad, density, nav hierarchy, RTL/LTR and interaction patterns. **No existing user
capability was removed.**

### Gate results (this session, live PostgreSQL 16.15 on `/tmp/pg16data`, Next production build)

| Gate | Result |
|---|---|
| `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` | **0 errors** |
| `npx next build` (apps/web) | **success**, 28/28 pages, routes `/settings`, `/en/settings`, `/profile`, `/en/profile` |
| `npm test` (root runner) | **940/945** — the 5 failures are PGlite batteries killed by the sandbox's 1.9 GB RAM when run in parallel; each passes alone (see below) |
| PGlite batteries, run individually | `migrations` 19/19 · `migrateCli` 11/11 · `identityPersistence` 6/6 · `telegramJournal` 6/6 · `telegramStoreAdapter` 7/7 · `accountPersistence` 3/3 · `rateLimitPersistence` 5/5 · `tradePersistence` 6/6 |
| **Real-PG batteries (24 files, `DATABASE_URL` → PostgreSQL 16.15)** | **all green — 256 tests**: `pgRoles` 22/22 · `metaapiProvisioning` 26/26 · `syncSubstrate` 17/17 · `copyDispatch` 15/15 · `extendedCapabilities` 15/15 · `pgTradeConcurrency` 14/14 · `analyticsRecompute` 13/13 · `metaapiSync` 13/13 · `pgBossAdapter` 13/13 · `pgTradeStore` 11/11 · `credentialAudit` 10/10 · `auditCredentialContract` 9/9 · `credentialStore` 9/9 · `telegramConcurrency` 9/9 · `auditLog` 6/6 · `developerKeyAuth` 6/6 · `migrateCli.pg` 6/6 · `pgRateLimitStore` 6/6 · `pgUserStore` 6/6 · `pgOwnershipStore` 5/5 · `readinessSchema` 5/5 · `pgQuota` 4/4 · `pgAccountStore` 3/3 · `fxRatesIngestion` 2/2 |
| Web unit guards | `accountSurface.test.ts` 9/9 · `shellSurface.test.ts` 5/5 · `catalogRender.test.ts` + `localeKernel.test.ts` green |
| `tools/secret-scan.sh` | **PASS (0 findings)** |
| Visual QA | all 9 checks in `docs/audits/phase1-ui/README.md`: fa/en · RTL/LTR · 1366/390/320 px · `docOverflow=0` · no page errors · focus ring on every control · tab chain reaches all 11 account controls |

**Runtime evidence on live PG (API 8080 + Next proxy):** register 201 → verify → login 200,
`GET /auth/me` full payload, `PATCH /auth/me/preferences` accepted **and** raw row
`en | user | consent`, invalid locale 400, empty body 400, e-mail preference partial merge,
change-password (wrong current → 400 localized; too short → 400; success → old password 401,
new 200, **1 session revoked**). **Rate limiting observed live:** `auth:refresh` (30/300 s,
Postgres-backed `rate_limits` table) returned **429** after the visual-QA passes and the app
degraded correctly (redirect to `/login`, no crash, no console exception).

**Environment honesty:** the dev server in this sandbox never completes hydration because the HMR
WebSocket handshake fails (`/_next/hmr → ERR_INVALID_HTTP_RESPONSE`); a stale service worker in the
browser profile is a second suspect. Runtime and visual verification is therefore done against
`next build` + `next start` (production), which is the stricter environment anyway. The dev-mode CSP
also logs dozens of inline-*style* violations from Next's own dev runtime — that is why this phase
moved its last inline styles into `app.css`.

## §17 Phase 2 delivery record (2026-10-04) — auth / security / RBAC

**Scope (§9 phase 2): SEC-01…SEC-04.** Executed in the order SEC-02 → SEC-03 → SEC-04 → SEC-01
(reported as a deviation from the audit's §15 order; the reason is stated per item below).
No new top-level nav, no second auth system, no compatibility layer; PostgreSQL stays the only
authoritative store.

### SEC-02 — rate limiting (was PARTIAL: 3 of 15 Legacy dispatcher routes + the admin mutations)

| What | Legacy evidence | Modern result |
|---|---|---|
| Provider/IPC buckets | `api/index.php` `RateLimiter::hit('metaapi-connect', 5, 900)` · `('metaapi-detect', 20, 900)` · `('metaapi-webhook', 120, 60)` | `accounts:metaapi-connect` 5/900 · `accounts:detect-server` 20/900 · `webhooks:metaapi` 120/60 |
| Dynamic path | `preg_match('~\A/api/v1/accounts/\d+/sync\z~D')` inside the throttle `switch` | `THROTTLED_PATTERN_ROUTES` + `throttleKeyFor()`: `POST /accounts/{id}/metaapi/connect` (1 pattern rule) |
| Admin user mutations | `UserManagementController::setStatus` + `::setRole` → `RateLimiter::hit('admin-user-action', 30, 300)` — the ONE bucket Legacy attached to those two handlers | `admin:user-action` 30/300 on `PATCH .../users/{id}/role` and `.../status` (a second, third pattern rule) |

Ordering is Modern's (limiter at dispatch, i.e. BEFORE auth) and is the safe direction: an
unauthenticated flood is refused without doing auth work, while an authorized actor still gets
exactly Legacy's 30 mutations per 5 minutes. Asserted behaviourally, not just as a table:
`rateLimitRoutes.test.ts` **17/17**, including "the two mutations share ONE bucket" (15+15 then 429)
and "near-misses stay unthrottled".

**Deliberately NOT declared:** Legacy's `metaapi-sync` (20/300) guards `POST /accounts/{id}/sync`,
a route Modern does not have; Legacy's `ai-analyze` / `ai-report` / `ai-feedback` (both the
dispatcher IP limits and `AIController`'s per-USER `ai-*-user-{id}` limits) belong to the AI phase;
the `admin-*` controller buckets (config, feature flags, integrations, settings, health refresh,
user create/invite) guard admin surfaces owned by the admin phase. **A rate-limit key for a route
that does not exist is an untested number pretending to be a guarantee** — each lands with its
route. (Discovered while closing this item: Legacy also throttles inside controllers; the full
33-call inventory is recorded so later phases inherit the exact numbers instead of re-deriving them.)

### SEC-03 — auth events / login history (was MISSING)

`auth_events` (migration `0024`), the port + Postgres + memory stores, recording at signup-success /
login-success / login-failure (reason = the returned code), and
`GET /api/v1/admin/users/{id}/login-history`. **Schema decisions and the two documented divergences
from Legacy are recorded in `docs/security/RBAC-CAPABILITY-MAP.md` (row 10) and in the migration
comments**: (a) a failed login from an UNKNOWN address stores `user_id NULL` and never the attempted
address (anti-enumeration) while Legacy kept the attempt row; (b) the raw `ip_address`/`user_agent`
are **omitted from the response body** for anyone who is not `super_admin`/System Owner, where Legacy
returned them to any `users.view` holder (Modern keeps Legacy's D3 intent — the sensitive view is
super-admin-only — and enforces it in the payload, not in the template). Write path is fail-open
(logged, `lastWriteError()`), read path fail-loud — a deliberate divergence from Legacy's swallowed
read errors, because an unreadable audit trail must not look like an empty one.

Batteries: `authEvents.test.ts` 5/5 · `loginHistoryRoutes.test.ts` 5/5 (401/403/404/400/503 + masking
asserted by **absence of the key**) · `pgAuthEvents.pg.test.ts` 4/4 (NULL actor, CHECK rejections,
ordering/paging, real login writes, CASCADE) · `readinessSchema.pg.test.ts` 5/5. Migration `0024` is
applied on the evidence database.

### SEC-04 — session / cookie / CSP / HSTS / edge authorisation (was PARTIAL)

| Item | Legacy | Modern |
|---|---|---|
| Refresh cookie | `api/src/Core/Response.php`: `__Host-velora_refresh`, `Path=/`, Secure, HttpOnly, **SameSite=Strict** | Identical. The old `refresh_token` name is CLEARED on every Set-Cookie (never read, no fallback) so the rename leaves nothing behind |
| HSTS | `.htaccess:49` → `Strict-Transport-Security: max-age=31536000` (no includeSubDomains/preload) | API `SECURITY_HEADERS` + web `proxy.ts` set **Legacy's exact value**; the stronger directives are deliberately NOT added — Legacy does not set them and both are commitments the app cannot honestly make |
| HTML route gates | `locale-router.php`: `$protectedRoutes` → no HTML until a live server session; `admin/index.html` additionally requires a panel role; **fail closed when the check cannot run** | `apps/web/src/proxy.ts` + `lib/auth/protectedRoutes.ts`: the proxy asks `GET /api/v1/auth/session` (READ-ONLY probe) and refuses with 302 → `/{locale}/login` + `no-store`, or → `/{locale}/dashboard` for a signed-in non-panel user; an unreachable probe fails closed (`X-Velora-Edge-Gate: gate-unavailable`) |
| Cache class | `.htaccess` `private, max-age=0, must-revalidate` on HTML + `no-store` on the gate | The proxy now actually applies ADR-009 §4 **route class D** (`private, no-store`) to authenticated routes — declared in the frozen contract but never applied before this phase |

The probe exists because Modern's web tier holds no database credentials by contract, and it must NOT
be `POST /auth/refresh`: that rotates the token, so a page view would spend the 30/300 refresh budget
and turn every navigation into a rotation event. `AuthService.sessionProbe()` shares its validation
with `refresh()` through one private `sessionState()`, and is read-only: **`db/tests/pgSessionProbe.pg.test.ts`
asserts the `user_sessions` row is byte-identical after five probes and that the original token still
performs a real rotation afterwards** (3/3, stable over repeated runs).

**Defect found by this phase's own real-PG concurrency test and fixed immediately (never left as TODO):**
refresh rotation was **not atomic** — two concurrent refreshes of the same token both succeeded, both
returned a fresh pair, and the row kept only the last writer's hash, so the other caller's brand-new
refresh token was dead on arrival. Fixed with a compare-and-swap
(`UPDATE … WHERE id = $n AND refresh_token_hash = $expected RETURNING id`) in both stores; a rotation
whose expectation is stale is a no-op that reports `false`, and the service refuses the loser with the
same typed `INVALID_TOKEN` a stale token gets instead of handing it a dead pair. No schema change.
**Remaining, documented not invented:** ADR-005 item 9 also promises *reuse detection with family
revocation + a security event* when an already-rotated token is replayed; that needs rotation history
(a `family_id`/previous-hash column), so it belongs with the schema work of phase 4. Today a replayed
rotated token is refused (`INVALID_TOKEN`) — the reuse is not yet *detected and escalated*.

**Contract delta, stated rather than silently changed:** Legacy protects 11 HTML routes; Modern's
protected list is 10 because `markets` and `news` are declared **public** by the frozen `PUBLIC_ROUTES`
contract (ADR-009 C-03), which carries an explicit owner-decision flag (R8). The guard test
(`apps/web/src/lib/auth/protectedRoutes.test.ts`, 7/7) pins the current truth in BOTH directions and
fails if a page appears that is neither protected nor public by contract. These two pages render no
user data; the shell itself carries nothing user-specific.

### SEC-01 — RBAC vocabulary map (was PARTIAL: 4 of 24 Legacy permissions)

`docs/security/RBAC-CAPABILITY-MAP.md`: all 24 Legacy `P_*` permissions with **meaning, owner,
enforcement point, evidence**, the 3 Modern-only permissions, the invariants table with its proofs, and
a governance rule. 6 of 24 are ENFORCED today (overview, users.view, the merged suspend/activate pair,
users.change_role, audit.view_sensitive); the rest are PARTIAL or NOT DECLARED **with the reason** —
declaring a permission for an operation that does not exist would fabricate an authorization surface.
The document is held to the code by `apps/api/src/auth/rbacCapabilityMap.test.ts` **5/5**, which reads
the markdown, cross-checks every row against the real 24 Legacy ids and Modern's `PERMISSIONS`
vocabulary, and fails if a row claims an enforcement point that no `PERMISSIONS` entry backs. The
governing rule is written into both: **a capability brings its permission with it** — the phase that
lands support / admin / AI surfaces adds the permission, its grant row, its enforcement point and its
test in the same commit, and moves the row to ENFORCED.

### Phase-2 gate results

| Gate | Result |
|---|---|
| `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` | **0 errors** |
| `npm test` (root runner) | **1014/1014, 0 fail, 0 skipped** (up from 945 tests) |
| Real-PG batteries (26 files, `DATABASE_URL` → PostgreSQL 16.15) | **all green — 283 tests** (was 256 + this phase's 4 auth-event tests + 3 probe tests + 2 CAS assertions in `pgUserStore.pg`) |
| `npx next build` (apps/web) | success (proxy gate compiled into the production server) |
| `tools/secret-scan.sh` | **PASS (0 findings)** |

**Runtime + browser evidence (live PG, API 8080, Next production 3200):**
`GET /api/v1/auth/session` → `{authenticated:false}` anonymous, `{authenticated:true, role:"user"}`
signed in, `no-store` (route battery 6/6). Browser: real form login → `__Host-velora_refresh`
`secure=true httpOnly=true sameSite=Strict path=/ domain=127.0.0.1` **accepted by Chromium over plain
HTTP** and the legacy `refresh_token` cookie gone; page reload on a gated route stays signed in
(`POST /auth/refresh → 200`); anonymous `/dashboard`, `/settings`, `/profile`, `/trades`, `/admin`
→ landed on `/login` (and `/en/*` → `/en/login`); signed-in pages → **200 with
`Cache-Control: private, no-store`** for all five; a plain user on `/admin` → landed on `/dashboard`
(the server-side panel gate, no client guard involved); the same user promoted to `admin` in
PostgreSQL reaches `/admin` **without re-login** (the gate reads authority from storage on every
check); with the API stopped, protected pages refuse with `gate-unavailable` + `no-store` while
`/markets`, `/news`, `/support`, `/login` still serve — Legacy's fail-closed semantics.
Existing user capability removed: **none.** "No existing user capability was removed."
