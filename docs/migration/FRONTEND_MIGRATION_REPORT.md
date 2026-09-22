# Frontend Parity Migration — Phase 6F Report

Branch: `feature/phase-6f-frontend-parity` (7 commits on top of `main` @ 351ce16). Nothing pushed, merged or deployed.
Legend: **FACT** = verified by command/inspection in this session · **ASSUMPTION** = inferred, not verified · **REQUIRES DECISION** = owner call.

## A. Summary
- FACT: The legacy Velora app UI (auth flow, dashboard, trades, new trade, connect account, profile, markets, news, performance, wallet, intelligence) is re-implemented in `web/` as a Next.js 14 App Router + TypeScript app inside `velora-modern`. No Tailwind; legacy per-page CSS ported verbatim and scoped under `.pg-<route>`.
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

## D. Visual parity
- FACT: legacy `<style>` blocks ported byte-for-byte (`tools/port-legacy-css.py`) and scoped; inline styles converted to classes with identical values (`dashboard/legacy.css`, `shell.css .sc-*`, `intelligence.css .ai-*`, `connectModal.css`).
- FACT: viewport `maximum-scale=1.0`, theme-color `#060A14`, fonts (Estedad+Geist on auth, Segoe UI/Tahoma/Arial in app), breakpoints 980/480 preserved.
- ASSUMPTION: pixel parity. No screenshot diff was run (no browser in sandbox) — **not claimed**.

## E. Functional verification
- FACT: `npx tsc --noEmit` ✓; `npx eslint src` 0 errors; `npx next build` ✓ (17 static routes); `next start` smoke: `/` → 307 to `/dashboard/`, all 16 other routes 200.
- FACT: every i18n key used by the ported pages resolves in both `messages/en` and `messages/fa`.
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
- Not ported: landing, privacy/terms, checkout, blog, admin, support.

## I. Requires owner decision
1. Structure baseline: run `npm run structure:check -- --update` to accept `web/` as a top-level directory (this also fixes the one failing unit test). Not done — it touches a governance file.
2. Whether `web/` should be deployed as a separate Railway service or served by the Fastify app (rewrite target for `/api/v1` is env-driven: `VELORA_API_ORIGIN`, default `http://127.0.0.1:8080`).
3. Whether to implement the missing endpoints (G1–G4) or hide the corresponding UI actions.
4. Push/merge/PR of the branch.

## J. Git state
FACT: branch `feature/phase-6f-frontend-parity`, HEAD b89c4bd, working tree clean, 7 commits ahead of `main` (351ce16). Not pushed. Not merged. Not deployed.
