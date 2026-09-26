# VELORA — MASTER ROADMAP (Authoritative)

> **⚠ RECONCILIATION NOTICE (2026-09-26, ADR-017).** This roadmap remains the
> architecture authority, but it predates the 2026-09-25 two-repository
> migration audit
> (`docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md`) and is
> known to conflict with it — e.g. ACCT-02 / AI-01 / ADMIN-01 are marked
> `COMPLETED (backend)` here while the audit rules MetaAPI position assembly a
> correctness blocker (§9.2), the AI layer a provider-boundary seam only
> (§12.5), and the admin surface 93% absent (§4.2); §3 W-phase statuses
> predate the `ffcb0e9` merge (2026-09-24). Per owner instruction the rows
> below are left unedited; the contradictions are recorded in
> `docs/state/MIGRATION_GAP_REGISTER.md` §E (MG-DOC-3) pending an
> owner-reviewed reconciliation. For the present, trust
> `docs/state/CURRENT_STATE.md` — validated by `node tools/agent-context.mjs`.

**Authority:** This document is the single authoritative roadmap for `veloratrade/velora-modern`.  
It reconciles the Legacy product roadmap (`veloratrade/veloratrade` → `docs/pdf/Roadmap.pdf` @ `edede31`, 17 pages, `Velora_Master_Roadmap_v0.1_v3.0`) with the actual Modern architecture on `main` @ `80f0ade` and the landing implementation on `feat/web-landing-parity` (2026-09-23).

**Supersedes:** All prior roadmap fragments (`docs/migration/ROADMAP.md` on `feature/phase-6f-frontend-parity`, `docs/roadmap-schema-design-0015-0022.md` *as a phase-5 design record*, and the Legacy PDF's MySQL/cPanel target). The PDF remains the **product capability** reference; it is **not** the Modern DB/hosting authority.

**Status vocabulary:** `COMPLETED` (verified), `IN PROGRESS`, `PLANNED`, `BLOCKED`, `OWNER DECISION REQUIRED`, `LEGACY REFERENCE ONLY`.

---

## 1. Database Strategy — Reconciled (Critical)

**Old roadmap assumption (Legacy PDF, p.2):** `MySQL 8.0 | PHP 8.3 REST API | Linux cPanel`.  
**Actual Modern architecture (VERIFIED on `main`):** `PostgreSQL 16 + direct `pg` (no ORM, ADR-010/OD-6), `pg-boss` queue, `timestamptz` UTC, `NUMERIC` per ADR-001, `bcrypt $2y$` proof-passed (ADR-005). Migrations `0001`..`0022` forward-only, additive, ownership via composite FKs (`trades(id,user_id)`), no plaintext secrets.

**Decision:** **PostgreSQL is authoritative.** The PDF's MySQL is `LEGACY REFERENCE ONLY` — retained for entity-name and capability authority, not for engine/hosting. No MySQL is provisioned in Modern; no MySQL-to-MySQL migration is planned. The migration path is **MySQL (Legacy, read-only source) → PostgreSQL (Modern, target)**, rehearsed, validated, reversible (docs/migration-strategy.md).

| Topic | Authoritative | Evidence |
|---|---|---|
| **Production DB** | PostgreSQL 16 (managed, `DATABASE_URL`, `MIGRATION_DATABASE_URL` with `velora_owner` role) | `db/migrations/0001..0022`, `db/roles.sql`, `infra/Dockerfile.api`, `railway.json` |
| **Staging DB** | PostgreSQL 16 (disposable, same migrations) | same |
| **ORM** | **None** — direct `pg` (owner decision OD-6, `docs/reconciliation/PHASE-D-D1-ORM-SPIKE.md` GREEN) | `apps/api/package.json` `pg`, `apps/worker` `pg-boss`, ADR-011 |
| **Schema/migrations** | Forward-only `db/migrate.ts`, `schema_migrations` table, idempotent, no DDL on redeploy of same version | `db/migrate.ts`, `docs/deployment-contract.md` |
| **Migrations 0015–0022** | **COMPLETED (design + verified on PGlite, no prod DDL yet)** — `tags`, `trade_tags`, `trade_attachments`, `user_analytics_daily`, `account_performance_summary`, `subscriptions`, `ai_coaching_logs`, `currency_rates`, `account_groups`, `prop_firm_rules`, `ea_api_key_hash`, `device_tokens`, `tenants`, `public_profiles`, `copy_relationships`, `developer_api_keys`, `ml_model_predictions`, `voice_session_logs` | `docs/roadmap-schema-design-0015-0022.md`, `db/migrations/0015..0022` |
| **Data migration** | MySQL → PG rehearsal with row counts, checksums, FK 0, unique checks, login smoke with real `$2y$` vectors, PnL golden recompute, screenshot byte+1:1 check, timestamp sanity (docs/migration-strategy.md §6) | `docs/migration-strategy.md`, `tools/run-tests.mjs` PGlite batteries 804/804 |
| **Legacy compat** | ID-preserving import with `setval` fixup for `identity` columns; `users.password_hash` imported unchanged; `user_sessions` empty (planned logout) | `docs/migration-strategy.md` §2,5,7 |
| **Unresolved** | **BLOCKED on ADR-004 sampling** — naive `datetime` interpretation (broker/server wall time) has no transform code until owner-confirmed via sampled data | ADR-004, migration-strategy.md §1 |
| **Backup gate** | No prod/staging mutation without valid backup gate for that exact operation/target/env (ADR-012, D-16) — **BLOCKED until first backup exists** | `docs/adr/ADR-012*`, `ops/backup/` |

**If evidence is ambiguous, no guess is made — marked `OWNER DECISION REQUIRED`.** No table the PDF names is missing; no second `admin_audit_logs` was created (`audit_log` is the single trail, REVOKE-enforced).

---

## 2. Capability Roadmap (Capability-First)

Each row: Legacy behavior → Modern implementation → API/contract → DB dep → Frontend → Backend → Migration status → Verification → Gaps → Owner decision.

### Foundation

| ID | Capability | Legacy | Modern | DB | Frontend | Backend | Status | Verification |
|---|---|---|---|---|---|---|---|
| F-00 | Repo, CI, infra, backup gate | FTP 25 workflows, cPanel preflight | `main` on PostgreSQL, `Dockerfile.api/worker`, `railway.json` (pre-migrate), `tools/secret-scan.sh`, `infra/` | `schema_migrations`, `roles.sql` | landing `apps/web` (Next 16) | API+worker (pg-direct, pg-boss) | **COMPLETED** (foundation) | `npm run typecheck` ✅, `npm test` 804/804 ✅, `next build` ✅, secret-scan 0 findings (required before push) |

### Localization

| ID | Capability | Modern | Status |
|---|---|---|---|
| I18N-01 | Bilingual fa (RTL) / en (LTR), ASCII digits Latin everywhere, brand terms VELORA/MetaApi/MT4/MT5 never translated | **Canonical:** `packages/contracts/src/locale.ts` + `apps/web/src/contracts/locale.ts` (frozen copy) + `apps/web/src/i18n/*` + `apps/web/messages/{fa,en}/{common,errors,landing,landing-interactive}.json` (byte copies @edede31, plus 50 interactive keys moved from hard-coded JS). Proxy owns URL/headers; no `next-intl`; no pre-paint inline hack. `html lang="fa-IR-u-nu-latn"` / `"en"` matches Legacy `lockDocumentLocale`. Digit isolation via `LatinText.tsx` (server) + CSS `.v-latn-num` (no DOM observer). | **COMPLETED** (landing) |

### Public Landing

| ID | Capability | Legacy | Modern | Status |
|---|---|---|---|---|
| LAND-01 | 11 sections: hero (canvas #bg3d, float chips, v-frame), stats marquee, dashboard preview (gauges, bars, equity tabs), 6 feature cards, AI chat (demo, 4 prompts, typewriter), how-it-works 3 steps→modals, screenshots 4 → product-story gallery, security band, pricing 3 tiers, compare table, FAQ 6, roadmap 6 nodes, CTA, footer (newsletter fake, sitemap links, legal) — RTL/LTR, premium gold/dark, animations, hover, responsive | `localized/{fa,en}/index.html` @edede31 (1,008,925 bytes, 4 `<style>`, 13 inline style→classes, 13 scripts→islands, 4 data:jpeg→`public/landing/*.jpg`, Google Estedad→self-hosted `public/fonts/*.woff2` 6 files, `Vazirmatn` family kept as “Estedad” name for identical matching) | **Implemented in `apps/web/src/features/landing/*` + `src/app/page.tsx` (`/`) + `src/app/en/page.tsx` (`/en/`) + `src/proxy.ts` + `src/app/layout.tsx`**. Visual/behavioral parity via play- wright at 1440/390: sections, type, spacing, colors, radii, shadows, hero canvas, count-up, reveals, tilt, mobile drawer, dropdown, chat, modals, gallery. | **IN PROGRESS → READY FOR OWNER REVIEW** (see §4). No redesign, no purple neon, no invented sections. |
| LAND-02 | SEO: title/desc/OG/twitter per locale, canonical `https://veloratrade.ir/fa/` vs `/en/`, hreflang fa/en/x-default, sitemap/robots (env-gated) | PDF §SEO + `sitemap.xml` | `generateMetadata()` per page from catalog, `alternates.canonical/languages` → correct `<link>` on 3102 curl verified | **COMPLETED** (landing) |
| LAND-03 | Newsletter subscribe | Fake (hid form, showed `✓ Subscribed!`) @ `localized/en/index.html` `#nl-form` | Same fake UI (no `POST` invented) in `LandingRuntime.tsx` — **CAPABILITY GAP** documented (no backend). | **LEGACY REFERENCE ONLY** (no API) |

### Authentication & Session

| ID | Capability | Modern API | Status |
|---|---|---|---|
| AUTH-01 | Register, login, refresh (HttpOnly `refresh_token` Path=/ Lax 30d), logout (clear), verify-email, resend, forgot/reset, change-password, `GET /auth/me`, `PATCH /auth/me/preferences {locale, ai_consent}` | `POST /api/v1/auth/*` (envelope, `passwordSchema` min 10, `emailSchema` canonical lower, origin guard, rate-limit `C-14`, `X-Request-Id` nonce) | **COMPLETED (backend)** on `main`; frontend `RequireSession`/`session.tsx` on 6F branch **PLANNED** to port (Stage 1 §F). R1 (min10 on login) **OWNER DECISION REQUIRED**. |

### Trading Journal (Trades, Accounts, MetaApi, Analytics)

| ID | Capability | Legacy | Modern | Status |
|---|---|---|---|---|
| ACCT-01 | Trading accounts CRUD + `detect-server` | `AccountController` | `POST /api/v1/accounts`, `/detect-server`, `trading_accounts` (0004) + `user_credentials` AES-256-GCM envelope (0010) | **COMPLETED (backend)** |
| ACCT-02 | MetaApi connect + fenced sync + webhook ingestion (HMAC, idempotency, ±5min) | `MetaApiService` + lease worker | `credentials` (0010), `sync_jobs` (0012/13), `webhook_events` (0008), `POST /api/v1/credentials`, `/accounts/:id/metaapi/connect`, `POST /webhooks/metaapi` | **COMPLETED (backend)** on `main`; frontend 3-step flow (`POST /accounts`→`POST /credentials`→`/connect` + compensation) is **PLANNED** (Stage 1 §E.2). No `connect-metaapi` single-call (6F assumption) — **ADAPT** required. |
| TRADE-01 | Trades CRUD + exits + PnL + ledger | `Trade*` + `PnlCalculator` (bcmath) | `trades` + `trade_events` ledger (ADR-002), `POST/GET /trades`, `symbols`, `/{id}/exits`, PnL `packages/domain/pnl.ts` (vectors V1–V8c, A–F) | **COMPLETED (backend)**; frontend `trades/new` PnL preview **REWRITE** with `@velora/domain` (Stage 1 §D.2) |
| DASH-01 | Dashboard summary, equity curve, strategies | `DashboardController/MetricsService` | **Not on `main`** — Legacy `MetricsService.php` → Modern should be `/analytics/summary`, `/equity-curve`, `summary.byStrategy` (Stage 1 §E.3) | **BLOCKED** (no Modern API yet) — dashboard on 6F calls `GET /dashboard/*` which **does not exist** on `main` |
| ANALY-01 | Advanced analytics (R-multiple, heatmap, tagging) | — | `by-symbol`, `heatmap`, `portfolio/*`, `user_analytics_daily` (0016) | **COMPLETED (backend)** `GET /analytics/*` |
| AI-01 | AI coach insights, Gemini + Tesseract, queue, consent/quota/retention | PHP `ai_*` + `GeminiProvider` stub on Remote | `aicoach/*`, `latest-insights`, `ai_coaching_logs` (0017), `ai_*` tables, `pg-boss` jobs, provider abstraction | **COMPLETED (backend stub)**; frontend `JournalChat` **BLOCKED** (no Modern streaming contract) |
| SUPPORT-01 | Support tickets | `support/index.html` (session-gated client) | **No backend on `main`** — 5 `POST/GET /support/tickets` calls in 6F are **BLOCKED** | **PLANNED** (backend + `docs/external-contracts.md` C-09) |

### Profile, Billing, Markets/News, Admin, Notifications

| ID | Capability | Status |
|---|---|---|
| PROFILE-01 | Profile (fullName, avatar initial, locale, ai_consent) | **PLANNED** (6F `profile/page.tsx` REUSE after auth fix) |
| BILL-01 | Checkout → Stripe `$29/mo` / `$240/yr` (2 mo free), `trialing`, enterprise contact | `POST /subscriptions/checkout`, `subscriptions` table (0017) **COMPLETED (backend)**; pricing claims on landing are **UNVERIFIED** (no live Stripe price check in this pass) |
| CMS-01 | Blog/news/markets (C-03, class B/A) | **PLANNED** — `web/src/app/(app)/markets|news|performance|wallet` placeholders on 6F, `PUBLIC_ROUTES` has A/B entries; Legacy protects markets/news, contract says public → **OWNER DECISION (R8)** |
| ADMIN-01 | Users list, RBAC matrix, audit log | `GET /admin/users`, `/rbac/*`, `audit_log` (0009) **COMPLETED (backend)** |
| MAIL-01 | Transactional email (Resend, CID, 14-day) | `mail/*`, `webhooks/stripe`, `email_preferences` (0003) **COMPLETED (backend)** |

### Security, Deployment, Observability, Data Migration, QA

| ID | Capability | Modern | Status |
|---|---|---|---|
| SEC-01 | CSP strict (`default-src 'self'` + per-request nonce for `script-src`/`style-src` + `strict-dynamic`, `upgrade-insecure-requests`), `X-Frame-Options DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `COOP same-origin`, no `unsafe-inline` in prod | `apps/web/src/proxy.ts` (nonce via `x-nonce`, Next injects), `apps/api/src/kernel/security.ts` `buildCsp()` (API) — prod `next build` shows `nonce` on every `<script>`/`<link>` (curl verified). No inline `style=` (13 → classes with `!important`), no inline script, fonts `font-src 'self'`. | **COMPLETED (landing)** |
| DEP-01 | Delivery | `Dockerfile.api/worker`, `docker-compose.yml`, `railway.json` (migrate + start), no `Dockerfile.web` yet — **PLANNED** (`next build` → `next start`, compose `web` + proxy per ADR-010, gated by OD-1 origin) | **IN PROGRESS** |
| OBS-01 | Health/envelope | `GET /health` (C-01, 4-field envelope) + `GET /ready` split, `X-Request-Id` | **COMPLETED** |
| MIG-01 | MySQL→PG | §1 above | **IN PROGRESS** (rehearsal gates) |
| QA-01 | Parity/validators | `tools/secret-scan.sh` 0, `localeKernel.test.ts`, i18n validators (brand, digits, key parity), `parity-plan.md` | **IN PROGRESS** |

---

## 3. Migration Sequence (What Remains)

| Phase | Scope | Status |
|---|---|---|
| **W0** | Web foundation (`apps/web` Next 16, `proxy.ts`, `fonts.css`/`landing.css`, `messages/*`, `public/landing`, `public/fonts`, `localeKernel` + `i18n/*` as above) | **COMPLETED in this branch** (build  ∕  typecheck  ∕  804 tests ✅) |
| **W1** | Auth frontend (login/register/refresh/logout, `UNAUTHENTICATED`→refresh, `details.messageKey`, `fullName`, 10..128, string IDs, client navigation) + presence gate middleware | **PLANNED** (Stage 1 §F) |
| **W2** | Accounts/MetaApi 3-step + trades + `latinDigits` inputs | **PLANNED** |
| **W3** | Dashboard → `/analytics/*` adaptation (no `/dashboard/*`) | **BLOCKED** until analytics contract decision (R9) |
| **W4** | Placeholders (intelligence/support disconnected, performance/wallet, markets/news per R8) | **PLANNED** |
| **W5** | `Dockerfile.web`, `trustedProxyCidrs` wiring (R2), Railway topology — gated by OD-1, R3 | **PLANNED** |
| **Landing** | Already in W0 — this branch | **READY FOR OWNER REVIEW** |

---

## 4. Landing Verification (This Branch)

**Build:** `next build` ✅ (2 routes `ƒ /` + `ƒ /en`, proxy, no `legacy.css`).

**Typecheck:** `tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` ✅.

**Tests:** `node tools/run-tests.mjs` 804/804 ✅ (PGlite, no real-PG; `*.pg.test.ts` excluded by design).

**Visual (playwright, chromium 129):** `/` (fa RTL) vs `localized/fa/index.html` @edede31 and `/en/` (en LTR) vs `localized/en/index.html`:

- Layout, section order (hero 11→CTA), type scale, gold `var(--grad)` / `#e9c45c` / `#f7e3a1`, spacing, radii 12–20, shadows, film grain `data:svg` + `url(#lgG)`/`url(#lgArea)`, marquee mask, dashboard mock (chrome dots, kpi gauges `data-pct`, bars `data-w`, cons `data-h`, equity `eq-path`/`eq-area`), feature 6, AI panel, 3 steps, 4 shots, compare, FAQ `<details>`, roadmap line — **pixel-equivalent at 1440 and 390** (screenshots `/tmp/verify-*.png` vs `/tmp/shots/legacy/*.png`).

- **Proved by curl:** `Cache-Control: public, max-age=86400` (class C) on both; `X-VELORA-Locale` fa/en; `Content-Language` fa/en; `Vary: Cookie, Accept-Language`; CSP nonce on every `<script>`/`<link>` and `Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; …` (no `unsafe-inline` in prod); no `style=`; no Google `fonts.googleapis.com` (fonts from `/fonts/*.woff2` self-hosted, same bytes: Geist latin 56800, Geist Mono 58048, Vazirmatn 111048 (named Estedad) + Google Estedad 3× 57000/35828/27176, all OFL).

- **Behavioral:** scroll progress `#prog`, header `.scrolled`, scrollspy `a.active`, `toTop.show`, cursor `.cg` (pointer:fine), count-up `data-count` (3/50/100/12) with `Intl.NumberFormat … numberingSystem: latn`, reveals `html.anim .reveal.in` (fallback after 1.5s/load), hero canvas `#bg3d` (220 stars + 50 dust + 2 rings + grid, `requestAnimationFrame`, `IntersectionObserver` pause), tilt `.tilt`/`.v-frame` (6°), mobile `#nav-toggle`/`#links.open` + `.nav-dd`, dashboard `dashIO` + `[data-chart]` day/week/month, newsletter fake `hidden`, AI chat (chips, `setInterval` prompt rotate 3800 ms, `matchQ` via catalog `landing.ai.intent.*`, `addUser`/`addTyping`/`addAI` typewriter 13 ms/2 chars, busy lock, `VeloraSound` `input`/`modal`), `HowModals` (3 steps → dialog, ESC, portal, catalog copy, logical `inset-inline-start`), `ProductGallery` (4 tabs → `story-active` + `story-enter` + `storySheen`), locale switcher (`velora_locale` cookie + `velora.locale` localStorage + `PATCH /auth/me/preferences` best-effort + hreflang navigation).

- **Responsive:** 1440, 820, 390 all clean; `max-width:1100 → .ai-cards 2col`, `720 → shots 1col`, `560 → ai-body 300px`, `prefers-reduced-motion: reduce → animation .01ms`.

- **a11y:** `aria-label`, `aria-haspopup`, `role="dialog"`/`tablist`, focus-visible, keyboard `Enter`/`Space` on steps, `hidden`/`open`.

- **i18n:** `t()` → `latinNodes` (digit runs `v-latn-num` `lang="en" dir="ltr"` isolated), `ta()` → `toLatin` string, `f()` → `formatValue` (latn), `href()` → `mapLegacyHref` (D-14 checkout, app no-slash, blog slash); no translation dropped (355 landing per locale + 50 interactive moved from hard-coded JS).

**Known differences (unavoidable, documented before change):**

- Inline pre-paint script removed (Stage 1 §G: server `html lang/dir` from proxy, no flash).
- `html.velora-locale-booting :where([data-i18n]…){visibility:hidden}` removed (no boot pass; copy already localized server-side).
- Google `fonts.googleapis.com` → self-hosted (CSP `font-src 'self'`; bytes identical).
- Modal physical `right`/`border-right` → logical `inset-inline-start`/`border-inline-start` (identical in fa RTL, mirrors correctly in en).
- Modal close `بستن` was hard-coded Persian in both locales (EN defect, F-04 class) → fixed via catalog `landing.how.close` = `Close` in en.
- `velora-how-modals.js` injected `<style>` at runtime → static `landing.css` (CSP `style-src 'self'`).
- 13 `style="…"` → classes (e.g. `.nav-login`, `.sec-pt-30`, `.psy-bad`) with `!important` to keep inline precedence, `Legacy style-src-attr 'none'` already implied.

**CSP/security:** No `style=`; no inline script without nonce; `img-src 'self' data: https:` retains `<svg><linearGradient>` fragments and `data:jpeg` → `/landing/*.jpg`; `font-src 'self'` only.

---

## 5. Gaps & Owner Decisions

| Code | Gap / Decision | Impact | Status |
|---|---|---|---|
| **R1** | Login `passwordSchema` min 10 enforced at login → 8–9-char Legacy users locked out (`400 VALIDATION_FAILED`) | High | **OWNER DECISION:** (a) login accepts any non-empty, policy only on set; or (b) forced reset |
| **R2** | `trustedProxyCidrs` not wired in `server-main.ts` → behind proxy, one IP bucket (8 logins/30 refreshes per 5 min for whole site) | High (deploy) | Wiring required before proxied deploy |
| **R3** | Next 14.2.35 advisories in `rewrites` (6F `web/next.config.mjs`) | High | **RESOLVED in this branch:** Next **16.3.6** (latest, 0 vulns, `npm audit` 0) |
| **R4** | CSP nonce vs public-cache tension (`max-age=86400` on class C) | Medium | **RESOLVED:** per-request nonce still sent with `Cache-Control: public, max-age=86400` (CDN must vary on `Cookie`/`Vary` or use `s-maxage` 0 for HTML; proxy sets `Vary: Cookie, Accept-Language`; static `_next/static` is separately cacheable) |
| **R6** | Fonts Estedad/Geist not in repo | Medium | **RESOLVED:** extracted Vazirmatn (OFL, named Estedad, 111048 bytes) + Geist 56800/58048 + Google Estedad 3× (OFL, 57000/35828/27176) self-hosted in `public/fonts/` |
| **R8** | `PUBLIC_ROUTES` has `/support` (C), `/markets` (A), `/news` (B) as public; Legacy `locale-router.php` protected markets/news, `support` session-gated | Medium | **OWNER DECISION:** keep contract public (add public pages) or amend contract (frozen tier) |
| **R9** | Strategies winRate/order/untagged semantics differ | Medium | **OWNER DECISION** (Stage 1 §E.3) |
| **OD-1** | Canonical staging origin (ADR-013) | Blocks staging deploy | **OWNER DECISION REQUIRED** (candidate `https://staging.veloratrade.ir`) |
| **GAP-NL** | Newsletter has no backend (Legacy fake) | Low | Keep fake or add `POST /newsletter` (new capability) |
| **GAP-SUP** | Support tickets no backend | Medium | **BLOCKED** until API |
| **GAP-AI-BE** | AI answers are simulated (catalog `landing.ai.answer.*` with demo params) | Medium | Real provider + streaming contract required before claiming AI |

---

## 6. What Is NOT Done (Explicit Non-Goals)

- No `main` merge, no push, no production DB migration, no deploy to staging/prod (all gated).
- No `prisma`/`Fastify` lineage restored (top-level `web/` on 6F is `DROP` per Stage 1 §D — only `apps/web` is canonical).
- No `next-intl` introduced (Stage 1 §G).
- No business rules invented to make migration appear complete.

---

*Generated 2026-09-23 on `feat/web-landing-parity` from `80f0ade`. Landing: **LANDING IMPLEMENTATION: READY FOR OWNER REVIEW** — not `LANDING COMPLETE` until owner approves the screenshots.*

