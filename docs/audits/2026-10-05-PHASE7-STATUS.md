# Phase 7 — AI · status report (in progress, 2026-10-05)

Companion to `docs/audits/2026-10-05-PHASE7-AI-CAPABILITY-MAP.md` (the audit and the
mapping decisions). This file records **what is delivered and verified**, and — with the
same precision — **what is not yet**.

## 1. Delivered in this slice

| Layer | Files | What it does |
|---|---|---|
| Substrate | `db/migrations/0028_ai_capability.sql` | 7 new tables (`ai_feature_routes`, `ai_feature_flags`, `ai_provider_quotas`, `ai_provider_credentials`, `ai_platform_secrets`, `ai_settings`, `ai_feedback`) + the ledger extension (`route`, `fallback_index`, `latency_ms`, `input_hash`, widened provider and feature vocabularies). Closed vocabularies in CHECKs, `verified` derived from `status`, a feedback row that changes nothing refused, nonce uniqueness, secret keys from a fixed list |
| Configuration | `ai/aiConfigStore.ts`, `ai/memoryAiConfigStore.ts`, `ai/aiLedger.ts` | One store interface, a Pg adapter over the same pool and a contract-identical double; the quota reservation is ONE atomic statement; the ledger reader serves both the user's own rows and the admin drilldown |
| Secrets | `ai/aiSecrets.ts` | Admin-managed secrets encrypted with the EXISTING `credentialCrypto` envelope, resolution order admin → env, HMAC fingerprint, and no read path that returns a value |
| Routing | `ai/aiCatalog.ts`, `ai/aiRouteResolver.ts`, `ai/aiFeatureRouter.ts` | Legacy's catalog as data (features, providers, models, routes, capabilities, cost tiers), the route precedence admin → env → default, and chain resolution that reports WHY an entry was skipped |
| Transports | `ai/n8nRelayTransport.ts`, `ai/tesseractProvider.ts`, `ai/aiExecutors.ts` | The n8n Gemini relay exactly as Legacy's contract specifies (https-only, token in the header only, normalized error mapping); the local OCR fallback against the real binary; one executor port with a Gemini, a Tesseract and an honest "no transport" implementation |
| Governance | `ai/aiFeatureGuard.ts`, `ai/imageAnonymizer.ts`, `ai/aiManager.ts` | Deterministic rollout (crc32, Legacy's rule and default posture), the fail-closed anonymization gate, and the chain walk: flag → chain → deadline → consent → quota → anonymization → call → validate → record |
| Capability | `ai/aiAnalysisService.ts`, `ai/aiRoutes.ts` | `POST /ai/analyze-trades`, `/ai/weekly-report`, `/ai/feedback`, `GET /ai/attempts`, `GET /ai/status` — ownership-resolved ids, Legacy's prompt templates verbatim, Legacy's output whitelists, Legacy's rate limits (10/5/20 per hour), locale resolution per Legacy's G8 rule |
| Admin surface | `ai/aiAdminService.ts`, `ai/aiAdminRoutes.ts` | 21 routes: overview, chain CRUD + reorder, flags, quotas, route show/save/clear, relay show/save/clear, credentials replace/delete, verify + test-connection, usage drilldown — `aiManage` reads, `aiRouteManage` writes |
| Support AI | `ai/aiSupportPrompts.ts`, `support/supportAiRoutes.ts` | The phase-5 deferral: translate, copilot and copilot/draft, gated by the support module's own `support.tickets.manage`, degrading to `available:false` + a reason instead of breaking the console, and never sending a draft |
| Contracts | `packages/contracts/src/rbac.ts`, `src/auth.ts` | `aiManage` + `aiRouteManage` declared with Legacy's non-dotted names and granted as Legacy grants them; the three AI rate-limit buckets with Legacy's numbers |
| Wiring | `apps/api/src/server-main.ts`, `kernel/server.ts`, `routes/extendedRoutes.ts` | The whole layer composed once, in the PostgreSQL branch, with secrets resolved per call so an admin-saved key takes effect without a redeploy |

## 2. Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (5 projects) |
| `apps/api/src/ai/aiCapability.test.ts` | **23/23** — the chain walk, the rollout gate, the relay contract, the REAL tesseract OCR, the output rules |
| `apps/api/src/ai/aiRoutes.test.ts` | **19/19** — through the real kernel: trust boundary, authorization, refusals, whitelists, no secret in any response |
| `db/tests/aiCapability.pg.test.ts` | **12/12** on real PostgreSQL 17.11 — closed vocabularies, atomic quota under 20 racers, window rollover, bytea envelope round trip + nonce reuse refused, derived `verified`, ledger columns, feedback constraint, usage totals |
| `rbacCapabilityMap.test.ts` | 5/5 (the two new permissions are declared, granted and orphan-free) |
| Full suite / batteries / secret scan | recorded in `docs/state/CHANGE_LOG.md` AC-18 with the exact numbers |

## 3. What is NOT delivered yet (named, not hidden)

| Item | Status | Why / next step |
|---|---|---|
| The web surfaces | **NOT STARTED** | `/intelligence` is still the 34-line shell and the admin console has no AI tab. The API capability is complete and tested; the UI is the next slice, with its own i18n chunks and a browser QA run |
| Live provider calls | **NOT VERIFIED** | No Gemini key, no OpenAI key and no n8n relay URL/token are in scope. Every transport is exercised with an injected fake; the relay contract and the OCR path are the only parts proved against something real (tesseract 5.5.0 is installed here and reads a real image in the tests) |
| Image anonymization | **FAILS CLOSED, no implementation** | Blurring needs an image library and this repository has none. The gate reproduces Legacy's own rule when GD is missing: the image does not go to an external provider, and local OCR still reads it. Adding a library is a dependency decision, recorded as `MG-AI-ANONYMIZE` |
| Claude | **NOT MIGRATED** | Legacy ships a Claude provider; Modern's ledger vocabulary admits openai/gemini/tesseract and there is no Anthropic transport. Declaring it would put a fabricated option in an operator's dropdown |
| `ai_jobs` (async AI work) | **NOT MIGRATED** | Legacy's three user routes are synchronous with a deadline; the async queue belongs with the worker, which is phase 8 |
| Support translate/copilot UI | **NOT STARTED** | The API exists and is wired; the console buttons arrive with the web slice |
| `/admin/config/effective`, `/admin/analytics/ai` | **NOT MIGRATED** | The first is a Legacy diagnostics aggregate whose Modern equivalent is the phase-6 health panel plus this overview; the second is one of the three analytics blocks phase 6 assigned to phase 9 |

## 4. Divergences from Legacy, recorded

1. **One ledger, not four.** Legacy writes `ai_requests`, `ai_provider_logs`, `ai_audit_logs` and
   `ai_extractions` for a single attempt. Modern extends the ledger it already had (0017/0023) with
   `route`, `fallback_index`, `latency_ms` and `input_hash`.
2. **Secrets in PostgreSQL, encrypted**, not in a private 0600 file — the mission's "no second store"
   rule, using the crypto that already exists. The property that matters is kept: a value is never
   returned over HTTP, only a fingerprint and a status.
3. **Prose is refused, not wrapped.** Legacy turns an unparseable model answer into
   `{summary: <prose>}`; Modern records `INVALID_PROVIDER_OUTPUT` and moves on. Storing unvalidated
   model text as a structured insight is how a hallucination acquires a database row.
4. **The weekly report's capability requirement is `text`, not `reports`.** Legacy's
   `WeeklyReportService` asks for the capability `reports`, which NO Legacy provider declares, so its
   chain resolves empty and the route can only fail. That is a Legacy defect; Modern derives the
   requirement from the feature in one place (`FEATURE_CAPABILITY`) so a per-call string cannot
   contradict it.
5. **The relay configuration lives at `/admin/ai/relay`**, not `/admin/integrations/relay/config`,
   and is gated by `aiRouteManage` rather than `integrations.manage` (a permission Modern does not
   declare until phase 8).
6. **A symbol is only read from OCR when the image labels it.** Legacy's heuristic takes the first
   uppercase token, which on a broker screenshot returns the broker's name as the instrument. A null
   is honest; a guess becomes a trade.

## 5. Status vocabulary (mission §23)

The AI substrate, the provider layer, the user capability, the admin surface and the support assists:
**IMPLEMENTED** and **TESTED** (unit, real-PostgreSQL, HTTP-through-the-real-kernel). **Not**
`VERIFIED` as capabilities, because verification for this phase requires a live provider round trip
that no credential in scope permits, and the user-facing web surface does not exist yet.
Nothing here is `DEPLOYED` or `LIVE VERIFIED`. No existing user capability was removed.
