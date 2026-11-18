# Velora Frontend Parity Migration — Discovery & Migration Map

* **Phase label**: Phase 6F — Frontend Parity Migration (frontend-only)
* **Status**: `DISCOVERY_COMPLETE` → implementation in progress on a local branch
* **Legacy reference**: `veloratrade/veloratrade` @ `edede31`
* **Modern destination**: `veloratrade/velora-modern` @ `351ce16`
* **Authoritative UI architecture**: `veloratrade/docs/pdf/Roadmap.pdf` — "VELORA: COMPLETE MASTER ROADMAP (v0.1 – v3.0)", Target Architecture: **Next.js 14 (App Router)**, dark-mode layout, Jest unit tests for form state.

---

## 1. Discovery Findings (FACT)

### 1.1 Legacy frontend

| Item | Evidence |
| :--- | :--- |
| Delivery model | Static HTML per route (`<route>/index.html`), locale-baked copies under `localized/{fa,en}/…`, served by Apache/`router.php`. Orphan Next.js RSC payloads (`index.txt`) confirm the HTML was originally a Next.js App Router export. |
| Shared runtime | `public/assets/velora-locale-registry.js` → `velora-latin-digits.js` → `velora-locale-bootstrap.js` → `velora-localization.js` → `velora-data.js` → `velora-time.js` → `velora-dynamic-content.js`, plus `velora-sidebar-icons.js`, `velora-dialog.js`, `velora-ui-sound.js`. |
| Auth model | `VeloraData`: access token **memory-only**, refresh via HttpOnly cookie (`POST /api/v1/auth/refresh`, `credentials: same-origin`), automatic single retry on `UNAUTHORIZED/ACCESS_TOKEN_MISSING/INVALID_TOKEN/SESSION_REVOKED`, `requireSession('/login')` guard on protected pages, `pageshow` (bfcache) revalidation. |
| Localization | Registry: default `fa` (rtl, `fa-IR`), fallback `en` (ltr, `en-GB`), `numberingSystem: latn`. Resolution order: URL prefix → `data-route-locale` → cookie `velora_locale` → localStorage `velora.locale` → browser → default. Catalogs: feature chunks `public/locales/chunks/{fa,en}/<feature>.json` (18 features). Direction from `html[dir]` only; numeric/financial values forced `direction:ltr; unicode-bidi:isolate; tabular-nums`. Latin digits enforced everywhere. |
| Typography | Google Fonts `Estedad` (FA) + `Geist` (EN), fallback `'Segoe UI', Tahoma, Arial, sans-serif`. |
| Brand tokens | Gold palette `#d4af37 / #e8c45a / #fce38a / #b8862a`, bg `#060A14`, glass panels (`rgba` + `backdrop-filter`), gold-glow logo mark (inline SVG "V" with `lgA/lgD/lgC` gradients). |
| App shell | `.shell` → `aside#veloraSidebar.sidebar` (`.sb-logo`, `nav.sb-nav > a.sb-item×10` incl. `#adminLinkSide`, `.sb-user` with avatar/name/logout) + `#veloraSidebarOverlay` + `main.main` → `.velora-top-nav-bar` (`.sidebar-drawer-toggle`, right actions) → page content. Mobile ≤980px: sidebar becomes off-canvas drawer (`.drawer-open`), direction-aware. |
| Sidebar order | Dashboard, Markets, Trading Intelligence, Trades, Wallet, Performance, News, Profile, Support, Admin (admin-only, hidden via `data-velora-adminhide-target`). |
| Icons | Inline SVG (stroke `currentColor`), sidebar icons injected by `velora-sidebar-icons.js`; no icon font. |
| Loading/error/empty | `#loading.loading-screen` with `.ls-logo`; `.error-box` / `.ok-box` per form; `.velora-toast`; skeleton rows in tables; "coming soon" cards on placeholder pages. |

### 1.2 Modern destination

| Item | Evidence |
| :--- | :--- |
| Frontend present? | **No.** `git ls-files` contains zero `.html/.css/.tsx/.jsx` files, no `@fastify/static`, no view engine, no SPA. Roadmap `docs/migration/ROADMAP.md` covers backend phases 0–7 only; `parity-gates.md` marks UI gates `FUTURE_PHASE` "until Modern frontend/feature modules are built". |
| API base | Fastify, JSON envelope `{ status, data, error, timestamp }`; auth endpoints return `{ tokens: { accessToken, expiresIn, tokenType, user } }` and set HttpOnly `refresh_token` cookie (`Secure; SameSite=Lax`). |
| Existing endpoints | `/api/v1/auth/{register,verify-email,resend-verification,resend-verification-email,login,refresh,logout,forgot-password,reset-password,me,change-password,email-preferences,me/preferences}`, `/api/v1/trades{,/:id,/:id/exits,/exits/:exitId}`, `/api/v1/accounts{,/detect-server,/:id/timezone,/:id}`, `/api/v1/dashboard/{summary,equity-curve,strategies}`, `/health`. |
| Security posture | Helmet CSP (prod), `X-Frame-Options: DENY`, HSTS, `Cache-Control: no-store`, CORS `origin:false` in prod (same-origin expected), client must keep access token in memory (`SECURITY_REQUIREMENTS.md §30`). |
| CI guards | `structure:check` fails on new top-level dirs unless baseline is updated; `i18n:check` enforces key parity + Latin digits + brand terms in `locales/{en,fa}.json`. |
| Deploy contract | `FRONTEND_URL` guard expects frontend origin `staging-modern.veloratrade.ir` — frontend is treated as its own origin/service. |

### 1.3 Architecture decision (derived from Master Roadmap, not invented)

* Frontend lives in **`web/`** inside `velora-modern` as a **Next.js 14 App Router + TypeScript** application (per Master Roadmap). No UI framework redesign: legacy CSS is ported as-is into CSS Modules / global CSS; Tailwind is **not** introduced in this pass because the legacy pages do not use utility classes and adding it would force a visual rewrite (contradicts parity goal). This is recorded as *REQUIRES DECISION* below.
* API calls go to relative `/api/v1/*` and are proxied by Next `rewrites` to the Fastify service in development; production origin wiring is a deploy decision (out of scope).
* **No changes** to `src/`, `prisma/`, `railway.toml`, workflows, or security config.
* Repository root `package.json` is untouched; `web/` has its own `package.json`. Structure baseline is updated (`web` top-level) — documented, reversible.

---

## 2. Legacy → Modern Migration Map

Legend — **Risk**: L/M/H. **Backend-safe**: reproducible without backend changes (Y/N/Partial).

### 2.1 Shared foundation

| Legacy feature | Legacy location | Modern destination | Existing modern equivalent | Migration | Risk | Backend-safe |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Locale registry/bootstrap (fa default, rtl/ltr, resolution order) | `public/assets/velora-locale-registry.js`, `velora-locale-bootstrap.js` | `web/src/i18n/registry.ts`, `web/src/i18n/I18nProvider.tsx`, `web/src/app/layout.tsx` (sets `lang`/`dir` pre-paint via inline script) | `locales/{en,fa}.json` (API keys only) | Port | M | Y |
| Feature-chunk catalogs | `public/locales/chunks/{fa,en}/*.json` | `web/messages/{fa,en}/*.json` (only chunks used by migrated pages) | none | Copy (subset) | L | Y |
| Latin-digit enforcement | `velora-latin-digits.js/.css` | `web/src/i18n/latinDigits.ts` + global CSS `font-variant-numeric` | i18n:check rule | Port | L | Y |
| Data layer (memory token, refresh, retry, normalize) | `velora-data.js` | `web/src/lib/api/client.ts`, `web/src/lib/api/normalize.ts`, `web/src/lib/auth/session.tsx` | none | Port (TS) | M | Y |
| Session guard (`requireSession`, bfcache) | inline early script in each protected page | `web/src/components/auth/RequireSession.tsx` | none | Port | M | Y |
| Admin-only nav hiding | inline `data-velora-adminhide` script | `Sidebar` reads `user.role` | `role` in `PublicUserDto` | Port | L | Y |
| Brand tokens, fonts, glass, gold palette | inline `<style>` blocks (dashboard/login) | `web/src/styles/tokens.css`, `globals.css` | none | Port | L | Y |
| Logo mark SVG | inline in every page | `web/src/components/brand/LogoMark.tsx` | none | Port | L | Y |
| App shell (sidebar, overlay, top bar, drawer) | every app page | `web/src/components/shell/{AppShell,Sidebar,TopBar}.tsx` + `shell.module.css` | none | Port | M | Y |
| Sidebar icons | `velora-sidebar-icons.js/.css` | `web/src/components/shell/sidebarIcons.tsx` | none | Port | L | Y |
| Toast | `.velora-toast` + `velora-dialog.js` | `web/src/components/ui/Toast.tsx` | none | Port | L | Y |
| Loading screen | `#loading.loading-screen` | `web/src/components/ui/LoadingScreen.tsx` | none | Port | L | Y |
| Error/OK boxes, fields, buttons | per-page CSS | `web/src/components/ui/*` + `forms.css` | none | Port | L | Y |
| Locale switcher | `velora-localization.js` (mount inline/dock) | `web/src/components/i18n/LocaleSwitcher.tsx` | none | Port | L | Y (PATCH `me/preferences` exists) |
| UI sound | `velora-ui-sound.js` | deferred | none | Defer | L | Y |
| Favicons / PWA icons | root `favicon-*.png`, `icon-*.png`, `manifest.json`, `velora-logo.svg` | `web/public/` | none | Copy | L | Y |

### 2.2 Pages — in scope (backed by existing modern API)

| Legacy page | Legacy file | Modern route | APIs used | Migration | Risk | Backend-safe |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Login | `login/index.html` | `web/src/app/login/page.tsx` | `POST auth/login` | Port | M | Y |
| Register | `register/index.html` | `web/src/app/register/page.tsx` | `POST auth/register`, `resend-verification` | Port | M | Y |
| Forgot password | `forgot-password/index.html` | `web/src/app/forgot-password/page.tsx` | `POST auth/forgot-password` | Port | L | Y |
| Reset password | `reset-password/index.html` | `web/src/app/reset-password/page.tsx` | `POST auth/reset-password` | Port | L | Y |
| Verify email | `verify-email/index.html` | `web/src/app/verify-email/page.tsx` | `POST auth/verify-email` | Port | L | Y |
| Dashboard | `dashboard/index.html` | `web/src/app/(app)/dashboard/page.tsx` | `dashboard/summary`, `equity-curve`, `strategies`, `trades`, `accounts` | Port | H | Partial — `accounts/connect-metaapi` absent (modal falls back to `POST accounts`); AI-insights tab has no API → legacy empty state |
| Trades list | `trades/index.html` | `web/src/app/(app)/trades/page.tsx` | `GET trades` | Port | M | Y |
| New trade | `trades/new/index.html` | `web/src/app/(app)/trades/new/page.tsx` | `POST trades`, `GET accounts` | Port | H | Partial — `trades/symbols` absent → static symbol list from `symbol-icons.js`; PnL preview must **not** re-implement calculations beyond what the legacy page already computes client-side (display only) |
| Connect account | `accounts/connect/index.html` | `web/src/app/(app)/accounts/connect/page.tsx` | `GET/POST accounts`, `detect-server` | Port | M | Partial — `connect-metaapi` absent (gap) |
| Profile | `profile/index.html` | `web/src/app/(app)/profile/page.tsx` | `auth/me`, `change-password`, `me/preferences` | Port | M | Partial — devices list has no API → empty state |
| 404 | `404/index.html` | `web/src/app/not-found.tsx` | — | Port | L | Y |

### 2.3 Pages — placeholder parity (legacy is itself "coming soon" / static)

| Legacy page | Modern route | Notes |
| :--- | :--- | :--- |
| Markets, News, Performance, Wallet | `(app)/{markets,news,performance,wallet}` | Legacy pages are static cards with no API; port as-is. |
| Intelligence | `(app)/intelligence` | Legacy has locked/consent-gated UI; no AI API in modern → gap state. |
| Support | `(app)/support` | Requires `/api/v1/support/tickets` (absent) → **deferred**, documented gap. |
| Landing `/`, Privacy, Terms, Checkout, Blog | — | Marketing/static; **deferred** to a later pass (1 MB landing page; not application UX). |
| Admin, Admin v2 | — | ~30 absent endpoints (Phase 7) → **deferred**. |

---

## 3. Conflicts & Gaps (REQUIRES DECISION / GAP)

| # | Item | Type | Handling |
| :--- | :--- | :--- | :--- |
| G1 | `POST /api/v1/accounts/connect-metaapi`, `/:id/sync` | Backend gap (Phase 7) | UI ports the wizard; submit uses existing `POST /accounts`; progress bar shows legacy `PENDING_SYNC` state. |
| G2 | `GET /api/v1/trades/symbols` | Backend gap | Static symbol catalog from legacy `symbol-icons.js`. |
| G3 | Support tickets, Admin, AI insights, devices | Backend gap (Phase 7) | Not wired; legacy empty/locked states used. |
| G4 | Tailwind (Master Roadmap) vs. legacy hand-written CSS | Architecture | Not introduced in this pass to preserve pixel parity. **Owner decision** whether to adopt later. |
| G5 | Fonts via Google Fonts CDN | CSP / privacy | Legacy loads from `fonts.googleapis.com`. Modern prod CSP is Helmet default (`'self'`). Self-hosting fonts is the CSP-safe path but requires font files not present in either repo. **Owner decision**; interim: same CDN link as legacy, documented. |
| G6 | Locale in URL (`/en/…`, `/fa/…`) | Routing | Legacy supports optional prefix; modern pass uses cookie/localStorage/browser resolution (identical order minus prefix). Prefix routing deferred. |
| G7 | Structure baseline | CI | `web` added via `structure:check -- --update` (documented, reversible). |

---

## 4. Explicitly NOT changed

`src/**`, `prisma/**`, `tests/**` (backend), `railway.toml`, `.github/**`, `locales/**` (API catalogs), `scripts/**`, `package.json` (root), `ops/**`, security headers/CSP, authentication contracts.
