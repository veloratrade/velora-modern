# VELORA-MODERN — Capability Registry / Parity Matrix (Phase 0)

Statuses: `PROPOSED` (default), `PORT` / `SKIP` / `DEFER` (decision class, owner-approved),
`SYNCED` (only with test evidence + human sign-off — **never agent-marked**).
Source evidence: PHP repo inspection sessions 2026-08-29 (VERIFIED tags in prior review).
Migration class: `PORT` = reimplement; `SKIP` = not carried (hosting-era); `DEFER` = later decision.

| ID | Capability | Current implementation (VERIFIED) | Business purpose | Modern destination | Class | Decision (proposed) | Dependencies | Ext. contract | Data dep | Security sens. | Verification method |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CAP-AUTH-01 | Registration + email verification | AuthController register/verifyEmail/resend; fragment token links | user onboarding | api Auth module | PORT | PORT | C-06, C-09, mail | C-06 | users, email_verifications | High | journey parity (11-step port) |
| CAP-AUTH-02 | Login / JWT / refresh / sessions | dual-token JWT, HS256, hashed refresh (30d), DB sessions | access control | api Auth | PORT | PORT | C-10 | — | users, user_sessions | High | parity + rotation/reuse tests |
| CAP-AUTH-03 | Forgot/reset password | PasswordService, single-use tokens | account recovery | api Auth | PORT | PORT | C-07 | C-07 | password_resets | High | journey parity |
| CAP-AUTH-04 | Change password + device notify | PasswordService + user_devices + email | security UX | api Auth + notifications | PORT | PORT | mail | — | user_devices | Medium | journey + email contract |
| CAP-AUTH-05 | Logout origin guard | 403 on foreign Origin (live-proven) | CSRF-class defense | api middleware | PORT | PORT | — | — | — | High | origin-probe parity |
| CAP-ACCT-01 | Trading accounts CRUD + detect-server | AccountController/Repository | connect broker accounts | api Accounts | PORT | PORT | — | — | trading_accounts | Medium | API tests |
| CAP-ACCT-02 | MetaApi connect + fenced sync | MetaApiService + lease worker | automated trade import | api+worker MetaApi module | PORT | PORT | MetaApi provider | — | sync_jobs, trading_accounts | High (credentials) | sync convergence + failure injection |
| CAP-ACCT-03 | MetaApi webhook ingestion | HMAC controller | real-time updates | api Webhooks (ADR-008) | PORT | PORT | C-08 | C-08 | webhook_events | High | signature/replay vectors |
| CAP-TRADE-01 | Trades CRUD + exits + PnL | Trade*/PnlCalculator (bcmath) | core journaling | domain Trades (ADR-001/002) | PORT | PORT | — | — | trades + 5 related tables | High (financial) | golden vectors + concurrency |
| CAP-TRADE-02 | Screenshot upload + AI extraction | ScreenshotExtract + AI Extraction | fast trade entry | api+worker AI, StoragePort | PORT | PORT | C-images, AI providers | — | trade_screenshots, ai_extractions | High (uploads) | mocked-provider fail-closed tests |
| CAP-AI-01 | Provider/transport abstraction | GeminiProvider × transports + Tesseract | resilient AI access | packages/domain AI | PORT | PORT | Gemini, n8n relay | — | — | High (keys) | routing + fallback tests |
| CAP-AI-02 | AI job queue | ai_job_worker (DB lease) | async processing | worker on pg-boss | PORT | PORT | ADR-007 | — | ai_jobs | Medium | job semantics tests |
| CAP-AI-03 | Consent/quota/audit/retention/flags | AI repos + retention worker | privacy + cost control | api+worker AI governance | PORT | PORT | — | — | 5 AI tables | High (privacy) | policy + retention tests |
| CAP-AI-04 | Trade analysis + weekly reports | Analysis/Reports services | insights | api+worker Reports | PORT | DEFER (P2) | AI providers | — | ai_analysis, ai_reports | Medium | output contract tests |
| CAP-AI-05 | AI feedback loop | Feedback service | quality signal | api AI | PORT | DEFER (P2) | — | — | ai_feedback | Low | API tests |
| CAP-DASH-01 | Dashboard summary/curves/strategies | DashboardController + MetricsService | user analytics | api Dashboard (pre-agg) | PORT | PORT | — | — | user_analytics_daily, trades | Medium | parity + load tests |
| CAP-DASH-02 | Achievements + notifications | repos + emails | engagement | api Notifications | PORT | PORT | mail | — | user_achievements, notifications | Low | event tests |
| CAP-MAIL-01 | Transactional email suite | Mailer/EmailTemplate (Resend, CID) | lifecycle comms | api Notifications + templates-as-code | PORT | PORT | C-09 | C-09 | email_notifications, email_preferences | Medium | template contract tests (ported) |
| CAP-I18N-01 | Bilingual catalogs + routing + validators | locale-router, catalogs, validators | fa/en product | web i18n pipeline + CI validators | PORT | PORT | C-02, C-03 | C-02 | — | Medium | validator parity (blocking CI) |
| CAP-I18N-02 | Dynamic content translation | worker + lookup endpoint | content localization | worker Translations | PORT | DEFER (P2) | AI? (VERIFY) | C-11 (verify) | language tables | Medium | classification first |
| CAP-CMS-01 | Blog/news/markets content + n8n pipeline | content files + archive agent | growth/SEO | web content + Phase 3 n8n adapter | PORT | PORT | C-03, C-12 | C-03, C-12 | content files | Medium | gate + render tests |
| CAP-PLAT-01 | Health + envelope | /health inline | operability | api Health | PORT | PORT | C-01 | C-01 | — (DB check) | Low | exact parity |
| CAP-PLAT-02 | Rate limiting | Core/RateLimiter (DB buckets) | abuse control | shared-store limiter | PORT | PORT | C-14 | C-14 | rate_limits (not migrated) | High | limit parity tests |
| CAP-PLAT-03 | Admin users list | AdminController (JWT+admin) | support | api Admin (RBAC seam) | PORT | PORT | — | — | users | High | RBAC matrix tests |
| CAP-PLAT-04 | FTP/allow-list deploy pipeline | 25 GH Actions, guards, backups | delivery under FTP constraints | **replaced** by image pipeline (ADR-010) | SKIP | SKIP | hosting constraints | — | — | Medium | n/a — redesign covered by ADR-010 |
| CAP-PLAT-05 | cPanel workers/preflight runtime | preflight_*, prepare_private_runtime | shared-host survival | SKIP — no cPanel in modern | SKIP | SKIP | — | — | — | Low | n/a |
| CAP-SEO-01 | SEO surfaces | sitemap/robots/GSC/headers | organic growth | web SEO subsystem (ADR-009) | PORT | PORT | C-03..C-05, C-13 | C-03..C-05, C-13 | — | Low | parity + drift CI |

## Registry rules

1. Every merged PHP PR that adds/changes behavior must result in a registry row
   update (PORT/SKIP/DEFER decision) — the weekly parity increment audits this.
2. `SYNCED` requires: contract tests + behavioral parity + security/data checks
   green, evidence linked, owner sign-off recorded here.
3. Nothing in this registry is `SYNCED` today (no modern implementation exists).
4. The registry is re-verified against Reference `main` at every phase boundary
   and whenever the Reference advances materially; the drift log below records
   the Reference HEAD audited (`a8eabac`, 2026-09-12).

## Open items (verification debt)

- hreflang/canonical current state (CAP-SEO-01) — NEEDS VERIFICATION.
- `trades` live index/uniqueness set (CAP-TRADE-01) — NEEDS VERIFICATION on staging DB.
- `trade_events` population behavior (CAP-TRADE-01) — NEEDS VERIFICATION.
- Content-translation engine (AI vs other) (CAP-I18N-02) — NEEDS VERIFICATION.
- `tools/tests/*` inventory for porting scope — NEEDS VERIFICATION (sparse scope excluded them).
- **Canonical Modern staging origin (ADR-013 OD-1) — OWNER DECISION REQUIRED**
  (candidate `https://staging.veloratrade.ir`, matching the Reference
  architected origin) before any staging environment exists.

## Reference drift log (re-verification 2026-09-12)

Reference `main` advanced `0aba2e8` (2026-08-29) → `a8eabac` (2026-09-12):
499 files changed (+78,122/−8,387), PRs #91–#139. Impact on this registry:

1. **PR #139 (commit `8aaa2da`) — n8n migration tooling RETIRED in the
   Reference.** Deleted: `tools/n8n_migrate/` (29 files),
   `content/n8n-migrate/`, `content/n8n-integration/`.
   `docs/N8N_INSTANCE_MIGRATION.md` rewritten as a Claude-direct OLD→NEW API
   contract; AGENTS.md §2.3 updated; rebuilding the framework is explicitly
   forbidden by the Reference. **Modern impact:** nothing to port and no row
   exists — correctly none; do not create one. C-12 (article-pipeline approval
   gate) is UNCHANGED — the archive/approval gate is separate from instance
   migration.
2. **Backup gate became permanent Reference law (2026-09-09):** AGENTS.md §14
   + `ops/velora-mgmt/` + `app-schema-migration-staging.yml` (v1.7/v1.8
   allowlist, check/apply modes, `APPLY-APP-SCHEMA-MIGRATION` confirmation
   phrase, canonical order). **Modern impact:** CAP-OPS-01 added; law adopted
   as ADR-012 (D-16) on 2026-09-12.
3. **Admin v2:** new top-level `admin/` (22 files) + Playwright shell suites in
   CI. CAP-PLAT-03 note: the Reference admin evolved well beyond a users
   list; the Modern rebuild plan is unchanged.
4. **AI layer matured:** PR #90 gemini-transport-router —
   `GeminiTransportInterface` (direct vs `n8n_relay` behind one contract) +
   `AiRouteResolver` precedence (admin global route > env > legacy flag >
   direct); AI P2 phase reports A–L; gemini staging probe workflows.
   CAP-AI-01..05 plans unchanged; the transport/route-precedence semantics
   are recorded design input for the Phase 2/3 port.
5. **Scale growth (context only):** `.github/` 28→36 workflows, `tools/`
   145→196, `docs/` 26→55, new `ops/` top level. CAP-PLAT-04 (SKIP)
   re-confirmed correct — the hosting-era mechanism set grew further and
   remains non-portable by design (ADR-010).
