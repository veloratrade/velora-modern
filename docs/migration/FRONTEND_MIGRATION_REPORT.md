# Frontend Parity Migration — Phase 6F Report

Branch: `feature/phase-6f-frontend-parity` (11 commits on top of `main` @ 351ce16). Nothing pushed, merged or deployed.
Legend: **FACT** = verified by command/inspection in this session · **ASSUMPTION** = inferred, not verified · **REQUIRES DECISION** = owner call.

## A. Summary
- FACT: The legacy Velora app UI (auth flow, dashboard, trades, new trade, connect account, profile, markets, news, performance, wallet, intelligence, support) is re-implemented in `web/` as a Next.js 14 App Router + TypeScript app inside `velora-modern`. No Tailwind; legacy per-page CSS ported verbatim and scoped under `.pg-<route>`.
- FACT: Per the owner's direction, features were rebuilt from their *concept* using the modern architecture (hooks + components + React state), not transliterated from legacy DOM/script code, while keeping identical visual values (every legacy inline style was moved into a class with the same values).
- FACT: Zero changes outside `web/` and `docs/migration/` (`git diff --name-only main..HEAD`). Backend, Prisma, tests, Railway, auth, CSP untouched.
- FACT: `tsc --noEmit` clean, `eslint src` 0 errors (1 pre-existing `no-page-custom-font` warning), `next build` succeeds for all 17 routes, production server returns 200 for every route.

## B. Files changed
FACT: 193 files, +15,211 lines, all under `web/` plus `docs/migration/FRONTEND_MIGRATION_MAP.md`. 69 of these are copied legacy symbol/emotion icon assets (`web/public/assets/...`) actually referenced by the new-trade form.

Commits (FACT):
| Commit | Scope |
|---|---|
| 5918bce | foundation: Next.js config, i18n runtime, api client, shell (sidebar/topbar), CSS port, layouts, forgot/reset/verify pages, placeholders |
| 5488590 | shared hooks + UI components + showcase cards + auth frame |
| 2d036c5 | login, register |
| feacaef | dashboard widgets, broker-account connection flow |
| 8234962 | trades list, new-trade form, icon assets |
| 4d39436 | profile |
| b89c4bd | intelligence, markets, news, performance, wallet |
| 5280e92 | support centre, per-page locale chunk loading (`useLocaleFeatures`), PasswordField on login/register |
| 0c1203b | QA fix: API proxy trailing-slash 308 (lost POST bodies) + profile sidebar (legacy dead CSS block) |
| 9259ea7 | QA fix: re-render `t()` when page chunks load |
| (this) | docs: QA evidence + report |

## C. Mapping (legacy feature → modern module)
| Legacy concept | Modern implementation |
|---|---|
| `VeloraLocale` (t/format/setLocale, `velora.locale` + `velora_locale` cookie, latin digits) | `src/i18n/*`, `I18nProvider.tsx` (`useI18n`), `components/i18n/LocaleSwitcher` |
| `velora-api.js` (envelope, token refresh) | `lib/api/client.ts`, `lib/auth/session.tsx` |
| Sidebar / top bar / drawer ≤980px | `components/shell/{Sidebar,TopBar,AppShell}` |
| Auto-hiding error boxes (700/900/4000 ms), toasts (2500/3200 ms) | `useTimedMessage` + `InlineNotice` / `Toast` |
| Resend-verification 60 s countdown | `useCooldown` |
| Fetch-then-render lists | `useApiResource` |
| Profile AI-consent toggle (server-authoritative) | `useAiConsent` (loading/on/off/saving/unavailable) + `ToggleSwitch` |
| UI sound preference (`velora_ui_sounds`) | `useUiSound` (preference only) |
| Dashboard summary/equity/strategies/accounts | `useDashboardData`, `KpiStrip`, `EquityChart`, `RecentTrades`, `StrategyPerformance`, `AiInsightsReadiness`, `BrokerAccountsPanel` |
| Connect MetaTrader modal / detect server / sync | `useAccountActions`, `ConnectMetaTraderModal`, `accounts/connect/page.tsx` |
| Top-bar “new trade” button | `NewTradeLink` |
| PnL colour/sign formatting | `usePnlFormat` |
| Markets/news/performance/wallet card layouts | `components/showcase/StatCards` (`StatCards`, `ShowcasePanel`) |
| Intelligence Q&A transcript (`ask()`/`send()`) | `useJournalChat` + `JournalChat`, `InsightCards` |
| Support tickets (list/KPIs/new/thread/reply/reopen, `?ticket=` deep link) | `useSupportTickets` + `SupportDesk` |
| Legacy `<html data-i18n-features>` per-page chunks | `useLocaleFeatures()` / `ensureFeatures()` in `I18nProvider` |

## D. Visual parity
- FACT: legacy `<style>` blocks ported byte-for-byte (`tools/port-legacy-css.py`) and scoped; inline styles converted to classes with identical values (`dashboard/legacy.css`, `shell.css .sc-*`, `intelligence.css .ai-*`, `connectModal.css`).
- FACT: viewport `maximum-scale=1.0`, theme-color `#060A14`, fonts (Estedad+Geist on auth, Segoe UI/Tahoma/Arial in app), breakpoints 980/480 preserved.
- FACT: Headless-Chromium screenshots (Playwright) of every route at 1366px and 420px in **fa/RTL** and **en/LTR**, against a QA-only mock of the modern API envelope (`docs/migration/qa-tools/mock-api.mjs`, shapes copied from `src/modules/*/routes`). Evidence: `docs/migration/qa-screens/*.jpg`. Checked: RTL mirroring, ASCII digits, gold theme, sidebar/topbar, drawer at 420px, toggles, transcript, ticket list.
- FACT: Two visual defects found and fixed by this QA: (1) profile page rendered an empty sidebar — caused by a legacy `<style id="shared-sidebar-profile">` block that hides `.sb-*` in favour of `.shared-side-*` markup that no longer exists in legacy either (legacy bug; block dropped, documented in `profile/legacy.css`); (2) support page stayed Persian under EN until `t()` was re-created after chunk load.
- ASSUMPTION: pixel-exact parity vs. legacy. Legacy pages were not screenshotted side-by-side (legacy runtime needs its PHP host) — **not claimed**; values are CSS-identical by construction.

## E. Functional verification
- FACT: `npx tsc --noEmit` ✓; `npx eslint src` 0 errors; `npx next build` ✓ (17 static routes); `next start` smoke: `/` → 307 to `/dashboard/`, all 16 other routes 200.
- FACT: every i18n key used by the ported pages resolves in both `messages/en` and `messages/fa`.
- FACT: Functional smoke with mock API (browser): session refresh → dashboard KPIs/equity curve/recent trades/strategies/accounts render; trades list + detail; new-trade form; connect-account form + existing accounts; profile (user, AI consent ON, sound toggle); support KPIs/list/thread; locale switch fa↔en re-renders all pages. Console clean except the expected 404 for `/api/v1/trades/symbols` (gap G2).
- FACT: Bug found by smoke and fixed: `trailingSlash:true` made Next answer `POST /api/v1/auth/refresh` with a 308 to `/refresh/`, which drops the body/method → every API call 500'd. Fixed with `skipTrailingSlashRedirect:true` + `beforeFiles` rewrite (page URLs keep their trailing slash; verified `/dashboard` and `/dashboard/` both 200).
- FACT: repo test suite: 161/162 pass. The single failure is `tests/unit/structureValidator.test.ts` ("repository matches baseline") because `web/` is a new top-level directory — see I.
- NOT TESTED: authenticated flows against a live API (no backend/DB in sandbox); RTL/LTR rendering in a browser; responsive behaviour.

## F. Backend impact
FACT: none. No files under `src/`, `prisma/`, `tests/`, config, or Railway were modified.

## G. Security impact
FACT: no auth/CSP/cookie policy changes. Frontend calls the API via relative `/api/v1` (Next rewrite), keeps the HttpOnly refresh cookie model, and stores only the access token in memory as the modern API intends. ASSUMPTION: the existing API CORS/CSP allow same-origin `/api/v1` calls from the Next origin in production.

## H. Remaining gaps (from the migration map)
- G1/G3: `POST /accounts/connect-metaapi`, `POST /accounts/detect-server`, `GET /accounts/:id/sync-status` do not exist in the modern API; UI calls them as legacy did and surfaces the error.
- G2: `GET /trades/symbols` missing — symbol list is bundled statically from legacy `symbols.json`.
- G4: intelligence Q&A/insights have no endpoint; transcript answers are the legacy canned message.
- G5: markets/news/performance/wallet show the legacy illustrative figures (legacy had no data source either).
- G6: UI sound *playback* not ported (only the preference toggle).
- G7: no URL locale prefix (legacy had none either); locale via cookie/localStorage.
- G8: support module in the modern API is a scaffold (`src/modules/support/index.ts`); the UI calls the legacy contract (`/support/tickets…`) and shows the load-failed notice until it exists.
- Not ported: landing, privacy/terms, checkout, blog, admin.

## I. Requires owner decision
1. Structure baseline: run `npm run structure:check -- --update` to accept `web/` as a top-level directory (this also fixes the one failing unit test). Not done — it touches a governance file.
2. Whether `web/` should be deployed as a separate Railway service or served by the Fastify app (rewrite target for `/api/v1` is env-driven: `VELORA_API_ORIGIN`, default `http://127.0.0.1:8080`).
3. Whether to implement the missing endpoints (G1–G4) or hide the corresponding UI actions.
4. Push/merge/PR of the branch.

## J. Git state
FACT: branch `feature/phase-6f-frontend-parity`, working tree clean, 11 commits ahead of `main` (351ce16) — see `git log --oneline main..HEAD`. Not pushed. Not merged. Not deployed.
