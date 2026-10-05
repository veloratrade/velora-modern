# Phase 7 — AI capability map (Legacy `edede31` → Modern)

**Method.** Every claim below is a file/line read of the Legacy tree (read-only) or of the
Modern tree at `f4b727c`. Inventory command (reproducible):

```bash
cd veloratrade && grep -nE '\$router->(get|post|put|patch|delete|add)\(' api/index.php | grep -iE "ai|ocr|translat|copilot"
find api/src/AI -type f | wc -l          # 70 files
grep -rhoE "CREATE TABLE[^(]*ai_[a-z_]+" api/database/{schema.sql,migrations/*.sql} | sort -u   # 13 tables
```

Legacy AI is **70 files / ~7,300 lines**, **13 `ai_*` tables**, **3 user routes**, **14 admin AI
routes** (+3 relay-config, +1 effective-config, +1 analytics/ai) and **3 support AI routes**.

---

## 1. What Legacy's AI capability actually is

### 1.1 The user-facing capability (3 routes)

| Route | Limit | Flag | Contract (read from `AIController.php`) |
|---|---|---|---|
| `POST /api/v1/ai/analyze-trades` | 10/3600 | `ai_trade_analysis` | body `{trade_ids[] ≤100, locale?, timeframe?}`. A client-supplied `trades[]` is **explicitly rejected** (422 `errors.ai.validation.tradeIdsRequired`); ids are resolved server-side with ownership (`TradeResolver::resolveOwned`). Locale order: validated body locale → `users.locale` → `en`. Audit stores `sha256(trades)` — never content. Deadline +20 s. Output **whitelist** `summary, strengths, weaknesses, recommendations, risk_score, riskScore, confidence` (arrays flattened to string lists). Response `{analysis, provider, model, confidence, latency_ms}`; uncaught → 502 `AI_ANALYSIS_FAILED` |
| `POST /api/v1/ai/weekly-report` | 5/3600 | `ai_weekly_report` | `{trade_ids[] ≤200, period_start YYYY-MM-DD (required, regex-checked), period_end? (default +6 days), locale?}`. Deadline +25 s. Whitelist `summary, strengths, mistakes, weaknesses, risk_behavior, suggestions, recommendations, confidence`. Response adds `period_start/period_end/locale`. 502 `AI_REPORT_FAILED`. A monthly variant exists in the service |
| `POST /api/v1/ai/feedback` | 20/3600 | `ai_screenshot_extraction` | `{extraction_id, original{}, corrected{}}` → `ai_feedback` with derived `changed_fields`; 201 `{feedback_id, stored:true, messageKey:"ai.feedbackStored"}` |

`/intelligence` (frontend) asks preset questions + free text — the `assistant` feature.

### 1.2 Orchestration (`AIManager::generate`, 470 lines)

For a feature, resolve a **provider chain** and walk it:

1. `FeatureRouter::resolveChain(feature, capability)` — DB rows from `ai_feature_providers`
   (`feature, provider, model NULL=provider default, priority ASC, enabled, route
   direct|n8n_relay|NULL`), else the env-default chain from the registry. Source is reported
   (`db` | `env-default`) so the admin UI can show where a chain came from.
2. Per entry, in order: provider registered → capability satisfied → `isAvailable()` →
   **global deadline** → **consent** (external providers only; `tesseract` is exempt) →
   **atomic quota reservation** (`tryReserveQuota`, race-safe) → **image anonymization,
   FAIL-CLOSED** (blur the top 15 %; if anonymization cannot be guaranteed the original image
   must NOT reach an external provider — skip it and let the local OCR fallback run) → call with
   `route`/`model` overrides.
3. Every attempt is written to `ai_provider_logs` (`provider, status success|failed|
   quota_exhausted|timeout, latency_ms, error_code, feature, model, route, fallback_index`), the
   request to `ai_requests` (`user, feature, provider, model, prompt_hash, tokens_used, latency_ms,
   status, cost`), and the action to `ai_audit_logs` (hashes only).
4. Failure → next provider in the chain; exhaustion → the last typed exception.

### 1.3 Providers, routes and the relay

`ProviderCatalog`: features `screenshot_extraction | trade_analysis | weekly_report | assistant`;
capability filter `text` for the three text features, `null` for extraction (so OCR qualifies).

| Provider | Credential env key | Models (allowlist) | Default | Routes |
|---|---|---|---|---|
| `gemini` | `GEMINI_API_KEY` (+ relay `GEMINI_RELAY_URL`, `GEMINI_RELAY_TOKEN`) | gemini-3.6-flash/pro, 2.5-flash/pro, 2.0-flash | gemini-3.6-flash | `direct`, `n8n_relay`, NULL |
| `openai` | `OPENAI_API_KEY` | gpt-5, gpt-5-mini, gpt-4.1, gpt-4o, gpt-4o-mini | gpt-5-mini | `direct`, NULL |
| `claude` | `ANTHROPIC_API_KEY` | claude-sonnet-4-5, claude-opus-4-5, claude-sonnet-4-20250514, claude-3-7-sonnet-latest, claude-3-5-haiku-latest | claude-sonnet-4-5 | `direct`, NULL |
| `tesseract` | none (local binary) | none | — | NULL |

**Route resolution** (`AiRouteResolver`): admin global setting `ai_route_default`
(`ai_global_settings`) → env `GEMINI_ROUTE` → legacy flag `ai_gemini_relay_route` → `direct`.
Only allowlisted values are ever returned; admin save/clear is `aiRouteManage` (super_admin).

**n8n relay contract** (`N8nGeminiRelayTransport`, 204 lines — the reason it exists is recorded in
its header: staging cannot reach `generativelanguage.googleapis.com`, Google returns 403 for that
network, so an n8n Cloud workflow forwards the call):

```
POST {url}   headers: Content-Type: application/json, Accept: application/json,
                     X-Velora-Relay-Token: <token>
body: {request_id: "velora-"+16 hex, prompt, image_base64?, mime_type?}
200:  {success:true, request_id, provider, model, extraction:{…}, error:null,
       meta:{upstream_http_status, latency_ms}}
fail: {success:false, error:{code, http_status, message}}
```

`isConfigured()` = url non-empty **and** token non-empty **and** url starts with `https://`.
Timeouts: total `max(2,t)`, connect `min(10,max(2,t))`; redirects disabled; TLS verification on;
curl-28 → timeout; 401/403 → "relay rejected credentials"; 404 → "endpoint not found"; other
non-200 → HTTP error. `error.code` maps onto typed exceptions (`INVALID_INPUT`/`UPSTREAM_BAD_REQUEST`
→ validation, `UPSTREAM_AUTH` → provider auth, `MODEL_NOT_FOUND`, `QUOTA_EXHAUSTED`, `UNAVAILABLE`,
`NETWORK_TIMEOUT` → timeout, `MALFORMED`/`INVALID_JSON` → validation, default → provider error
carrying **only the normalized code**). The token lives in config and the request header — never in
a URL, log, exception message or API response.

**Tesseract** (492 lines): local OCR, capabilities `[ocr, text]`, cost tier 0, available only when
the binary is found and `proc_open` exists; bounds 8 MB image / 8 s process / 256 KB output; a
text-only request returns `status: failed, UNSUPPORTED_CAPABILITY` rather than pretending.

### 1.4 Governance substrate

* **Feature flags** `ai_feature_flags(feature_name, enabled, rollout_percentage)`; canonical flags
  `ai_screenshot_extraction | ai_trade_analysis | ai_weekly_report | ai_assistant`. No row → only
  extraction is enabled. Rollout is deterministic: `crc32(feature+":"+userId) % 100 < rollout`.
  On error: fail closed, except extraction. `requireEnabled` → 403 `AI_FEATURE_DISABLED`
  (`errors.ai.featureDisabled`).
* **Quotas** `ai_provider_quotas(provider, daily_used, quota_limit=1500 "Gemini free = 1500/day",
  reset_at)`; `hasQuota` fails **open** when no row exists and resets when `reset_at` is before
  today (UTC); `tryReserveQuota` is a single atomic statement (the file records that it replaced a
  check-then-increment race). Cost tiers 0=free, 1=cheap, 2=paid.
* **Credentials** `ai_provider_credentials(provider PK, status ∈ {VALID, INVALID_CREDENTIAL,
  EXPIRED, REVOKED, DISABLED, INSUFFICIENT_PERMISSION, QUOTA_EXCEEDED, RATE_LIMITED,
  PROVIDER_UNAVAILABLE, REGION_RESTRICTED, NETWORK_ERROR, UNKNOWN, UNVERIFIED}, verified (1 only
  when VALID), fingerprint = HMAC-SHA256 (never the secret), verified_at, last_checked_at,
  error_code (sanitized), latency_ms, version (incremented on replacement)`. The **secret itself**
  lives outside the DB in `SecureCredentialStore` (private `velora.env` / encrypted
  `config/velora-secrets.json`, 0600 verified after write, atomic with lock+backup, 4 KB value cap,
  values **never** returned over HTTP). A verification gate routes around providers whose
  credentials are confirmed invalid.
* **Anonymization** `ImageAnonymizer`: blur the top 15 % (where account numbers live), GD-based,
  temp files 0600, and **fail-closed** — `null` means "cannot guarantee", and callers must not send
  the original image externally.
* **Prompts** `PromptManager` + 4 versioned templates (`screenshot_extraction_v1/v2`,
  `trade_analysis_v1`, `weekly_report_v1`).
* **Jobs** `ai_jobs` + `AIJobService` (async AI work), **extraction** `ai_extractions`
  (`image_hash` dedup cache, `original_result`, `final_result`, `confidence`, `latency_ms`,
  `status success|fallback|failed`), **reports** `ai_reports`, **analysis** `ai_analysis`.

### 1.5 Admin + support AI routes

`GET /admin/ai/overview` · `POST /admin/ai/feature-providers` · `POST …/reorder` ·
`PATCH …/{id}` · `DELETE …/{id}` · `POST /admin/ai/credentials/{provider}` ·
`DELETE /admin/ai/credentials/{provider}` · `GET|PUT|DELETE /admin/ai/route`
(view `aiManage`, write `aiRouteManage`) · `GET /admin/ai-usage` (`aiManage`) ·
`GET /admin/config/effective` · `POST /admin/providers/{provider}/verify` ·
`POST /admin/providers/{provider}/test-connection` · `GET|PUT|DELETE
/admin/integrations/relay/config` (`integrations.view` / `integrations.manage`) ·
`GET /admin/analytics/ai` (`analytics.view`) · support: `POST
/admin/communications/tickets/{id}/translate`, `…/copilot`, `…/copilot/draft` (`communication.reply`).

---

## 2. What Modern already has (read, not assumed)

| Modern file | What it is |
|---|---|
| `apps/api/src/aicoach/aiProvider.ts` | the **port**: `AiProvider`, `UnconfiguredAiProvider` (fails closed with a typed error), payload bound 16 KB, insight bound 32 KB, `validateInsight`, `AiAttemptRecord`/`AiAttemptStore` + `PgAiAttemptStore` on `ai_coaching_logs` |
| `apps/api/src/aicoach/geminiProvider.ts` | a real Gemini **HTTP** implementation (injected transport, 20 s bound, JSON-only output, key never logged) — live round trip NOT VERIFIED (no credential in scope) |
| `apps/api/src/aicoach/mediaInterpreter.ts` | voice transcription + chart-image reading on the same port and the same ledger; `UnconfiguredMediaInterpreter` fails closed |
| `apps/api/src/aicoach/aiCoachService.ts` | governance in one place: consent → payload bound → provider → output validation → durable record (success, refusal **and** error all recorded) |
| `apps/api/src/aicoach/aiCoachRoutes.ts` | `GET /ai-coach/latest-insights`, `GET|POST /ai-coach/consent` — **no generation route** |
| `apps/api/src/journal/journalAnalysisService.ts` | builds bounded facts from the caller's own journal (never notes, never another user's rows) and calls the coach; used by the Telegram bot |
| `db/migrations/0017` + `0023` | `ai_coaching_logs` (provider CHECK `openai|gemini`, insight must be a JSON object, outcome `success|refused|error`, error_code shape) + the `feature` discriminator `coach|journal_extract|transcribe|vision_extract` |
| `apps/api/src/credentials/*` | `credentialCrypto` (AES-256-GCM envelope, 32-byte master key), `credentialService`, pg/memory stores — **user-scoped** (MetaAPI), PLT-14 `BACKEND_ONLY` |
| `apps/web/src/app/(app)/intelligence/page.tsx` | a 34-line `PLANNED / GAP` shell |

So Modern has **one honest seam and one ledger**, no routing, no flags, no quotas, no relay, no OCR,
no admin surface, no feedback, no reports and no user-facing generation route.

---

## 3. The Modern shape (capability parity, not structural copying)

| Legacy | Modern decision | Why |
|---|---|---|
| 4 attempt tables (`ai_requests`, `ai_provider_logs`, `ai_audit_logs`, `ai_extractions`) | **ONE ledger**: `ai_coaching_logs`, extended with `route`, `fallback_index`, `latency_ms`, `input_hash` and a wider `feature` vocabulary | 0023 already established the one-ledger rule ("ONE ledger keeps answering what did we spend, on what, and did it work"). Four tables would be a second journal for the same fact |
| `ai_analysis`, `ai_reports` | the ledger's `insight` + `window_from/window_to` + `feature='analysis'|'report'` | a stored report IS an attempt with a window; a second table would duplicate it |
| secrets in a private 0600 file (`SecureCredentialStore`) | **encrypted in PostgreSQL** with the existing `credentialCrypto` envelope, in a platform-scoped table | the mission forbids a second store and makes PostgreSQL authoritative; the crypto (AES-256-GCM, master key from env) already exists and is tested. The security property that matters — the value is never returned over HTTP, only a fingerprint and a status — is kept verbatim |
| `ai_feature_providers` | `ai_feature_routes` (same columns/semantics, Modern naming and constraints) | the chain is real configuration with an admin surface and a reader, not speculative infra |
| `ai_feature_flags` + `AIFeatureGuard` | `ai_feature_flags` + `aiFeatureGuard.ts` with the same deterministic rollout | a rollout gate is a capability (staged release), and its determinism is testable |
| `ai_provider_quotas` + `tryReserveQuota` | `ai_provider_quotas` + one atomic `UPDATE … WHERE daily_used < quota_limit` | the race Legacy fixed must stay fixed; a check-then-increment in Modern would reintroduce it |
| `ai_global_settings` | `ai_settings` (key/value + `updated_by`) | the admin-managed global route and relay pointer need a persisted home with an actor |
| `ImageAnonymizer` (GD blur) | an **anonymizer port** whose default reports "cannot guarantee" → external image egress is **refused**, local OCR still runs | Modern has no image library and adding one is a dependency decision, not a migration step. Legacy's own rule is fail-closed when GD is missing, so this reproduces the security property exactly instead of silently sending unredacted screenshots to a third party |
| `ai_jobs` (async queue) | **not migrated in phase 7** | Legacy's three user routes are synchronous with a deadline (20 s / 25 s); the async path belongs with the worker, which is phase 8. Recorded, not silently dropped |
| Claude/OpenAI providers | OpenAI stays in the ledger vocabulary (0017 admits it); **Claude is not added** | 0017's provider CHECK is a closed vocabulary; widening it for a provider Modern has no transport for would be a fabricated option. Recorded as a divergence with the reason |
| `aiManage` / `aiRouteManage` | declared in `packages/contracts/src/rbac.ts` with Legacy's own non-dotted names, granted `admin` / `super_admin` respectively | moves RBAC-map rows 23–24 to ENFORCED, per the map's own rule |

---

## 4. Phase 7 delivery order (dependency-ordered)

1. **0028_ai_capability.sql** — the configuration substrate + the ledger extension.
2. **The provider layer** — catalog, route resolver, n8n relay transport, Tesseract OCR, feature
   router, quota store, feature guard, anonymizer port, and `AiManager` (the chain walk).
3. **The user capability** — `POST /ai/analyze-trades`, `/ai/weekly-report`, `/ai/feedback`,
   `/ai/ask` (the assistant behind `/intelligence`), with ownership-resolved ids, locale
   resolution, output whitelists and the Legacy rate limits.
4. **The admin AI surface** — overview, feature-route CRUD + reorder, credential
   replace/delete/verify/test-connection, global route show/update/clear, relay config
   show/update/clear, usage drilldown, analytics/ai.
5. **Support AI** — ticket translate + copilot draft (the phase-5 deferral).
6. **Web** — `/intelligence` becomes real; the console gains an AI tab.
7. **Evidence** — unit + real-PG batteries, i18n/design guards, browser QA, docs, state, push.

## 5. What phase 7 will NOT claim

* **No live provider call is verified.** No Gemini/OpenAI key, no n8n relay URL and no `tesseract`
  binary are in scope. Every transport is exercised with an injected fake; the live round trip stays
  `NOT_VERIFIED` and is labelled that way in the UI, the docs and the state records.
* **No fabricated output.** With no credential the answer is a typed refusal recorded in the ledger
  (`PROVIDER_NOT_CONFIGURED`), never invented text. There is no heuristic local fallback for
  analysis, reports or the assistant — Legacy has none either.
* **AI output is never authoritative.** Nothing in this phase writes to `trades`, `trade_events` or
  any financial record; a model's answer is stored as an insight and shown as analysis.
