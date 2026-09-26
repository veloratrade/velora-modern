# VELORA — FINAL TWO-REPOSITORY MIGRATION RECONCILIATION AUDIT

**Audit date:** 2026-09-25 (Asia/Tehran)
**Audit mode:** READ-ONLY. No file in either repository, and no file in the sandbox outside `/tmp`, was created, edited, renamed, moved or deleted. No schema/migration/config change was applied. No dependency was installed. No commit, push, branch, PR, deploy or external-service call was made. No credential was used for anything but read-only clone/inspection, and no credential value appears in this report.
**Scope:** Complete closure reconciliation — capabilities, behavior, contracts, data, config, security, docs, integrations, infrastructure, scripts and tests. **Both directions were audited** (Legacy→Modern and Modern→Legacy).

**Authoritative references**

| Ref | Identity | Role in this audit |
|---|---|---|
| `ROADMAP` | `veloratrade/velora-modern` :: `MASTER_ROADMAP.md` (root) | Product/architecture target |
| `PDF` | `veloratrade/veloratrade` :: `docs/pdf/Roadmap.pdf` @ `edede31` — `Velora_Master_Roadmap_v0.1_v3.0`, 17 pages | Product capability reference (PDF's MySQL/cPanel target = LEGACY REFERENCE ONLY per ROADMAP §1) |
| `LEGACY` | `veloratrade/veloratrade` (PHP) — `main` @ `edede313280f2f0e298f5ccbf5bbdd4d676c80bd`, 516 commits, 1090 tracked files | Behavioral/visual reference for production functionality |
| `MODERN` | `veloratrade/velora-modern` (TypeScript) — `main` @ `ffcb0e976147c753493532188a598ecb5de8d06d`, 189 commits, 515 tracked files | Migration destination |

**Comparison rule applied throughout:** capabilities, behavior, contracts, data, config, security, documentation and operational requirements were compared. Filename similarity was never treated as evidence of migration, and no capability was classified obsolete without source evidence.

**Status vocabulary (exactly as mandated):** `COMPLETE` · `PARTIAL` · `MISSING` · `REPLACED` · `SUPERSEDED` · `NOT VERIFIED` · `OWNER DECISION REQUIRED` · `LEGACY-ONLY` · `MODERN-ONLY`

**Verification tags (exactly as mandated):** `STATIC` = proved by reading source/schema/config in this audit. `RUNTIME` = proved by an executed command/process whose result is recorded. `NOT VERIFIED` = no evidence available in a read-only audit (credentials, external services, or a production environment are required).

---

## 1. Scope, Method and Verification Rules

### 1.1 What was read

| Area | Evidence base |
|---|---|
| Repo identity / history | `git log` on both clones; the frontend branch's merge into `main` verified (`ffcb0e9`, PR #7, 2026-09-24 22:52 +0330) |
| Route contracts | `LEGACY/api/index.php` — **122 router registrations resolving to 103 unique paths** (118 verb registrations + 4 `$router->add(…)`) vs `MODERN` — 28 exact-path + 14 regex dispatches in `apps/api/src/kernel/server.ts` plus every handler table under `apps/api/src/{analytics,accounts,webhooks,billing,aicoach,developer,ea,portfolio,tags,tenancy,admin,attachments}` → **72 unique paths (46 exact + 26 regex)** |
| Frontend surface | `LEGACY/localized/{fa,en}/**` (32 localized routes) + `admin/v2/index.html` (334,354 bytes) vs `MODERN/apps/web/src/**` (117 `.ts/.tsx`) + `apps/web/src/proxy.ts` + `packages/contracts/src/locale.ts` |
| Data model | `LEGACY/api/database/{schema.sql,database.sql,database_corrected.sql,add_columns.sql}` vs `MODERN/db/migrations/0001..0022` + `db/roles.sql` + `db/schema-snapshots/modern-target-0022.sql` |
| Security | `LEGACY/.htaccess`, `LEGACY/api/.htaccess`, `LEGACY/locale-router.php`, `LEGACY/api/src/Core/{Response,Jwt,RateLimiter,Csrf}.php` vs `MODERN/apps/web/src/proxy.ts`, `MODERN/apps/api/src/kernel/security.ts`, `MODERN/packages/contracts/src/{auth,rbac}.ts` |
| Workers | `LEGACY/api/src/Workers/*` + `LEGACY/tools/cron/*` vs `MODERN/apps/worker/src/**` |
| Integrations | `LEGACY/api/src/{Accounts,AI,Billing,Support}/**` vs `MODERN/apps/api/src/{accounts,credentials,webhooks,billing,aicoach,developer,ea,portfolio}/**` |
| Tests / CI | `MODERN/tools/run-tests.mjs`, `.github/workflows/*` on both sides |
| Docs | `LEGACY/docs/**` (55 docs + 3 PDFs) + `AGENTS.md` on both sides |
| i18n | `LEGACY/public/locales/chunks/{fa,en}/*.json` (19 chunks) vs `MODERN/apps/web/messages/{fa,en}/*.json` (5 chunks) — key-by-key set comparison |

### 1.2 Rules applied

1. Every major conclusion below cites an exact file path, symbol, route, table or migration number.
2. Nothing is classified obsolete without evidence. Where a legacy capability has no modern counterpart it is reported as a gap, not as "obsolete", unless the modern repository itself records a supersession decision (in which case the ADR/decision ID is cited).
3. Vague qualifiers ("probably", "likely", "should be") appear nowhere as a basis for a verdict; where reasoning goes beyond source text it is labelled **INFERENCE**.
4. Where verification would require credentials, an external service, or a running production environment, the item is `NOT VERIFIED`.
5. Roadmap capabilities scheduled for v1.5–v3.0 that exist in neither repository are not counted as migration failures; they are counted as **roadmap-only** and listed separately (§3).

### 1.3 Baseline numbers

| Metric | LEGACY | MODERN |
|---|---|---|
| Tracked files | 1090 | 515 |
| Primary-language files | 282 PHP | 240 `.ts` + 104 `.tsx` |
| Markdown docs | 66 | 68 |
| Python files | 111 | 10 |
| Test files | 174 | 100 |
| CI workflows | 33 | 7 |
| Application LOC | ~34,015 PHP (`api/`) | ~50,562 TS (`apps`+`packages`+`db`+`tools`) |
| API routes | **103 unique** (122 registrations) | **72 unique** (46 exact + 26 regex) |

---

## 2. Executive Summary and Headline Verdict

The migration has delivered a **genuinely stronger foundation** than the legacy system in the areas it has completed: decimal-exact financial math with typed scales and no float path, an append-only trade ledger with version CAS and tombstones, database-level role separation with append-only REVOKEs, AES-256-GCM credential encryption, HMAC-verified webhook ingestion with a durable raw archive, fail-closed capability gates, and a strict nonce CSP. Those are real, evidenced improvements, not cosmetic ones.

But the migration is **not closed**. Measured against the legacy production system:

| Dimension | Result |
|---|---|
| Legacy API routes with a modern counterpart | **27 of 103 (26.2%)** |
| Legacy API routes with no modern counterpart | **76** |
| Legacy i18n catalog keys migrated | **697 of 1,765 (39.5%)** |
| Legacy admin endpoints migrated | **4 of 62 (6.5%)** |
| Legacy RBAC permissions enforced | **6 of 24** |
| Legacy transactional email types migrated | **2 of 10** |
| Closure gate items passed | **0 of 15** |

Five findings dominate:

1. **The MetaAPI sync path assembles trades per-fill instead of per-position.** Legacy `MetaApiDealAssembler::assemble()` volume-weights IN/OUT fills into one closed position (entry price, exit price, volume, open time = earliest IN, close time = latest OUT, contract size from the deal). Modern `importBatch()` creates **one trade row per OUT deal**, sets `entry_price = exit_price = $6` (the same price twice), `volume = $7` (the OUT fill's volume), `contract_size = 1` hardcoded, and a single `occurred_at = occurred_open_at_utc = occurred_close_at_utc`. Partial fills, scaled-in positions and multi-exit positions therefore produce materially wrong journals, and `ON CONFLICT … DO NOTHING` means a previously wrong row is never corrected. `STATIC`.
2. **The admin panel is 93% absent.** Legacy `admin/v2/index.html` is a 334 KB console exposing 38 modules and calling 34 distinct `/api/v1/admin/*` endpoints; `api/index.php` declares 62 admin routes. Modern registers 10 admin routes, of which only 4 correspond to legacy ones. The modern `(app)/admin` route is an honest GAP shell. `STATIC`.
3. **The AI layer is a seam, not a capability.** Legacy ships ~4,301 lines under `api/src/AI/` with a working Gemini provider, dual transport (direct + n8n relay), a Tesseract OCR fallback, quota/privacy/retention/audit tables, admin route control and two cron workers. Modern `apps/api/src/aicoach/` is 655 lines including tests, contains only a provider *boundary* with `UnconfiguredAiProvider` failing closed, and has no live provider, no OCR, no screenshot extraction, no quota enforcement and no admin control. `STATIC`.
4. **The legacy static-page authorization boundary has no modern equivalent.** Legacy protects 11 authenticated HTML routes at the web server (`locale-router.php:193-221` → 302 to login, `Cache-Control: no-store`, admin-role gate on `admin/index.html`, canonical route `admin/v2`). Modern relies on a client-side `AppSessionGate`/`RequireSession` inside the SPA; the `proxy.ts` matcher excludes only `api`, `_next/static`, `_next/image`, `favicon.ico`. Whether an unauthenticated request for `/dashboard` returns login HTML rather than the SPA shell is `NOT VERIFIED`. `STATIC` (boundary absent at the edge) + `NOT VERIFIED` (actual behaviour).
5. **The modern worker is not deployed anywhere.** `apps/worker/src/index.ts`'s own header states that `railway.json` declares a single API service and that Railway config-as-code has no `services` key. Every scheduled background job — including the analytics pre-aggregation the roadmap mandates and the MetaAPI sync safety net — is therefore `NOT VERIFIED` at runtime. `STATIC`.

Additionally, a set of **documented behavioural regressions** exists in high-traffic surfaces: the refresh cookie loses the `__Host-` prefix and drops `SameSite=Strict`; `GET /trades` changes the `symbol` filter from exact match to case-insensitive `LIKE` and moves `from` from `close_time` to `occurred_open_at_utc`; `PUT /trades/{id}` returns `403 FORBIDDEN` for any financial field where legacy allowed a full update; `r_multiple` is rounded to scale 8 instead of legacy's scale 4; and two admin routes change method from `POST` to `PATCH`.

**MIGRATION CLOSURE STATUS: NOT CLOSED — PARTIAL MIGRATION WITH MATERIAL BEHAVIOURAL DIVERGENCE AND BLOCKING OPERATIONAL GAPS.** See §19 for the 15-item closure gate and the full verdict reasoning.

---

## 3. Architecture and Technology Stack Parity

| Dimension | LEGACY | MODERN | Status | Verification |
|---|---|---|---|---|
| Application server | PHP 8.3 REST API (`api/index.php` front controller) | Node 22 + `tsx`, `apps/api/src/server-main.ts` | `REPLACED` | `STATIC` |
| Database | MySQL 8.0 (`api/database/*.sql`, InnoDB) | PostgreSQL 16, direct `pg`, no ORM | `REPLACED` (ROADMAP §1: PG authoritative, MySQL = LEGACY REFERENCE ONLY) | `STATIC` |
| Hosting | Linux cPanel + FTP deploy (33 workflows) | Railway config-as-code (`railway.json`) + Docker | `REPLACED` | `STATIC` |
| Frontend | Dual-rendered static localized HTML + vanilla JS islands; 193 CSS files / ~15k lines | Next.js 16.3.6 App Router, React 19.2, 117 TS/TSX files | `REPLACED` | `STATIC` |
| Money math | bcmath, scale 8 internally, `bcadd`/`bcsub` | `packages/domain/src/decimal.ts`, exact at scale 24, ADR-001 | `COMPLETE` (modern stricter: typed scales, branded decimal strings, no float path) | `STATIC` |
| Domain purity | Business rules in controllers/services | `packages/domain` framework-free, `apps/*` thin (AGENTS.md rules 3–4) | `COMPLETE` | `STATIC` |
| Localization runtime | `public/locales/chunks/*` + `velora-locale-*.js` bootstrap | `localeKernel.ts` + `messages/{fa,en}` + `createTranslator` | `REPLACED` | `STATIC` |
| Target versions from PDF | v0.1→v3.0, 88 weeks, MySQL+cPanel | Superseded per ROADMAP §1 | `SUPERSEDED` (explicitly) | `STATIC` |

**Roadmap-only targets (present in neither repository; NOT migration failures):** native MT4/MT5 Expert Advisors as shipped binaries, React Native iOS/Android apps with FCM, multi-tenant white-label, public verification seals, copy trading as a live product, voice AI co-pilot WebSocket, ML win-probability inference, developer Open API marketplace with OAuth2. Modern has **schema + provider-gated stubs** for most of these (§8.1); legacy has none. These are `MODERN-ONLY` relative to legacy and `roadmap-only` relative to the closure question.

---

## 4. API Contract Parity — Legacy → Modern

### 4.1 Coverage summary

| Bucket | Count | Status |
|---|---|---|
| Legacy routes with a modern counterpart | **27** | `PARTIAL` overall — several carry semantic divergence (§4.3) |
| Legacy routes with **no** modern counterpart | **76** | `MISSING` |
| Legacy routes deliberately not ported, with a recorded decision | 1 (`GET /webhooks/metaapi/test`) | `SUPERSEDED` (documented) |
| **Total legacy routes** | **103 unique** (122 registrations) | — |
| Modern-only routes | 45 | `MODERN-ONLY` (§5) |

Missing routes by area: **admin 59** (users 12, communications 7, integrations 6, analytics 6, ai 6, system 3, settings 2, security 2, providers 2, logs 2, feature-flags 2, billing 2, plus `overview`, `me`, `permissions`, `config/effective`, `ai-usage`, `trades`, `trading-accounts`) · **support 5** · **dashboard 3** · **ai 3** · **accounts 2** · **trades 1** · **webhooks 1** · **content-translations 1** · **auth 1**.

### 4.2 The 76 legacy routes with no modern counterpart (`MISSING`)

**Accounts (2)**
- `POST /api/v1/accounts/connect-metaapi` — `AccountController::connectMetaApi` (single-step MetaAPI connect)
- `POST /api/v1/accounts/{id}/sync` — `AccountController::sync` → `MetaApiService::runNextSyncJob`; manual sync trigger returning `202 {jobId, status:"queued", deduplicated}`

**Admin (59)**
- AI: `/admin/ai-usage`, `/admin/ai/overview`, `/admin/ai/route` (GET+PUT), `/admin/ai/credentials/{provider}`, `/admin/ai/feature-providers` (GET+POST), `/admin/ai/feature-providers/reorder`, `/admin/ai/feature-providers/{id}` (PATCH)
- Analytics: `/admin/analytics/overview`, `/admin/analytics/users`, `/admin/analytics/trading`, `/admin/analytics/revenue`, `/admin/analytics/ai`, `/admin/analytics/operations`
- Billing: `/admin/billing`, `POST /admin/billing/users/{id}`
- Communications (support console): `/admin/communications/tickets`, `/admin/communications/tickets/{id}`, `…/{id}/messages`, `…/{id}/status`, `…/{id}/copilot`, `…/{id}/copilot/draft`, `…/{id}/translate`
- Config: `/admin/config/effective`
- Feature flags: `/admin/feature-flags`, `PATCH /admin/feature-flags/{feature}`
- Integrations: `/admin/integrations`, `/admin/integrations/email` (GET+PUT), `POST /admin/integrations/email/test`, `/admin/integrations/metaapi` (GET+PUT), `POST /admin/integrations/metaapi/test`, `/admin/integrations/relay/config` (GET+PUT)
- Logs: `/admin/logs/audit`, `/admin/logs/system`
- Identity/overview: `/admin/me`, `/admin/overview`, `/admin/permissions`
- Providers: `/admin/providers/{provider}/verify`, `/admin/providers/{provider}/test-connection`
- Security: `/admin/security/logins`, `/admin/security/signups`
- Settings: `/admin/settings`, `/admin/settings/{key}` (GET+PUT)
- System: `/admin/system/health`, `/admin/system/diagnostics`, `POST /admin/system/diagnostics/refresh`
- Global reads: `/admin/trades`, `/admin/trading-accounts`
- User management: `/admin/users/invitations` (GET+POST), `POST /admin/users/{id}/subscription`, `POST /admin/users/{id}/verify-email`, `GET /admin/users/{id}/accounts`, `GET /admin/users/{id}/trades`, `GET /admin/users/{id}/activity`, `GET /admin/users/{id}/audit`, `GET /admin/users/{id}/devices`, `GET /admin/users/{id}/login-history`, `GET /admin/users/{id}/sessions`, `POST /admin/users/{id}/revoke-sessions`, `POST /admin/users/{id}/sessions/{sessionId}/revoke` — plus **`POST /admin/users`** (admin create-user), which shares the path `/api/v1/admin/users` that Modern serves for `GET` only, so it is a missing *method* rather than a missing path

**AI (3)**: `POST /api/v1/ai/analyze-trades` · `POST /api/v1/ai/weekly-report` · `POST /api/v1/ai/feedback`
**Trades (1)**: `POST /api/v1/trades/extract-screenshot` — `ScreenshotExtractController`, base64 image → Gemini/OCR → draft trade
**Support (5)**: `POST|GET /api/v1/support/tickets`, `GET /api/v1/support/tickets/{id}`, `POST /api/v1/support/tickets/{id}/messages`, `POST …/{id}/read`, `POST …/{id}/reopen`
**Dashboard (3)**: `GET /api/v1/dashboard/summary`, `GET /api/v1/dashboard/equity-curve`, `GET /api/v1/dashboard/strategies`
**Content translation (1)**: `POST /api/v1/content-translations/lookup` — `ContentTranslationController`
**Auth (1)**: `POST /api/v1/auth/resend-verification-email` — legacy compat path (the canonical `resend-verification` **is** migrated)
**Webhooks (1)**: `GET /api/v1/webhooks/metaapi/test` — deliberately not ported, recorded in `apps/api/src/webhooks/webhookRoutes.ts:13`

*(Method: each of the 103 legacy paths was compared against the 62 modern paths derived from `kernel/server.ts` exact/regex dispatches plus every `*Routes.ts` handler table. Independently, every literal above was searched across `MODERN/apps`, `MODERN/packages`, `MODERN/db` under `*.ts` excluding `*.test.ts`; all returned zero matches.)*

### 4.3 The 27 shared routes — method and semantic divergences

| Route | Legacy | Modern | Divergence | Status |
|---|---|---|---|---|
| `GET /api/v1/trades` — `symbol` | **Exact**: `t.symbol = :symbol` (`TradeRepository.php:58`) | **Case-insensitive contains**: `UPPER(symbol) LIKE '%' \|\| $n \|\| '%' ESCAPE '\'` (`pgTradeStore.ts:267`) | Filter semantics changed | `PARTIAL` |
| `GET /api/v1/trades` — `from` | `t.close_time >= :from` (`TradeRepository.php:66`) | `occurred_open_at_utc >= $n` (`pgTradeStore.ts:272`) | Filter boundary moved from close to open | `PARTIAL` |
| `GET /api/v1/trades` — `q` | `symbol LIKE OR strategy_tag LIKE OR notes LIKE` (`TradeRepository.php:74`) | `symbol OR strategy OR notes` contains (`pgTradeStore.ts:283-287`) | Searches `strategy`, not `strategy_tag` | `PARTIAL` |
| `GET /api/v1/trades` — pagination | default 20, clamp 200 (`TradeController.php`) | default 20, clamp 200 (`tradeService.ts:376-377`) | — | `COMPLETE` |
| `GET /api/v1/trades` — sort | whitelist `open_time\|profit_loss\|close_time`, default `close_time` (`TradeRepository.php:79-83`) | same whitelist, default `open_time` (`tradeService.ts:390-401`) | **Default sort differs** | `PARTIAL` |
| `PUT /api/v1/trades/{id}` | Full update incl. financial fields | **403 `FORBIDDEN`** on any financial field (`tradeService.ts:415-429`) | Client-visible contract change (ADR-002) | `PARTIAL` |
| `DELETE /api/v1/trades/{id}` | Physical delete | ADR-002 **tombstone** (`deleted_at`) | Behaviour change | `REPLACED` |
| `POST /api/v1/trades/{id}/exits` | `trade_exits` rows | Same + version CAS + allocation guard | Modern stronger | `COMPLETE` |
| `GET /api/v1/trades/symbols` | `TradeController` | `server.ts:845` | — | `COMPLETE` |
| `GET|DELETE /api/v1/accounts/{id}` | **DELETE only** (`index.php:93`) — legacy has no `GET /accounts/{id}` | `GET`, `PATCH`, `DELETE` | Two extra methods (improvement) | `MODERN-ONLY` (methods) |
| `GET|POST /api/v1/accounts` | `index.php:86-87` | `server.ts:630,637` | — | `COMPLETE` |
| `POST /api/v1/accounts/detect-server` | `AccountController::detectServer` | `server.ts:645` | — | `COMPLETE` |
| `PATCH /api/v1/accounts/{id}/timezone` | `index.php:92` | `server.ts` regex | — | `COMPLETE` |
| `GET /api/v1/accounts/{id}/sync-status` | `AccountController::syncStatus` | `accounts/syncStatusRoutes.ts` — bounded vocabulary, non-disclosing 404 | Modern stricter | `COMPLETE` |
| `POST /api/v1/admin/users/{id}/status` | **POST** (`index.php:221`) | **PATCH** (`server.ts:1027`) | **Method changed** | `PARTIAL` |
| `POST /api/v1/admin/users/{id}/role` | **POST** (`index.php:223`) | **PATCH** (`server.ts:1019`) | **Method changed** | `PARTIAL` |
| `GET /api/v1/admin/users`, `GET /admin/users/{id}` | `index.php:109,220` | `server.ts:993,1007` | Modern adds `search`/`role`/`status`/paging | `COMPLETE` |
| `GET|PUT /api/v1/auth/email-preferences` | `index.php:69-70` | `server.ts:578,588` | — | `COMPLETE` |
| `PATCH /api/v1/auth/me/preferences` | `index.php:73` | `server.ts:543` | — | `COMPLETE` |
| `POST /api/v1/auth/{login,register,refresh,verify-email,resend-verification,forgot-password,reset-password,change-password,logout}`, `GET /api/v1/auth/me` | `AuthService` / `AuthController` | `authService.ts` + `server.ts` | — | `COMPLETE` |
| `POST /api/v1/webhooks/metaapi` | `MetaApiService::processWebhook` assembles trades **from the payload** inside the request | `metaApiWebhookService.ts` records the event durably, marks the account pending, dispatches a sync job; trade assembly happens only in the worker's history-deals pass | Architectural change; convergence depends on pg-boss, degrading to `DurableOnlySyncTrigger` (up to 1 h) | `REPLACED` (documented) |
| `POST /api/v1/accounts` + connect | **Single call** `POST /accounts/connect-metaapi` | **Three calls** `POST /accounts` → `POST /credentials` → `POST /accounts/{id}/metaapi/connect` with compensation rollback; plaintext never reaches the client | Flow changed, security improved | `REPLACED` (ROADMAP ACCT-02) |

---

## 5. API Contract Parity — Modern → Legacy

Modern-only API surfaces. **Modern-only functionality is not automatically a problem**; each is classified against the roadmap.

| Modern route | Legacy counterpart | Status |
|---|---|---|
| `POST /api/v1/credentials`, `GET|DELETE /api/v1/credentials/{id}` | none | `MODERN-ONLY` — required by the 3-step MetaAPI flow (roadmap v0.2); AES-256-GCM envelope (`0010`) |
| `POST /api/v1/accounts/{id}/metaapi/connect`, `…/disconnect` | folded into `connect-metaapi` | `MODERN-ONLY` |
| `GET /api/v1/analytics/{summary,equity-curve,heatmap,by-symbol}` | `/dashboard/*` (different shape) | `MODERN-ONLY` — roadmap v0.5 |
| `GET /api/v1/portfolio/{summary,by-symbol,fx-rates,prop-status}`, `GET|POST /api/v1/account-groups` | none | `MODERN-ONLY` — roadmap v1.5, provider-gated |
| `POST /api/v1/ea/handshake`, `POST /api/v1/ea/trade-event` | none | `MODERN-ONLY` — roadmap v2.0 |
| `POST /api/v1/devices/register-push` | none | `MODERN-ONLY` — roadmap v2.0 |
| `POST /api/v1/subscriptions/checkout`, `GET /api/v1/subscriptions/me`, `POST /api/v1/webhooks/stripe` | **none — legacy has zero Stripe code** (case-insensitive grep for `stripe` across `legacy/api/` under `*.php`/`*.sql` → 0 files) | `MODERN-ONLY` — roadmap v1.0 |
| `POST /api/v1/developer/keys`, `POST /api/v1/developer/predictions` | none | `MODERN-ONLY` — roadmap v3.0 |
| `GET|POST /api/v1/copy-trading/relationships` | none | `MODERN-ONLY` — roadmap v2.5 |
| `GET|POST /api/v1/tags`, `DELETE /api/v1/tags/{id}`, `GET|POST /api/v1/trades/{id}/tags`, `DELETE /api/v1/trades/{id}/tags/{tagId}` | Legacy declares `tags`, `trade_tags`, `trade_screenshots` in DDL but **no PHP code reads or writes them** (`grep trade_screenshots legacy/api --include=*.php` → 0 matches) | `MODERN-ONLY` — roadmap v0.5 |
| `GET|POST /api/v1/trades/{id}/attachments`, `GET /api/v1/attachments/{id}/content`, `DELETE /api/v1/attachments/{id}` | Legacy `trade_screenshots` (declared, unused) | `MODERN-ONLY` — roadmap v0.5; object-store byte sink is an open item (§12.4) |
| `GET /api/v1/accounts/{id}/ea-key` | none | `MODERN-ONLY` — roadmap v2.0 EA authentication |
| `DELETE /api/v1/copy-trading/relationships/{id}`, `DELETE /api/v1/developer/keys/{id}`, `DELETE /api/v1/devices/{id}`, `PATCH|DELETE /api/v1/account-groups/{id}`, `PATCH|DELETE /api/v1/prop-rules/{id}` | none | `MODERN-ONLY` — roadmap v1.5–v3.0 lifecycle endpoints |
| `GET /api/v1/public/verify/{hash}` (**PUBLIC, no bearer**) | none | `MODERN-ONLY` — roadmap v3.0 public verification seals |
| `GET /api/v1/public/profiles/{handle}` (**PUBLIC, no bearer**) | none | `MODERN-ONLY` — roadmap v2.5 white-label public profiles |
| `GET /api/v1/admin/ownership/status`, `POST /api/v1/admin/ownership/claim` | none | `MODERN-ONLY` — installation-ownership model, one-time, DB-closed (`server.ts:1043-1063`) |
| `GET /api/v1/admin/rbac/self`, `GET /api/v1/admin/rbac/matrix` | none (legacy `Role::can()` is server-internal) | `MODERN-ONLY` |
| `GET /api/v1/ai-coach/consent`, `GET /api/v1/ai-coach/latest-insights` | `/api/v1/ai/*` (different shape) | `MODERN-ONLY` — roadmap v1.0, provider boundary only |
| `POST /api/v1/debug/create-verified-user` | none | `MODERN-ONLY` — E2E helper, gated `APP_ENV === "development"`; see §10.2 S10 |

**Modern documentation inaccuracy found in this audit:** `apps/api/src/attachments/attachmentService.ts:20` cites "Legacy `api/src/Trades/ScreenshotController.php`" as the rules source. **That file does not exist in the legacy repository at `edede313`** (`find` for `*screenshot*` under `legacy/` returns only `tools/tests/test_screenshot_ui.php`, `api/src/Trades/ScreenshotExtractController.php`, two prompt templates and `api/src/AI/Extraction/ScreenshotExtractor.php`). The real legacy source for the 5 MiB / JPEG-PNG-WebP rule is the roadmap PDF, not a PHP controller. `STATIC`.

---

## 6. Frontend and User-Facing Capability Parity

### 6.1 Route inventory

| | LEGACY | MODERN |
|---|---|---|
| Authenticated app routes | 11 (`accounts/connect`, `admin`, `admin/v2`, `dashboard`, `intelligence`, `markets`, `news`, `performance`, `profile`, `trades`, `trades/new`, `wallet`) | 12 groups × 2 locales (`(app)/{dashboard,accounts,trades,analytics,performance,wallet,profile,intelligence,markets,news,support,admin}` + `/en/…`) |
| Public routes | `login`, `register`, `verify-email`, `forgot-password`, `reset-password`, `checkout`, `blog` (+5 articles), `privacy`, `terms` | `login`, `register`, `verify-email`, `forgot-password`, `reset-password`, `support`, `markets`, `news`, `/` and `/en/` |
| Contract-declared public routes (`packages/contracts/src/locale.ts:18-37`) | — | 20 entries incl. `/blog/`, `/en/blog/`, `/fa/checkout`, `/en/checkout`, `/privacy`, `/terms` |
| **Contract routes with no Next.js page** | — | **`/blog/*`, `/en/blog/*`, `/privacy`, `/terms`, `/fa/checkout`, `/en/checkout`** — `apps/web/src/app` contains no `blog`, `privacy`, `terms` or `checkout` directory. `resolvePublicRoute("/blog/what-is-trading-journal/")` returns class B, so the proxy emits a **public cache header for a URL that 404s**. |

**Status: `PARTIAL`.** The app shell and the auth/accounts/trades surfaces exist; blog (5 articles × 2 locales, 144 catalog keys), privacy, terms and checkout do not.

### 6.2 Per-capability frontend matrix

| Capability | LEGACY | MODERN | Status |
|---|---|---|---|
| Landing page | `localized/{fa,en}/index.html` (1,008,925 bytes each) | `apps/web/src/features/landing/*` + `src/app/page.tsx` + `src/app/en/page.tsx` | `COMPLETE` — `md5sum` of `landing/fa`, `landing/en`, `common/*`, `auth/*` is byte-identical across repos; MASTER_ROADMAP §4 records Playwright pixel-equivalence at 1440/390; `FRONTEND_CLOSURE_REPORT.md` records 110/110 checks and 0 CSP violations |
| Login / register / verify / forgot / reset | `localized/{fa,en}/*/index.html` | `src/app/{login,register,verify-email,forgot-password,reset-password}` + `/en/…` | `COMPLETE` |
| Dashboard | `dashboard/index.html` (82 KB) — KPIs, equity curve, strategies via `/dashboard/*` | `src/features/dashboard/DashboardPage.tsx` — **a W1 auth-verification page**: renders the session user and a checklist ("accessToken in memory", "refresh_token HttpOnly Secure Lax"); calls only `/api/v1/auth/me` | `MISSING` as a product surface (DASH-01 remains BLOCKED in MASTER_ROADMAP §2) |
| Trades list + create | `trades/index.html`, `trades/new/index.html` (62 KB) with live PnL preview + smart-import | `(app)/trades`, `(app)/trades/new` | `PARTIAL` — create/list/delete ship; exits/journaling-PUT UI is PLANNED (`FRONTEND_MIGRATION_FINAL_REPORT.md` §18); screenshot smart-import `MISSING` |
| Accounts + MetaAPI connect | `accounts/connect/index.html`, single-call flow | 3-step flow with compensation | `REPLACED` (stronger) |
| Analytics | Dashboard section only | `(app)/analytics` bound to `/analytics/*`; honest localized unavailable state when the capability is absent | `PARTIAL` — contract complete, content depends on PG + capability |
| Performance / strategy detail | `performance/index.html` + `/dashboard/strategies` | `(app)/performance` GAP shell | `MISSING` |
| Wallet / Stripe checkout | `wallet/index.html` (12 i18n keys) + thin `checkout/index.html` (9,953 bytes) — **no Stripe code anywhere** | `(app)/wallet` GAP shell | `MISSING` (legacy was a shell too; the backend is `MODERN-ONLY`) |
| Intelligence / AI journal chat | `intelligence/index.html` — **hard-coded demo answers, no API calls** (the page's only script is `VeloraData.requireSession`) | `(app)/intelligence` GAP shell | `PARTIAL` — legacy was a static demo; modern is an honest shell; neither is a live AI surface |
| Markets | `markets/index.html` — session-gated server-side | `(app)/markets` — **public** per the frozen contract (`PUBLIC_APP_PATHS`, `AppSessionGate.tsx:24`) | `PARTIAL` + `OWNER DECISION REQUIRED` (R8) |
| News | `news/index.html` — session-gated server-side | `(app)/news` — **public** | `PARTIAL` + `OWNER DECISION REQUIRED` (R8) |
| Support tickets | `support/index.html` + `/support/tickets*` | `(app)/support` shell, no API | `MISSING` (GAP-SUP) |
| Profile | `profile/index.html` + `/auth/me`, `/auth/me/preferences`, `/auth/change-password` | `(app)/profile` | `PARTIAL` — preferences/change-password wired; avatar/full-name edit not evidenced |
| Admin console | `admin/v2/index.html` (334,354 bytes, 38 modules, 34 endpoints) + `admin/index.html` (145 KB shell) | `(app)/admin` GAP shell | `MISSING` |
| Blog | 5 articles × 2 locales, 144 i18n keys, sitemap entries | none | `MISSING` |
| Newsletter | Fake UI (`#nl-form` hidden, "✓ Subscribed!") | Same fake UI in `LandingRuntime.tsx` | `LEGACY-ONLY` reference (GAP-NL) — parity |
| Legacy CSS (193 files / ~15k lines) | — | DROPPED wholesale (Stage-1 classification) | `SUPERSEDED` (documented) |

---

## 7. Localization and RTL/LTR Parity

### 7.1 Catalog coverage

| Chunk | LEGACY fa keys | In MODERN? |
|---|---|---|
| `landing` | 358 | ✅ byte-identical |
| `common` | 72 | ✅ byte-identical |
| `auth` | 115 | ✅ byte-identical |
| `errors` | 91 | ✅ all 91 present, re-nested under `messages.errors.*`, **+3 new keys** (`capabilityUnavailable`, `accounts.quotaExceeded`, `trades.financialImmutable`) |
| `landing-interactive` (new) | — | 58 keys moved out of hard-coded JS |
| `admin` | 457 | ❌ absent |
| `blog` | 144 | ❌ absent |
| `trades` | 127 | ❌ absent |
| `privacy` | 96 | ❌ absent |
| `terms` | 55 | ❌ absent |
| `support` | 38 | ❌ absent |
| `profile` | 37 | ❌ absent |
| `checkout` | 27 | ❌ absent |
| `intelligence` | 30 | ❌ absent |
| `dashboard` | 62 | ❌ absent |
| `markets` | 14 | ❌ absent |
| `news` | 19 | ❌ absent |
| `performance` | 11 | ❌ absent |
| `wallet` | 12 | ❌ absent |
| **Total** | **1,765** | **697 migrated = 39.5%** |

**fa↔en parity:** both repositories are internally perfect — every migrated key exists in both locales (0 missing, 0 extra, in every chunk, in both repos). `STATIC`.

**Status: `PARTIAL`** — the migrated 39.5% is exact; the missing 60.5% maps 1:1 onto the missing pages and the admin console.

### 7.2 Locale mechanics

| Aspect | LEGACY | MODERN | Status |
|---|---|---|---|
| URL contract | `/{locale}/{route}/` with trailing slash; `login`, `register` without | Frozen: `/` = fa, `/en/` = en, `/login` no slash, `/blog/` with slash, `checkout` = `/fa/checkout` + `/en/checkout` | `REPLACED` (ADR-009 / D-14, contract-frozen) |
| Header | `X-VELORA-Locale` | Same constant (`packages/contracts/src/locale.ts:5`) | `COMPLETE` |
| RTL/LTR | `dir="rtl" lang="fa"` server-rendered per route | `RootLayout` reads `x-velora-locale` from the proxy; `html lang/dir` set server-side | `COMPLETE` |
| Latin digits | `velora-latin-digits.js` + `.v-latn-num` CSS | `Intl.NumberFormat … numberingSystem:"latn"`, `LatinText.tsx`, `.v-latn-num` | `COMPLETE` |
| Brand terms | never translated | never translated (i18n validators) | `COMPLETE` |
| Cache policy | `private, no-store` for app routes; `private, max-age=0, must-revalidate` for public localized | `CACHE_POLICY` A/B/C/D (`locale.ts:44-49`) | `COMPLETE` (class D = `private, no-store`) |
| Google Fonts | `style-src https://fonts.googleapis.com`, `font-src https://fonts.gstatic.com` | self-hosted `public/fonts/*.woff2` (6 files), `font-src 'self'` | `REPLACED` — required by the stricter CSP; byte-equality of Estedad/Vazirmatn/Geist claimed in MASTER_ROADMAP §4 |

---

## 8. Data Model and Schema Parity

### 8.1 Table-level coverage

| Legacy concept | Modern | Status |
|---|---|---|
| `users` (37 cols incl. `plan`, `subscription_status`, `plan_started_at`, `plan_expires_at`, `plan_updated_at`, `timezone`, `locale_source`, `locale_updated_at`, `ai_consent_at`, `confirmation_code`, `remember_token`) | `0001 users` + `0002` (full_name, timezone, plan, status, ai_consent_at) + `0006` (role widened to `user\|admin\|super_admin`) | `PARTIAL` — `subscription_status`, `plan_started_at`, `plan_expires_at`, `plan_updated_at`, `locale_source`, `locale_updated_at`, `confirmation_code`, `remember_token` have **no modern column**; the subscription lifecycle moved to `0017 subscriptions` with a **different status vocabulary** (`incomplete, trialing, active, past_due, canceled, unpaid` vs legacy `none, active, past_due, grace, expired, cancelled`) — `grace` and `expired` are lost, `incomplete`/`trialing`/`unpaid` are new |
| `user_sessions` | `0001` + `0002` (`access_token_hash`, `ip_address`, `user_agent`) | `COMPLETE` — same shape, same atomic single-use rotation |
| `user_devices` | `0001` | `COMPLETE` |
| `email_verifications`, `password_resets` | `0001` | `COMPLETE` |
| `trading_accounts` | `0004` | `COMPLETE` |
| `trades` | `0001` + later migrations | `SUPERSET` (§8.2) |
| `trade_exits` | `0001` | `COMPLETE` |
| `trade_events` (append-only ledger) | `0001` + `roles.sql` REVOKEs | `MODERN-ONLY` — strengthening |
| `webhook_events` | `0008` (raw archive + dedupe) | `COMPLETE` |
| `rate_limits` | `0001` + `roles.sql` | `COMPLETE` |
| `email_preferences` | `0003` | `COMPLETE` — exact 6-key parity, all default ON |
| `audit_log` | `0009` + `0011` + `0014` (append-only, CHECK vocabulary) | `COMPLETE` |
| `tags`, `trade_tags` | `0015` | `COMPLETE` (legacy DDL only, unused) |
| `trade_screenshots` | `0015 trade_attachments` (object-store key + sha256, no bytes) | `REPLACED` — byte sink open (§12.4) |
| `sync_jobs` + leases | `0012`/`0013` (partial unique indexes) | `COMPLETE` |
| `user_credentials` (AES-256-GCM) | `0010` | `COMPLETE` — roadmap mandate met |
| `ai_jobs`, `ai_reports`, `ai_quota_daily`, `ai_feature_flags`, `ai_privacy_audit`, `ai_analysis_logs`, `ai_request_logs`, `ai_trade_analysis`, `ai_monthly_usage` | `0017 ai_coaching_logs` **only** | `MISSING` (8 of 9) |
| `support_tickets`, `support_messages` | none | `MISSING` |
| `email_notifications` (outbound delivery log) | none | `MISSING` |
| `auth_events` (login history) | none | `MISSING` |
| `user_achievements` | none | `MISSING` |
| `content_translations` | none | `MISSING` |
| `system_logs`, `integration_health` | none | `MISSING` |
| `subscriptions` (legacy: **no table** — columns on `users`) | `0017` | `REPLACED` (vocabulary differs, §8.1) |
| Roadmap v1.5–v3.0 (`currency_rates`, `account_groups`, `prop_firm_rules`, `ea_api_key_hash`, `device_tokens`, `tenants`, `public_profiles`, `copy_relationships`, `developer_api_keys`, `ml_model_predictions`, `voice_session_logs`, `user_analytics_daily`, `account_performance_summary`, `provisioning_operations`, `signal_queue`) | `0016`–`0022` | `MODERN-ONLY` / roadmap-only — all provider-gated |

### 8.2 `trades` column parity

Legacy has 34 columns; modern has 47. Every legacy column except `profit_loss`, `open_time` and `close_time` exists in modern. `profit_loss` is intentionally folded into `net_pnl` (the `TradeSortKey` `"profit_loss"` maps to `net_pnl` in `pgTradeStore.ts:160`). `open_time`/`close_time` are replaced by the ADR-004 dual-instant model (`occurred_at`, `occurred_open_at_utc`, `occurred_close_at_utc`, `source_time_naive`, `source_tz_offset`, `time_status`). `STATIC`.

### 8.3 Roadmap CTO data mandates

| Mandate (PDF) | Modern | Status |
|---|---|---|
| Composite indexes on `(account_id, open_time)` and `(account_id, symbol)` | `trades_user_idx (user_id, occurred_at DESC)` and `trades_account_idx (account_id)` in `0001`; **no `(account_id, symbol)` index** | `PARTIAL` |
| DECIMAL + `bcadd`/`bcsub`, zero float currency math | `NUMERIC(20,8)`/`NUMERIC(20,2)` per ADR-001 + `packages/domain/src/decimal.ts` | `COMPLETE` |
| `declare(strict_types=1)` equivalent | TypeScript strict mode | `COMPLETE` |
| No direct DB writes in controllers | `packages/domain` I/O-free; `apps/*` thin (AGENTS.md 3–4) | `COMPLETE` |
| Async worker + pre-aggregated `user_analytics_daily` / `account_performance_summary` | Tables exist (`0016`); the writer exists (`ea389f4 feat(analytics): the async pre-aggregation writer that 0016 never had`) — **but the worker is not deployed** (§13.2) | `PARTIAL` / `NOT VERIFIED` at runtime |

---

## 9. Domain Logic and Calculation Parity

### 9.1 PnL

| Aspect | LEGACY `api/src/Trades/PnlCalculator.php` | MODERN `packages/domain/src/pnl.ts` | Status |
|---|---|---|---|
| Gross (buy) | `(exit − entry) × volume × contractSize` at scale 8 | identical, exact at scale 24 then rescaled | `COMPLETE` |
| Gross (sell) | `(entry − exit) × …` | identical | `COMPLETE` |
| Net | `gross − commission − swap` | identical | `COMPLETE` |
| Risk | `\|entry − SL\| × volume × contractSize`; null when SL absent / zero / wrong-side | identical, with an explicit `"undefined-risk"` result kind and reasons `no-stop-loss` / `stop-loss-wrong-side` / `risk-is-zero` | `COMPLETE` (modern makes the branch explicit instead of returning null) |
| Range guard | `assertFits` → `ValidationException OUT_OF_RANGE` (`profitLoss` 16,8 / `rMultiple` 10,8) | No equivalent runtime guard evidenced | `PARTIAL` |
| **`r_multiple` rounding scale** | `bcadd($rMultiple, '0', 4)` → **scale 4** | `SCALES.rMultiple = 8` → **scale 8** | `PARTIAL` — **numeric output divergence**: identical inputs produce different stored strings (`1.5000` vs `1.50000000`) |
| Volume = 0 | gross 0, net = −commission−swap | identical (documented in the modern comment) | `COMPLETE` |

### 9.2 MetaAPI sync — **the largest behavioural divergence in the audit**

| Aspect | LEGACY | MODERN | Status |
|---|---|---|---|
| Model | Durable **fill ledger** → `MetaApiDealAssembler::assemble()` → **one closed-position trade per positionId** | `importBatch()` → **one trade row per OUT deal** | `MISSING` (position assembly) |
| Entry price | Volume-weighted average across IN fills | `entry_price = exit_price = $6` — the OUT deal's price used for **both** columns (`syncRepository.ts:181-186`) | `MISSING` |
| Exit price | Volume-weighted average across OUT fills | same `$6` as entry | `MISSING` |
| Volume | **Total IN volume** (position size opened) | OUT fill volume `$7` | `MISSING` |
| `contract_size` | From the deal | **Hardcoded `1`** (`syncRepository.ts:184`) | `MISSING` |
| Open / close time | `occurred_open_at_utc` = **earliest IN**; `occurred_close_at_utc` = **latest OUT**, derived independently; a position with no resolvable open *or* close is **skipped, never fabricated** | Single `occurred_at = occurred_open_at_utc = occurred_close_at_utc` = the OUT deal's instant (`$11,$11,$11`) | `MISSING` |
| Financials | Sum across the position's fills | Provider profit carried verbatim (D-4 — correct policy, applied per-fill instead of per-position) | `PARTIAL` |
| Partial / multi-fill positions | Handled | **Not handled** — each OUT fill becomes its own trade | `MISSING` |
| Idempotency on re-sync | Converges (upsert) | `ON CONFLICT (account_id, external_deal_id) DO NOTHING` — converges but **never corrects a previously wrong row** | `PARTIAL` |
| `external_deal_id` | position key `pos-<positionId>` | `fill.externalDealId` (the **deal** id) | `PARTIAL` — changes the identity of a trade row |
| Naive `brokerTime` | Never becomes an instant | Same rule, enforced in `normalizeDeal.ts` (no timezone data, no `new Date(naive)`, no env read) | `COMPLETE` |
| Concurrency | Lease token on `sync_jobs` | `0012`/`0013` partial unique indexes + `d6d46c6 fix(metaapi): converge a concurrent reserve that races into the SECOND unique index` | `COMPLETE` (modern stronger) |

**This is not a cosmetic difference.** Under the legacy assembler a partially-closed position, a scaled-in position, or a position with multiple exits produces one correct journal row. Under the modern importer the same account produces one row per exit fill, each with entry = exit and contract size 1, so every partial-fill position is recorded with the wrong entry price, the wrong volume and a degenerate open time. Roadmap v0.2's acceptance criterion "historical trade logs are fully synced and accurately populated" is therefore **not met** on the modern path. `STATIC`.

### 9.3 Other domain logic

| Logic | LEGACY | MODERN | Status |
|---|---|---|---|
| Timezone resolution | `TimezoneResolver` + `MetaApiInstantResolver::OFFSET_PATTERN` | `normalizeDeal.ts` — identical offset rule, ported verbatim and documented | `COMPLETE` |
| `JalaliCalendar` (`api/src/Trades/JalaliCalendar.php`) | Persian calendar conversion | **none** — grep for `jalali\|Jalali\|shamsi` across `apps`, `packages`, `db` → 0 files | `MISSING` / `LEGACY-ONLY` |
| `TradingSessionEngine` (`api/src/Trades/TradingSessionEngine.php`) | London/NY/Tokyo session classification | **none** — grep for `TradingSession\|marketSession\|sessionEngine` → 0 files | `MISSING` / `LEGACY-ONLY` |
| Achievements engine | `UserAchievementRepository` + `user_achievements` | none (only the `achievement_notifications` email flag survives) | `MISSING` |
| Metrics (win rate, expectancy, profit factor, max drawdown, Sharpe) | `api/src/Analytics/MetricsService.php` | `packages/domain/src/metrics.ts` | `PARTIAL` — implementation exists; strategy winRate/order/untagged semantics differ and are `OWNER DECISION REQUIRED` (R9) per MASTER_ROADMAP §5 |

---

## 10. Security Posture Parity

### 10.1 Aligned controls (`COMPLETE`)

| Control | LEGACY evidence | MODERN evidence |
|---|---|---|
| `X-Content-Type-Options: nosniff` | `.htaccess`, `api/.htaccess`, `Response.php` | `SECURITY_HEADERS`, `proxy.ts`, `kernel/security.ts` |
| `X-Frame-Options: DENY` | `.htaccess` | `proxy.ts` |
| `Referrer-Policy: strict-origin-when-cross-origin` | `.htaccess` | `proxy.ts` |
| `Permissions-Policy: geolocation=(), microphone=(), camera=()` | `.htaccess` | `proxy.ts` |
| `Cross-Origin-Opener-Policy: same-origin` | `.htaccess` | `proxy.ts` |
| API JSON `Cache-Control: no-store` | `Response.php` | `kernel/security.ts` |
| `X-Powered-By` suppression | `.htaccess` | `next.config.ts` `poweredByHeader:false`, API kernel |
| Webhook HMAC verification | `MetaApiService::processWebhook` | `webhooks/signature.ts` `hmacHex` + `signaturesMatch`; MetaAPI `X-MetaApi-Signature`; Stripe `Stripe-Signature` v1 with `checkFreshness` |
| Webhook raw archive + dedupe | none | `0008 webhook_events` (modern stronger) |
| Credential encryption at rest | `APP_ENCRYPTION_KEY` | `0010 user_credentials` AES-256-GCM; `CREDENTIAL_MASTER_KEY` (32 raw bytes base64, never auto-generated, fail-closed) (modern stronger) |
| DB role separation | none | `db/roles.sql` + `db/provision.ts` (`velora_owner` NOLOGIN owns objects, `velora_migrator` NOINHERIT, `app_readwrite` runtime, append-only REVOKEs on `trade_events`/`webhook_events`) (modern much stronger) |
| Secret scanning | ad-hoc | `tools/secret-scan.sh` gated in `ci.yml` and pre-deploy (modern stronger) |

### 10.2 Divergences and regressions

| # | Item | LEGACY | MODERN | Severity | Status |
|---|---|---|---|---|---|
| S1 | **Refresh cookie** | `__Host-velora_refresh`; `Secure; HttpOnly; SameSite=Strict; Path=/`; ≤128 chars | `refresh_token`; `Path=/; HttpOnly; Secure; SameSite=Lax`; **no `__Host-` prefix**; **accepted from the request body as well as the cookie** (`server.ts:421 extractRefreshToken(req.headers.cookie, body)`) | **HIGH** | `PARTIAL` — weaker SameSite + body acceptance widen CSRF/theft surface; `__Host-` loss removes the host-lock guarantee |
| S2 | **CSP model** | Release-pinned **hash-based** CSP: `policyVersion 2`, 61 routes, verified manifest + release digests, hard 503 on mismatch | Per-request **nonce + `strict-dynamic`** (`proxy.ts`); **no manifest, no hash pinning, no release binding**; **`Math.random()`-based nonce fallback in the `catch`** (weaker entropy than the Node crypto path) | **HIGH** | `PARTIAL` — no downgrade path, but no release-integrity guarantee and a weak-entropy fallback |
| S3 | **CSP surface** | `style-src https://fonts.googleapis.com`, `font-src https://fonts.gstatic.com`, `script-src`/`worker-src`/`connect-src https://cdn.jsdelivr.net` | `font-src 'self'` only, no CDN host | MEDIUM | `REPLACED` — required by S2's stricter model; fonts self-hosted; any legacy page loading those hosts breaks unless re-hosted |
| S4 | **HSTS** | `Strict-Transport-Security: max-age=31536000` in `.htaccess` | **absent from `proxy.ts` by explicit design comment** (no TLS-termination knowledge; Railway's reverse proxy assumed to own it) | MEDIUM | `NOT VERIFIED` — must be confirmed at the edge, or a downgrade/SSL-strip surface returns |
| S5 | **Static-page authorization** | 11 authenticated HTML routes gated **server-side** in `locale-router.php:193-221` → 302 to `/{locale}/login/`, `Cache-Control: no-store, max-age=0, must-revalidate`; `admin/index.html` requires session `role === 'admin'` (server-authoritative, redirects non-admins); protected pages also get `Vary: Cookie, Accept-Language`, `ETag`, `Last-Modified`, 304 on `If-None-Match` | `proxy.ts` matcher excludes only `api`, `_next/static`, `_next/image`, `favicon.ico`; gating is **client-side** (`AppSessionGate` → `RequireSession`) | **HIGH** | `PARTIAL` + `NOT VERIFIED` — the edge authorization boundary is not reproduced; the actual response for an unauthenticated `/dashboard` is unverified in this read-only audit |
| S6 | **`/markets`, `/news`, `/support` public in Modern, protected in Legacy** | In `$protectedRoutes` (server-side) | In `PUBLIC_ROUTES` (class A/B/C) and in `PUBLIC_APP_PATHS` (`AppSessionGate.tsx:24`) → **no session required** | MEDIUM–HIGH | `OWNER DECISION REQUIRED` (R8) — `AppSessionGate.tsx:11-18` states "R8 (owner decision) may later amend the contract to protect these routes — that is a contract change, not a frontend change" |
| S7 | **Same-origin guard coverage** | Legacy verifies Origin on state-changing routes | `originAllowed()` returns **`true` when the Origin header is absent** (documented non-browser exception); only `/api/v1/auth/logout` is guarded (`server.ts:318-322`) | MEDIUM | `PARTIAL` + `NOT VERIFIED` — other state-changing routes unverified |
| S8 | **Redirect responses** | Full header set | `proxy.ts` redirects emit nosniff/DENY/Referrer-Policy but **not** CSP / Permissions-Policy / COOP | LOW | `PARTIAL` |
| S9 | **API CORS** | Single echoed origin + `Vary: Origin`; methods `GET, POST, PUT, DELETE, OPTIONS`; headers `Content-Type, Authorization, X-MetaApi-Signature, X-Webhook-Signature` | `API_ALLOWED_ORIGINS` enforced explicitly in staging/prod (SC-007); `originAllowed` on state-changing routes | LOW | `COMPLETE` (modern stricter) |
| S10 | **Debug endpoint** | none | `POST /api/v1/debug/create-verified-user`, gated `APP_ENV === "development"`, unreachable in staging/prod boot, no password echo | LOW | `MODERN-ONLY` — acceptable, must remain gated at every deploy |
| S11 | **Rate limits** | PHP C-14 verified on 8 auth routes + 7 non-auth routes (`metaapi-connect`, `metaapi-detect`, `metaapi-webhook`, `ai-analyze`, `ai-report`, `ai-feedback`, `metaapi-sync`) | `RATE_LIMIT_DEFAULTS` matches all 8 auth values exactly (`login` 8/300, `register` 5/3600, `verify-email` 20/900, `resend-verification` 4/3600, `refresh` 30/300, `forgot-password` 4/3600, `reset-password` 6/3600, `change-password` 8/900) and adds `trades:extract-screenshot` 8/300; the 7 non-auth limits have no counterpart **because those routes are absent** | LOW | `PARTIAL` (consequence of the AI/MetaAPI gap) |
| S12 | **`trustedProxyCidrs`** | n/a (single-host cPanel) | Not wired in `server-main.ts` → behind a proxy the whole site shares one IP bucket (8 logins / 30 refreshes per 5 min site-wide) | **HIGH (deploy)** | `OWNER DECISION REQUIRED` (R2) |

---

## 11. Authorization, RBAC and Session Parity

### 11.1 Access tokens

| | LEGACY | MODERN |
|---|---|---|
| Algorithm | Custom HS256 (`api/src/Core/Jwt.php`), **no `alg` allow-list** | JWT service gated by `validateSecurityBoot` (SC-001/002, secret ≥32 chars, fail-closed) |
| Claims | `{sub, role}` + exp | `{sub, role}` (`authService.ts:309`) |
| TTL | 900 s | `ACCESS_TOKEN_TTL_SECONDS = 900` |

**Status: `COMPLETE`** — modern is strictly stronger (algorithm pinning + boot gate).

### 11.2 Refresh storage and rotation

The `user_sessions` shape (`refresh_token_hash`, `access_token_hash`, `expires_at`, `ip_address`, `user_agent`) and the atomic single-use rotation UPDATE are **carried**. `STATIC`. **Status: `COMPLETE`** for the store and rotation; the **cookie** is a regression (S1).

### 11.3 RBAC

| | LEGACY `api/src/Auth/Role.php` | MODERN `packages/contracts/src/rbac.ts` |
|---|---|---|
| Roles | `guest`, `user`, `admin`, `super_admin` | `user`, `admin`, `super_admin` |
| Permissions | **24** enumerated constants | **6** (`rbac.self.view`, `admin.panel.access`, `rbac.matrix.view`, `users.view`, `users.manage_status`, `users.change_role`) |
| `admin` grants | 18 | 4 |
| `super_admin` grants | 22 | 6 |
| Fail-closed | `in_array(…, permissionMap()[$role] ?? [], true)` | `canAct()` fails closed on unknown role / tampered / undefined / null / non-string; no wildcard, no allow-by-default |

Modern's own header explains the smaller vocabulary: "most name capabilities that are deferred in Modern (AI, billing, integrations, support, feature flags) or belong to Phase 3B-4 … Declaring grants for operations that do not exist would fabricate an authorization surface". The reasoning is sound, but it means **18 of 24 legacy permissions have no modern enforcement point, because the operations they guard do not exist**. `STATIC`.

**Status: `PARTIAL`.** The surviving 6 are correctly enforced, including `users.change_role` as super-admin-only (matching legacy's six super-admin-exclusive permissions). The `guest` role is dropped with no evidence of use in the modern architecture.

### 11.4 Password policy

Legacy: `PasswordService.php:202` — `mb_strlen($password) < 8` rejected; bcrypt cost `Config::get('bcrypt_cost', 12)`.
Modern: `passwordSchema` = `min(10) / max(128)` (`packages/contracts/src/auth.ts:17-20`), applied to **login** as well as register/change/reset (`loginRequest`, line 30-33).

**Status: `PARTIAL` + `OWNER DECISION REQUIRED` (R1).** A legacy user with an 8–9-character password receives `400 VALIDATION_FAILED` at login. `authService.ts:386-388` records this as a deliberate divergence. Argon2id parameters (`memoryKiB: 19456, iterations: 2, parallelism: 1`, D-04) are stricter than bcrypt-12 and are the modern default; legacy `$2y$` hashes are import-compatible with transparent rehash on next successful verify (`verifyAndRehash`).

### 11.5 Auth event / login history

Legacy records every authentication success and failure to `auth_events`, with `user_id` **NULL for unknown accounts** to preserve anti-enumeration (`AuthService.php:344-353`). Modern has **no `auth_events` table and no login-history recording** (grep for `authEvent\|auth_event\|loginHistory\|recordLogin` across `apps`, `packages`, `db` under `*.ts`, excluding tests → 0 matches).

**Status: `MISSING`.** Consequence: the legacy `/admin/security/logins` and `/admin/users/{id}/login-history` surfaces have no data source in modern.

---

## 12. Integrations Parity

### 12.1 MetaAPI

| Aspect | LEGACY | MODERN | Status |
|---|---|---|---|
| Provisioning | `MetaApiService::provisionMetaApiAccount` + `deployMetaApiAccount` + `reconcileProviderMarker` + `deleteMetaApiAccount` (1,124 lines in `MetaApiService.php`) | `POST /accounts/{id}/metaapi/connect` + compensation rollback; `provisioning_operations` (`0011`) | `PARTIAL` — connect/disconnect exist; the full provisioning lifecycle is not evidenced |
| Token model | `METAAPI_TOKEN` per installation | `METAAPI_PLATFORM_TOKEN` — explicitly "NOT a user credential, never stored in `user_credentials`, unrelated to `CREDENTIAL_MASTER_KEY` — three distinct secrets with three distinct owners" (ADR-014) | `COMPLETE` |
| Broker credentials | Stored encrypted | `POST /credentials` → AES-256-GCM envelope; plaintext never leaves the request; **never returned** | `COMPLETE` (stronger) |
| Credential boundary | AI module never queries trades directly (`TradeResolver`); architecture test `tools/tests/test_ai_p1_architecture.py` | Worker consumes **exactly two** secrets-adjacent inputs (`DATABASE_URL`, `METAAPI_PLATFORM_TOKEN`) and never imports the credential store (`metaApiSyncHandler.ts:14-17`) | `COMPLETE` (modern stronger) |
| Sync cadence | `metaapi_sync_worker` every minute | pg-boss native cron `DEFAULT_SYNC_CRON = "0 * * * *"` (**hourly**) + webhook-triggered dispatch | `PARTIAL` — 60× less frequent safety net |
| Manual sync trigger | `POST /accounts/{id}/sync` (202 `{jobId, status, deduplicated}`) | none | `MISSING` |
| Deal assembly | position-level, volume-weighted | per-OUT-deal | `MISSING` (§9.2) |
| Webhook test endpoint | `GET /webhooks/metaapi/test` | deliberately not ported (documented) | `SUPERSEDED` |
| Config | `METAAPI_BASE_URL` | `METAAPI_BASE_URL` + `METAAPI_PROVISIONING_BASE_URL` (separate host, https-only enforced) | `COMPLETE` (modern stronger) |

### 12.2 Stripe

**Legacy: zero Stripe code.** Case-insensitive grep for `stripe` across `legacy/api/` under `*.php` and `*.sql` returns **0 files**. The legacy `checkout/index.html` is a 9,953-byte thin redirect surface with 27 i18n keys.

Modern: `POST /subscriptions/checkout`, `GET /subscriptions/me`, `POST /webhooks/stripe` with `verifyStripeSignature` (header parse, v1 scheme, `signaturesMatch`, `checkFreshness`), `0017 subscriptions` with `subscriptions_one_live_per_user` partial unique index.

**Status: `MODERN-ONLY`** — a roadmap v1.0 capability that did not exist in legacy. Pricing claims ($29/mo, $240/yr) are **`NOT VERIFIED`** (no live Stripe price check; MASTER_ROADMAP BILL-01 records this).

### 12.3 Resend / transactional email

| Aspect | LEGACY | MODERN | Status |
|---|---|---|---|
| Provider | Resend only (`MAIL_DRIVER=resend`), enforced in code | Resend only (`resendMailProvider.ts`), `RESEND_ENDPOINT = https://api.resend.com/emails`, fail-closed on missing key | `COMPLETE` |
| From identity | `no-reply@veloratrade.ir` / `VELORA TRADE` | `MAIL_FROM = "VELORA TRADE <no-reply@veloratrade.ir>"` (contract C-09, verified against `Mailer.php RESEND_FROM`) | `COMPLETE` |
| Fail-closed | — | `MailResult` never throws; `{ok:false, reason:"not-configured"\|"rejected"\|"transport-error"}` so anti-enumeration flows cannot leak provider state | `COMPLETE` (modern stronger) |
| **Email types sent** | **10**: verification, welcome, password-reset token, admin invite, password-changed, new-device detected, first-trade, achievement-unlocked, support-new-ticket, support-reply (`NotificationService.php`) | **2**: verify-email, reset-password (`authService.ts:442,560`) | `MISSING` (8 of 10) |
| HTML templates + inline CID icons | `EmailTemplate::render` (9,250 bytes) + `Mailer::sendWithInlineImages` + `public/assets/email-icons` | `MailMessage.html` is **optional**; the auth service sends `text` + `subject` only | `MISSING` |
| Locale-aware copy | `resolveEmailLocale`, `localizeCopy` | none | `MISSING` |
| Delivery log | `email_notifications` table | none | `MISSING` |
| Email preferences | 6 keys, all default ON | `0003` — exact parity | `COMPLETE` |

### 12.4 pg-boss / queue

Legacy: `sync_jobs` MySQL table + lease tokens + `Database::transaction`.
Modern: pg-boss v10 native cron, `DEFAULT_JOB_POLICIES` per class (`webhook-projection`, `sync`, `ai`, `reports`, `maintenance`), `stately` policy with `singletonKey` debouncing, transactional outbox in `createTrade`, DLQ, and `REDIS_INTRODUCTION_TRIGGERS` documented as an explicit boundary.

**Status: `COMPLETE`** for the mechanism; **`NOT VERIFIED`** at runtime because the worker is not deployed (§13.2).

### 12.5 Other integrations

| Integration | LEGACY | MODERN | Status |
|---|---|---|---|
| n8n (content approval archive + instance migration + Gemini relay transport) | `content/n8n-archive/` (schema + validator, `snapshots: []`), `docs/N8N_*.md` (4 docs, 33 KB), `N8nGeminiRelayTransport.php` | grep for `n8n` returns only: `tools/secret-scan.sh`, `packages/contracts/src/webhooks.ts`, `docs/threat-model.md`, `docs/external-contracts.md`, `docs/evidence/BLOCKED-REPORT-2026-08-31.md`, `docs/capability-registry.md`, `docs/adr/ADR-008-webhook-ingestion.md`, `docs/adr/ADR-006-contract-tiering.md`, `db/tests/extendedCapabilities.pg.test.ts` — **no implementation** | `LEGACY-ONLY` |
| Tesseract OCR fallback | `api/src/AI/Providers/TesseractProvider.php` (cost tier 0, 8 s timeout, 8 MB cap, `proc_open` check, `ocr`/`text` capabilities) | grep for `tesseract\|Tesseract\|OCR\|ocr` across `apps`, `packages`, `db` → **zero implementation matches** (only `docs/reconciliation/*` and `docs/evidence/*` records) | `LEGACY-ONLY` |
| OpenAI | `OPENAI_API_KEY`, `gpt-4o-mini` | `ai_coaching_logs.provider CHECK (provider IN ('openai','gemini'))` — schema only, no provider implemented | `MISSING` |
| Translation service | `TRANSLATION_SERVICE_*` + `content_translation_worker` | none | `LEGACY-ONLY` |
| ECB FX | none | `currency_rates` + `FX_TICK` (`DEFAULT_FX_CRON = "30 16 * * *"`) | `MODERN-ONLY` (roadmap v1.5) |

---

## 13. Background Workers, Cron and Scheduled Work

### 13.1 Fleet comparison

| LEGACY | Cadence | MODERN | Status |
|---|---|---|---|
| `metaapi_sync_worker` (`MetaApiService::runNextSyncJob`) | every minute | `SYNC_TICK` → `MetaApiSyncHandler` | `PARTIAL` (hourly cron; assembly diverges) |
| `content_translation_worker` | every minute | none | `MISSING` |
| `ai_job_worker` | every 5 minutes | none (no AI jobs exist) | `MISSING` |
| `ai_retention_cleanup` (`AI_RETENTION_DAYS=30`) | daily | none | `MISSING` |
| — | — | `FX_TICK` → ECB ingestion | `MODERN-ONLY` |
| — | — | `ANALYTICS_TICK` → `user_analytics_daily` / `account_performance_summary` pre-aggregation (`ea389f4`) | `MODERN-ONLY` |
| — | — | `COPY_TICK` → copy-dispatch outbox (`b5dcdb3`) | `MODERN-ONLY` |
| 3 CLI tools (preflight / migration / prepare-private-runtime) | on demand | none | `MISSING` |

### 13.2 **Blocking finding: the worker is not deployed**

`apps/worker/src/index.ts`'s own header states that `railway.json` declares a single API service and that Railway config-as-code has no `services` key. `infra/docker-compose.yml` **does** define a `worker` service, but that file is explicitly labelled "DEV/STAGING ONLY" and its header records that Gate 3B is "BLOCKED 0/20 — no production host exists".

**Consequence:** every scheduled background job in the modern system — the analytics pre-aggregation the roadmap's CTO mandate requires ("never compute Sharpe/expectancy/max-drawdown on request"), the FX rate ingestion, the copy-dispatch pipeline, and the hourly MetaAPI sync safety net — is **not running in any deployed environment**. `STATIC` (the absence) + `NOT VERIFIED` (any runtime behaviour).

**Status: `OWNER DECISION REQUIRED`** — the worker needs a service definition in `railway.json` (or an equivalent) before any async capability can be claimed.

---

## 14. Data Migration and Cutover Readiness

| Item | Evidence | Status |
|---|---|---|
| Strategy documented | `docs/migration-strategy.md`; ROADMAP §1: MySQL (read-only source) → PostgreSQL (target), rehearsed, validated, reversible | `COMPLETE` (documentation) |
| Rehearsal gates defined | Row counts, checksums, FK 0, unique checks, login smoke with real `$2y$` vectors, PnL golden recompute, screenshot byte + 1:1 check, timestamp sanity | `COMPLETE` (documentation) |
| ID preservation | `setval` fixup for identity columns | `COMPLETE` (documentation) |
| Password import | `users.password_hash` imported unchanged; transparent rehash on next verify | `COMPLETE` |
| Session import | `user_sessions` **empty by design** (planned logout) | `COMPLETE` (documented decision) |
| **Naive `datetime` interpretation** | **BLOCKED on ADR-004 sampling** — no transform code until owner-confirmed via sampled data | `OWNER DECISION REQUIRED` |
| **`profit_loss` → `net_pnl`** | Legacy writes `profit_loss = net_pnl` on create (`TradeService.php:158`), so a straight column map is arithmetically safe; but legacy `r_multiple` scale 4 → modern scale 8 is a **format change on every row** | `PARTIAL` |
| **`subscriptions` mapping** | Legacy models subscription as `users.{plan, subscription_status, plan_started_at, plan_expires_at, plan_updated_at}`; modern as `0017 subscriptions` with a different status vocabulary | `PARTIAL` — requires an explicit mapping decision (`grace`/`expired` have no modern target) |
| **Tables with no modern target** | `ai_*` ×8, `support_tickets`, `support_messages`, `email_notifications`, `auth_events`, `user_achievements`, `content_translations`, `system_logs`, `integration_health` | `MISSING` — data loss on cutover unless archived |
| **`trade_screenshots` bytes** | Legacy table is declared but **unused** (no PHP code references it), so there are no bytes to move | `COMPLETE` (nothing to migrate) |
| Cutover rehearsal executed | **No** — no production or staging environment exists (Gate 3B BLOCKED 0/20) | `NOT VERIFIED` |

---

## 15. Testing, Quality Gates and CI/CD Parity

### 15.1 Test inventory

| | LEGACY | MODERN |
|---|---|---|
| Test files | 174 (86 PHP `test_*.php`, 68 Python `test_*.py`, 13 JS) | 100 (93 `*.test.ts` + 23 `*.pg.test.ts` batteries) |
| PHP unit tests | 86 | n/a |
| Python tests | 68 (incl. 20 dedicated to `admin/v2`) | 10 (`ops/backup/tests`) |
| Local battery | — | `node tools/run-tests.mjs` → **804/804 PASSED** (recorded in `FRONTEND_MIGRATION_FINAL_REPORT.md` §16 and `docs/frontend-migration-progress.md`) |
| Real-PG batteries | — | 23 `*.pg.test.ts`, run only against a disposable PostgreSQL via `postgres-evidence.yml`; **excluded from the local battery by design** so real-PG skips are never reported as local verification |
| Contract coverage | Contract-shaped PHP tests (Resend HTTP mock, email gold-outline, auth token consumption, admin verify-email RBAC/idempotency/audit/rate-limit, admin canonical replacement) | `packages/contracts` tests (locale, email links, rate limits, Argon2id, error taxonomy, scales) |

### 15.2 CI gates

| Gate | LEGACY (`ci.yml`, 33 workflows) | MODERN (`ci.yml` + 6 more) |
|---|---|---|
| Syntax / type check | `php -l` across all PHP files | `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` |
| Test run | PHP + Python suites | `node tools/run-tests.mjs` |
| Migration test | ad-hoc | `npm run test:migrations` |
| Secret scan | ad-hoc | `bash tools/secret-scan.sh` |
| Deploy gate | FTP preflight | `deploy-staging-gated.yml`: build → typecheck → test → secret-scan → backup unittest → Railway |
| Backup gate | `AGENTS.md` §14 permanent BACKUP GATE law (2026-09-09) | `ADR-012` law + `backup-gate.yml` + `backup-retention.yml` (daily 03:30) |
| Health check | — | `healthcheck-staging.yml`, `healthcheck-suite.yml` |
| Postgres evidence | — | `postgres-evidence.yml` (workflow_dispatch) |

**Status: `COMPLETE`** on the modern side for what exists; the gap is **scope**, not quality — there are no tests for the missing capabilities (AI, support, admin, content translation) because there is nothing to test.

**Verification split:** `STATIC` (the gates exist and their recorded results are documented). `RUNTIME` — `804/804`, `next build` 35 routes and `secret-scan 0 findings` are recorded as executed results in the modern repository's own dated reports (2026-09-24), **not re-executed in this audit**. `NOT VERIFIED` — this audit did **not** install dependencies or run the suites (read-only constraint), and did **not** execute any `*.pg.test.ts` battery against a real PostgreSQL.

---

## 16. Documentation, ADRs and Governance Parity

### 16.1 ADRs

| | LEGACY | MODERN |
|---|---|---|
| Count | `docs/adr/` | **15** files: ADR-001 … ADR-014, ADR-016 |
| Status | — | all 15 `Accepted` |
| Numbering | — | **ADR-015 is absent** from the sequence — no ADR-015 file exists and no ADR references one. A gap in the decision record. |

**Status: `PARTIAL`** — modern has a far stronger, formalised decision record than legacy, with one numbering gap and several ADRs whose "Accepted" status sits above open sub-items (ADR-004 legacy-TZ sampling; ADR-009 hreflang verification).

### 16.2 Documentation inventory

| | LEGACY | MODERN |
|---|---|---|
| Markdown docs | 66 | 68 |
| Authoritative roadmap | `docs/pdf/Roadmap.pdf` (17 pp) | `MASTER_ROADMAP.md` (root) — reconciles the PDF with the modern architecture and supersedes the PDF's MySQL/cPanel target |
| Governance | `AGENTS.md` (Persian, 14 sections + permanent BACKUP GATE law §14) | `AGENTS.md` (English, 14 non-negotiable rules + evidence vocabulary) |
| Contracts register | ad-hoc | `docs/external-contracts.md` (C-01…C-22, each with source + verification method + owner) |
| Capability register | — | `docs/capability-registry.md` (CAP-* rows) |
| Threat model / security policy | `docs/pdf/Security Checklist.pdf` | `docs/threat-model.md`, `docs/security-policy.md` |
| Evidence separation | — | `docs/evidence/`, `docs/provenance/`, `docs/reconciliation/` (incl. `BLOCKED-REPORT-2026-08-31.md`) |

**Status: `COMPLETE`** on structure, and substantially **stronger** than legacy.

### 16.3 Documentation defects found in this audit

| # | Defect | Evidence | Severity |
|---|---|---|---|
| D1 | **`README.md` is stale.** It states "No application code exists in this repository yet, by design" and "Phase 1 … in progress". 267 TypeScript files exist across `apps/api` (120), `apps/web/src` (117) and `apps/worker` (30), and the frontend work was merged to `main` on 2026-09-24. | `modern/README.md` vs `find apps -name '*.ts' \| wc -l` | MEDIUM |
| D2 | **`README.md` understates the ADR set** ("all ten Accepted 2026-08-29") when 15 exist. | `README.md` vs `ls docs/adr/` | LOW |
| D3 | **`MASTER_ROADMAP.md` is stale relative to `main`.** Its footer says "Generated 2026-09-23 on `feat/web-landing-parity` from `80f0ade`". It marks W1/W2/W3/W4/DEP-01/AUTH-01 as `PLANNED`/`BLOCKED`, but those landed on `main` @ `ffcb0e9` (merge of PR #7, 2026-09-24 22:52 +0330). | `MASTER_ROADMAP.md` §3 vs `git log -1 ffcb0e9` | MEDIUM |
| D4 | **Non-existent legacy reference.** `attachmentService.ts:20` cites `api/src/Trades/ScreenshotController.php`, which does not exist in the legacy repository. | §5 | LOW |
| D5 | **Three frontend reports coexist with different scopes** (`FRONTEND_MIGRATION_FINAL_REPORT.md`, `FRONTEND_CLOSURE_REPORT.md`, `frontend-migration-progress.md`); none is marked superseded and all three describe a local branch state that is now on `main`. | `docs/` | LOW |

---

## 17. Operational Tooling, Backup, Deployment and Observability Parity

### 17.1 Tooling

| | LEGACY | MODERN |
|---|---|---|
| `tools/` | 196 files: `check_frontend_url_guard.py`, `check_github_cost_guard.py`, `structure_sync.py`, `velora-bootstrap.sh`, `velora-status.sh`, `e2e/`, `email-icons/`, `localization/`, `n8n_archive/`, `tests/` | 7 files: `parity-smoke.ts`, `pg-smoke.ts`, `run-pg-batteries.sh`, `run-tests.mjs`, `secret-scan.sh` |
| `ops/` | `ops/velora-mgmt/` (probe templates: `trade_migration_probe.php.tmpl`, `mgmt_probe.php.tmpl`, `db_verify_probe.php.tmpl`, `db_backup_probe.php.tmpl`, `app_schema_migration_probe.php.tmpl`, `admin_migration_probe.php.tmpl`) + `backup_gate.py` | `ops/backup/` (9 files: `README.md`, `backup_gate.py`, `create_pg_backup.sh`, `reap_retention.py`, `retention.py`, `sample_e2e.py`, `upload_backup.py`, `tests/`) |

**Status: `PARTIAL`.** The backup-gate law was ported verbatim and extended (`backup_type`, `storage_status == STORAGE_VERIFIED`, `NOT_APPLICABLE`, freshness), which is a genuine strengthening. The operational probe/monitoring toolset (`ops/velora-mgmt/probe/*.tmpl`, `velora-status.sh`, structure/URL/cost guards) has no modern counterpart.

### 17.2 Backup and restore

| Item | Evidence | Status |
|---|---|---|
| Gate law | `AGENTS.md` §14 (legacy, 2026-09-09) → `ADR-012` + `ops/backup/backup_gate.py` (modern) — six-field evidence contract adopted verbatim from `a8eabac` | `COMPLETE` |
| Mechanism | `create_pg_backup.sh` (`pg_dump` custom format), `restore.sh` (referenced by `infra/backup/DR-RUNBOOK.md`), `reap_retention.py`, `upload_backup.py` | `COMPLETE` (mechanism exists) |
| Tests | `ops/backup/tests`, run in `backup-retention.yml` and `deploy-staging-gated.yml` | `COMPLETE` |
| **First real backup** | `infra/backup/DR-RUNBOOK.md` "Current status (2026-08-31): **BLOCKED** — no PostgreSQL environment exists in the dev sandbox (Docker absent). This is an environment blocker, not a completed drill. Gate 3B rows 7/8 remain NOT VALIDATED." | `NOT VERIFIED` — **mechanism-exists is not backup-exists** (AGENTS.md rule 13) |
| **Restore drill** | Same runbook: "A backup that was never restored is not a backup." No drill recorded. | `NOT VERIFIED` |
| PITR / offsite | "Production (Gate 3B side — later)" | `MISSING` |
| RPO / RTO targets | "owner decision at production-readiness review" | `OWNER DECISION REQUIRED` |

### 17.3 Deployment

| Item | LEGACY | MODERN | Status |
|---|---|---|---|
| Container images | none (cPanel) | `infra/Dockerfile.api` (multi-stage, non-root `USER node`, healthcheck on `/health` C-01), `Dockerfile.worker`, `Dockerfile.web` | `COMPLETE` |
| Compose | — | `infra/docker-compose.yml` (postgres 16 + api + worker + web), **explicitly DEV/STAGING ONLY** | `COMPLETE` (with scope caveat) |
| Platform config | FTP | `railway.json` — **single API service; no worker service** | `MISSING` (worker) |
| Image digest pinning | — | Deferred: "pin the base image digests before any production use" (Gate 3B rows 11-12) | `NOT VERIFIED` |
| Env contract | `api/.env.example` (35 keys incl. all AI/Gemini/OCR/translation) | `infra/env/.env.example` (no real values, no secrets) | `COMPLETE` (modern stricter: `APP_ENV`/`APP_ORIGIN` explicit, `CANONICAL_*_ORIGINS`, separate `ADMIN_`/`MIGRATION_DATABASE_URL`) |
| Environment↔origin safety | — | `ADR-013` boot gate blocks a staging/prod start with an empty canonical origin set, blocks when `APP_ORIGIN` ∉ set, blocks cross-bindings | `COMPLETE` (modern stronger) |
| Production host | cPanel | **None** (Gate 3B BLOCKED 0/20) | `NOT VERIFIED` |

### 17.4 Observability

| Item | LEGACY | MODERN | Status |
|---|---|---|---|
| Health endpoint | — | `GET /health` (frozen contract C-01, 4-field envelope) + `GET /ready` split (MetaAPI deliberately excluded) | `MODERN-ONLY` |
| Request correlation | — | `X-Request-Id` nonce on every response; `requestId` is the join key for operator logs | `MODERN-ONLY` |
| Error classification | — | `apps/worker/src/observability/safeError.ts` `ClassifiedError` + `WorkerErrorCode`; the `PERSISTABLE` map narrows to the DB CHECK vocabulary `^[A-Z0-9_]{1,48}$` | `MODERN-ONLY` |
| System logs / diagnostics surface | `GET /admin/system/logs`, `/admin/system/health`, `/admin/system/diagnostics`, `system_logs` + `integration_health` tables | none | `MISSING` |
| Observability contract doc | — | `docs/observability-contract.md` | `MODERN-ONLY` |

---

## 18. Consolidated Status Register

Counts are of **distinct capabilities/contracts**, not of lines.

| Status | Count | Representative items |
|---|---|---|
| `COMPLETE` | 31 | money math; JWT hardening; session store + rotation; `email_preferences`; Resend provider + From identity; webhook HMAC + archive; credential encryption; DB role separation; landing-page parity; fa/en catalog parity for migrated chunks; locale header; cache classes; RTL/LTR + Latin digits; security headers (nosniff/DENY/Referrer/Permissions/COOP); CORS; rate-limit values (C-14); backup-gate law; container images; env contract; environment↔origin safety; health/ready; request-id; error taxonomy; i18n validators; secret-scan gate; CI gates |
| `PARTIAL` | 28 | trades list filters + default sort; `PUT` financial immutability; `r_multiple` scale; MetaAPI sync (cadence + assembly); RBAC vocabulary; password policy; refresh cookie; CSP model; static-page authorization; `/markets\|/news` gating; same-origin guard coverage; admin surface; AI coach; analytics capability gating; attachments byte sink; worker deployment; data-migration mappings; i18n coverage (39.5%); ADR numbering; README/roadmap staleness; ops tooling; PnL range guard; trades index set; metrics strategy semantics; profile completeness; provisioning lifecycle |
| `MISSING` | 22 | position assembly; manual sync trigger; 59 admin endpoints; 3 AI endpoints; screenshot extraction; 5 support endpoints; 3 dashboard endpoints; content-translation lookup; `resend-verification-email` alias; auth events / login history; achievements; notifications feed; email-notifications log; Jalali calendar; trading sessions; system logs / diagnostics; OpenAI provider; OCR fallback; n8n relay transport; 8 email types; `trade_screenshots` byte sink; 8 `ai_*` tables |
| `REPLACED` | 9 | PHP→Node; MySQL→PostgreSQL; cPanel→Railway; static HTML→Next.js; 6-step→3-step MetaAPI connect; `trade_screenshots`→`trade_attachments`; Google Fonts→self-hosted; legacy CSS→new system; `/dashboard/*`→`/analytics/*` |
| `SUPERSEDED` | 4 | roadmap MySQL/cPanel target; `GET /webhooks/metaapi/test`; duplicate admin write paths; webhook-time trade assembly |
| `LEGACY-ONLY` | 5 | n8n archive + instance migration; n8n Gemini relay transport; Tesseract OCR fallback; content translation service + worker; legacy ops probe toolset |
| `MODERN-ONLY` | 17 | Stripe billing; credentials API; portfolio; account groups; EA ingestion; push registration; developer API; copy trading; tags; attachments; ownership claim; RBAC introspection; analytics endpoints; ECB FX; append-only ledger; public verification seals / public profiles; trade-tag association |
| `NOT VERIFIED` | 12 | HSTS at the edge; static-route authorization behaviour; worker runtime; any scheduled job; analytics pre-aggregation; Stripe live prices; real-PG batteries in this audit; local test suite in this audit; first backup; restore drill; cutover rehearsal; production host |
| `OWNER DECISION REQUIRED` | 9 | R1 password policy; R2 `trustedProxyCidrs`; R8 public vs protected routes; R9 strategy semantics; OD-1 staging origin; ADR-004 naive-datetime sampling; RPO/RTO; subscription vocabulary mapping; worker service definition |

---

## 19. Final Closure Gate and Verdict

### 19.1 The 15-item closure gate

| # | Gate item | Verdict | Evidence |
|---|---|---|---|
| **1** | **All legacy production capabilities have a modern counterpart, or a recorded owner-approved decision to drop them.** | **FAIL** | 76 of 103 legacy routes have no modern counterpart (§4.2). Only one carries a recorded decision (`GET /webhooks/metaapi/test`, `webhookRoutes.ts:13`), and no decision record anywhere carries an owner approval signature. The breakdown: 59 admin, 5 support, 3 dashboard, 3 AI, 2 account-sync, 1 content-translation, 1 trades, 1 auth-alias, 1 webhook — and none of the 59 admin endpoints has a decision record. |
| **2** | **API contracts match in method, path, status codes, error codes and envelope.** | **FAIL** | Method changes: `POST /admin/users/{id}/status` → `PATCH`, `POST /admin/users/{id}/role` → `PATCH`. Semantics: `GET /trades` `symbol` (exact → LIKE), `from` (close → open), `q` (`strategy_tag` → `strategy`), default sort (`close_time` → `open_time`). Status: `PUT /trades/{id}` financial fields (allowed → 403). Numeric: `r_multiple` scale 4 → 8. |
| **3** | **Data model covers every legacy table/column, with an explicit mapping for each difference.** | **FAIL** | 8+ legacy tables have no modern target (`ai_*` ×8, `support_tickets`, `support_messages`, `email_notifications`, `auth_events`, `user_achievements`, `content_translations`, `system_logs`, `integration_health`); `users.subscription_status`/`plan_*`/`locale_source`/`locale_updated_at`/`confirmation_code`/`remember_token` have no modern column; no mapping decision is recorded. |
| **4** | **Financial calculations produce identical results for identical inputs.** | **FAIL** | `r_multiple` scale divergence (§9.1). Additionally, MetaAPI-imported trades carry a different entry price, exit price, volume and contract size than legacy for the same provider data (§9.2). |
| **5** | **Frontend surfaces exist for every legacy user-facing route, with visual/behavioural parity where required.** | **FAIL** | Dashboard (product surface), performance, wallet, intelligence, support, admin console, blog, privacy, terms and checkout have no modern implementation. Only the landing page has recorded pixel-equivalence evidence. |
| **6** | **Authorization boundaries are reproduced, including any server-side/edge gating.** | **FAIL** | Legacy's 11 server-gated HTML routes have no modern edge equivalent (S5); `/markets`, `/news` and `/support` are public in Modern and protected in Legacy (S6, unresolved R8). |
| **7** | **Security posture is at least equal to legacy on every control.** | **FAIL** | Refresh cookie (`__Host-` prefix lost, SameSite Strict→Lax, body acceptance added); CSP release pinning/manifest lost with a `Math.random()` nonce fallback; HSTS absent pending edge verification. Three regressions, one unverified. |
| **8** | **Integrations behave equivalently (MetaAPI, Stripe, Resend, queue, webhooks).** | **PARTIAL** | Stripe is a new capability with no legacy baseline (acceptable). MetaAPI sync cadence and trade assembly diverge materially. Resend is equivalent for 2 of 10 email types. Queue and webhooks are equivalent or stronger. |
| **9** | **Background/cron work is deployed and proven to run.** | **FAIL** | The worker is absent from every service definition; no scheduled job has ever run in a deployed environment (§13.2). |
| **10** | **Data migration path is rehearsed and validated end-to-end.** | **FAIL** | ADR-004 naive-datetime interpretation is BLOCKED pending owner-confirmed sampling; no cutover rehearsal has been executed (no PG environment exists). |
| **11** | **Test suite covers the migrated surface and passes.** | **PARTIAL** | 804/804 local + 35-route build + 0 secret findings recorded on the modern side (stronger than legacy in quality), but the missing capabilities are untestable and the real-PG batteries were not run in this audit. |
| **12** | **Documentation and ADRs are current, complete and consistent.** | **FAIL** | `README.md` claims no application code exists; `MASTER_ROADMAP.md` is one commit behind `main`; ADR-015 is missing; `attachmentService.ts` cites a non-existent legacy file; three frontend reports coexist unmarked. |
| **13** | **Operational tooling, backup and restore are proven.** | **FAIL** | The mechanism exists and is well designed, but **no backup has ever been taken and no restore drill has ever been run** (Gate 3B rows 7/8 NOT VALIDATED). |
| **14** | **Deployment path is complete for every runtime component.** | **FAIL** | No worker service in `railway.json`; no production host; image digests unpinned; `trustedProxyCidrs` unwired (R2). |
| **15** | **Every remaining gap is either closed or explicitly accepted by the owner in writing.** | **FAIL** | Nine `OWNER DECISION REQUIRED` items remain open (R1, R2, R8, R9, OD-1, ADR-004 sampling, RPO/RTO, subscription mapping, worker service definition). None carries a recorded owner resolution. |

**Gate score: 1 PARTIAL, 14 FAIL, 0 PASS.**

### 19.2 Verdict

**MIGRATION CLOSURE STATUS: NOT CLOSED — PARTIAL MIGRATION WITH MATERIAL BEHAVIOURAL DIVERGENCE AND BLOCKING OPERATIONAL GAPS.**

**What is genuinely done and should not be re-litigated**

The foundation is real and, in several respects, better than the system it replaces. Decimal-exact money math with typed scales and no float path; an append-only trade ledger with version CAS, tombstones and an allocation guard; PostgreSQL role separation with append-only REVOKEs; AES-256-GCM credential encryption with fail-closed key management; HMAC-verified webhooks with a durable raw archive and dedupe; a strict nonce CSP; an explicit environment↔origin boot gate; a backup-gate law adopted verbatim from the legacy owner's own law and extended with storage verification and freshness; 804 passing local tests and a secret-scan gate. The landing page is byte-identical in its catalogs and pixel-equivalent per recorded evidence. Auth, session storage, rotation and rate limits match the verified PHP contract exactly. Each of these is backed by a file path and, where applicable, a recorded command result.

**What blocks closure, in priority order**

1. **MetaAPI trade assembly** (§9.2). Per-fill trade creation with `entry_price = exit_price` and hardcoded `contract_size = 1` cannot satisfy roadmap v0.2's "historical trade logs fully synced and accurately populated". This is the highest-severity functional defect in the audit because it silently corrupts the core dataset, and `ON CONFLICT DO NOTHING` prevents self-correction.
2. **Worker not deployed** (§13.2). Every async capability — including the analytics pre-aggregation the roadmap's CTO mandate requires and the sync safety net — is unproven.
3. **Security regressions** (§10.2): refresh cookie, CSP release pinning, unverified HSTS, and the absent edge authorization boundary for the 11 legacy-protected routes.
4. **Admin console absent** (§4.2): 59 of 62 legacy admin endpoints and the 334 KB console have no modern counterpart, and 18 of 24 RBAC permissions consequently have nothing to guard.
5. **AI layer absent** (§12.5): provider boundary only — no OCR, no screenshot extraction, no quota/retention/audit, no admin control.
6. **Backup/restore unproven** (§17.2): mechanism-exists is not backup-exists.
7. **Documentation drift** (§16.3): README, roadmap and one source citation are factually wrong today.

**Required before the closure question can be re-asked**

(a) Re-implement MetaAPI position assembly in `importBatch` with volume-weighted IN/OUT aggregation, earliest-IN / latest-OUT timestamps, contract size from the deal, and an `ON CONFLICT DO UPDATE` convergence path. (b) Add a `worker` service to `railway.json` and prove one tick of each scheduler in a real environment. (c) Restore the `__Host-` refresh-cookie prefix and `SameSite=Strict`, remove body acceptance, and decide the CSP pinning model. (d) Reproduce the legacy edge authorization boundary, or obtain an explicit owner decision that client-side gating is sufficient. (e) Take one real backup and complete one restore drill. (f) Resolve the nine open owner decisions. (g) Correct README, MASTER_ROADMAP, ADR numbering and the `ScreenshotController` citation.

**Explicit non-findings (stated so they are not mistaken for gaps)**

The modern repository's use of PostgreSQL over MySQL, Next.js over static HTML, Railway over cPanel, a 3-step MetaAPI flow over a single call, tombstones over physical deletes, self-hosted fonts over Google Fonts, and Stripe billing where legacy had none are all **deliberate, documented replacements or roadmap-required additions**, not migration failures. Likewise, the roadmap's v1.5–v3.0 capabilities (native EAs, React Native apps, white-label, copy trading, voice AI, ML inference, developer marketplace) exist in neither repository and are excluded from the failure count.

---

## Appendix A — Verification Method per Claim

| Claim class | Method | Tag |
|---|---|---|
| Route existence / absence | Literal and regex search of `/api/v1/…` across `apps/api`, `packages`, `db` under `*.ts`, excluding `*.test.ts`, cross-checked against the dispatch tables in `kernel/server.ts` and every `*Routes.ts`; legacy side derived from `api/index.php` including the 4 `$router->add(…)` registrations | `STATIC` |
| Schema parity | Column extraction from legacy `.sql` vs `db/migrations/0001..0022` + `db/schema-snapshots/modern-target-0022.sql` | `STATIC` |
| i18n parity | Recursive key flattening and set comparison of every chunk in both locales in both repositories; `md5sum` byte comparison for migrated chunks | `STATIC` |
| PnL equivalence | Line-by-line source comparison of `PnlCalculator.php` and `packages/domain/src/pnl.ts`, including rounding scales | `STATIC` |
| Sync semantics | Source comparison of `MetaApiDealAssembler::assemble()` against `syncRepository.ts importBatch()` and its exact INSERT column/parameter list | `STATIC` |
| Test / build results | Read from the modern repository's dated reports; **not re-executed** (read-only constraint) | `RUNTIME` (as recorded) |
| Anything needing a live service, credentials, a DB, or a deployed worker | Not attempted | `NOT VERIFIED` |

## Appendix B — Evidence Index (primary files)

**Legacy:** `api/index.php` · `api/database/{schema.sql,database.sql,database_corrected.sql,add_columns.sql}` · `api/src/Auth/{AuthService,Role,PasswordService,Jwt}.php` · `api/src/Core/{Response,RateLimiter,Mailer,EmailTemplate,NotificationService,Csrf,Config}.php` · `api/src/Trades/{TradeController,TradeService,TradeRepository,PnlCalculator,JalaliCalendar,TradingSessionEngine,MetaApiDealAssembler,MetaApiInstantResolver,ScreenshotExtractController}.php` · `api/src/Accounts/{AccountController,MetaApiService}.php` · `api/src/Dashboard/DashboardController.php` · `api/src/Analytics/MetricsService.php` · `api/src/AI/**` (~4,301 lines) · `api/src/Admin/**` · `api/src/Support/**` · `api/src/Workers/**` · `locale-router.php` · `.htaccess` · `api/.htaccess` · `admin/v2/index.html` · `localized/{fa,en}/**` · `public/locales/chunks/{fa,en}/*.json` · `docs/pdf/Roadmap.pdf` · `AGENTS.md` · `.github/workflows/*` (33)

**Modern:** `MASTER_ROADMAP.md` · `AGENTS.md` · `README.md` · `apps/api/src/kernel/{server.ts,security.ts}` · `apps/api/src/{auth,trades,accounts,analytics,webhooks,billing,aicoach,developer,ea,portfolio,tags,tenancy,admin,attachments,mail}/**` · `apps/web/src/{proxy.ts,localeKernel.ts,lib/auth/AppSessionGate.tsx}` · `apps/web/messages/{fa,en}/*.json` · `apps/web/src/app/**` · `apps/worker/src/**` · `packages/contracts/src/{locale.ts,auth.ts,rbac.ts,money.ts,jobs.ts,webhooks.ts,metaapiSync.ts}` · `packages/domain/src/{pnl.ts,decimal.ts,metrics.ts}` · `db/migrations/0001..0022` · `db/roles.sql` · `db/provision.ts` · `infra/{docker-compose.yml,Dockerfile.api,Dockerfile.worker,Dockerfile.web,env/.env.example,backup/DR-RUNBOOK.md}` · `ops/backup/**` · `railway.json` · `tools/**` · `docs/adr/**` (15) · `docs/{external-contracts,capability-registry,parity-plan,deployment-contract,observability-contract,security-policy,threat-model,migration-strategy,hosting-validation}.md` · `docs/FRONTEND_*REPORT.md` · `docs/frontend-migration-progress.md` · `.github/workflows/*` (7)

---

*End of audit. Every conclusion above is traceable to a file path, symbol, route, table or migration number in one of the two repositories, or is explicitly tagged `NOT VERIFIED` or `OWNER DECISION REQUIRED`. No information was inferred where evidence was obtainable, and no inference is relied upon for any verdict.*
