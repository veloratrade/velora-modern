# Final Residue Sweep — 2026-10-10 (Asia/Tehran)

**System:** Agent Context System (ADR-017) · **Scope:** evidence-backed sweep Legacy `veloratrade/veloratrade@edede313` → Modern `veloratrade/velora-modern` on verified `main`.
**Baseline before sweep:** `77f0e17603274796073c7a16732b10cf6cac8f25` (state: ADR-019 verified, b1f90a7 in `current-state.json`)
**Baseline after sweep:** this commit (see `current-state.json` `modern_sha`/`modern_head`)
**Principle:** preserve valid `main` work, migrate behavioral semantics not filenames, retire obsolete/hosting material explicitly, Telegram code-ready not falsely live.

---

## 1. Git state (verified, not claimed)

- Branch: `main` (dirty worktree below, no force-push, no destructive reset).
- Remote `main` (pre-commit, verified): `77f0e17603274796073c7a16732b10cf6cac8f25` via `git ls-remote https://github.com/veloratrade/velora-modern.git refs/heads/main`.
- Local `HEAD` before commit: `77f0e17` (fast-forward from `b1f90a7` state record; no divergence).
- Dirty worktree (this sweep, `git status --porcelain=v1`):
  ```
  M  apps/api/src/ai/* (tesseractProvider, aiManager, aiRoutes, aiCapability, screenshotExtraction, aiManagerMediaInterpreter …)
  M  apps/api/src/telegram/* (memoryTelegramStore, pgTelegramStore, telegramStore, telegramBot, telegramRoutes, telegramProcessorFactory …)
  M  apps/api/src/journal/journalApplicationService.test.ts (+ transcript lifecycle)
  M  apps/worker/src/handlers/telegramUpdateHandler.ts + .test.ts (at-most-once retry)
  M  apps/web/src/features/trades/screenshotTime.ts + .test.ts (toLocalInputTime retained)
  M  apps/web/src/app/(app)/trades/page.tsx (timezone-aware prefill, seconds)
  M  apps/web/messages/{en,fa}/trades.json + intelligence.json (timezone notes, latin digits)
  M  apps/web/src/i18n/contentSurfaces.test.ts (trades page-key entry)
  M  db/migrations/0034_telegram_draft_transcript_retention.sql + 0035_telegram_update_processing_guard.sql
  M  db/tests/* (telegramJournal, telegramStoreAdapter, telegramConcurrency)
  M  docs/state/* + docs/adr/* + docs/telegram/* (index, ADR-019, SECURITY, DEPLOYMENT)
  ??  apps/api/src/ai/screenshotExtraction.* + tesseractProvider.test.ts + aiManagerMediaInterpreter.* + envAiSecretResolver.* + apps/web/src/features/trades/screenshotTime.*
  ```
  All installations (`npm ci` 67 packages, 0 vulns) were ephemeral test dependencies; no new runtime package was added to `package.json` and no `infra/Dockerfile.api` was modified. `node_modules/` is not committed (snapshot-excluded).

- After commit verification (required): `git status` must be clean, `git log --oneline -3` shows this sweep, `git ls-remote` re-checked post-push (push is owner-gated; report records local verification).

---

## 2. Migration dispositions — every residue in five classes

Disposition vocabulary (exact): `IMPLEMENTED` | `MODERN_EQUIVALENT` | `INTENTIONALLY_RETIRED` | `OWNER_DECISION_REQUIRED` | `DEPLOYMENT_GATED`

### 2.1 Residues closed or made code-ready in this sweep

| Residue (Legacy → Modern) | Disposition | Evidence |
|---|---|---|
| **Telegram draft transcript lifecycle** — transient voice transcript must not become journal content; terminal drafts (CONFIRMED/CANCELLED/EXPIRED) must not retain it | **IMPLEMENTED** | `isTerminalTelegramDraftState` in `telegramStore.ts`; both adapters clear `transcript` on terminal transition and sanitize terminal rows/views; migration `0034` backfills `NULL` + adds `CHECK (state NOT IN (…) OR transcript IS NULL)`; `journalApplicationService.test.ts` + `telegramJournal.test.ts` verify active-retains / terminal-clears / failed-correction-retains. |
| **Processing-start guard** — a claimed `telegram_updates` row must start side effects at most once; crash-after-start must be visible, replay must be no-op | **IMPLEMENTED** | Port `TelegramStore.beginUpdateProcessing` + `finishUpdate` guards; `pgTelegramStore` does `UPDATE … WHERE processed_at IS NULL AND processing_started_at IS NULL RETURNING` and `finishUpdate` requires `processing_started_at IS NOT NULL AND processed_at IS NULL`; `memoryTelegramStore` mirrors same state machine; `TelegramBot.processClaimed` acquires durable marker before any `sendMessage`/journal write; `telegramUpdateHandler` treats `failed` as terminal (no queue retry) because replay would duplicate external effects; migrations `0035` adds `processing_started_at`, backfills, adds `CHECK (processed_at IS NULL OR processing_started_at IS NOT NULL)` + partial index for `started_unprocessed`; tests in `telegramBot.test.ts`, `telegramStoreAdapter.test.ts`, `telegramJournal.test.ts:0035`, `telegramConcurrency.pg.test.ts:START RACE`. |
| **Screenshot request-body cap end-to-end** — bounded encoded payload must be accepted, JSON default must not reject legitimate screenshots | **IMPLEMENTED** | `screenshotExtraction.ts: MAX_SCREENSHOT_REQUEST_BYTES = 24 MiB` (4×8 MiB raw + base64/data-URL overhead); `aiRoutes.ts` reads `SCREENSHOT_EXTRACT` with `ctx.readBody(req, MAX_SCREENSHOT_REQUEST_BYTES)` while every other JSON route uses `DEFAULT_JSON_BODY_BYTES = 1 MiB`; `kernel/server.ts:parseJsonBody` enforces per-call `maxBytes` with 413 `PAYLOAD_TOO_LARGE`; `aiRoutes.test.ts` valid screenshot test sends `images:[png,png]` + `padding:1_100_000` (≈1.3 MiB JSON) and asserts 200 + `provider:tesseract` — proves the route-specific cap is applied. |
| **`toLocalInputTime` helper** | **IMPLEMENTED** | `screenshotTime.ts` retains both `screenshotTimePrefill` + `toLocalInputTime` wrapper; `screenshotTime.test.ts` asserts `toLocalInputTime(value,"","Europe/Paris") === prefill.inputValue` plus offset/hint, DST, unzoned, invalid-calendar cases; `trades/page.tsx` imports both. |
| **AI ledger privacy — transcript char count only** | **IMPLEMENTED** | `aiManager.ts:transcriptionLedgerInsight` persists `{chars: text.length}` only, never transcript content; `aiCapability.test.ts: "a managed transcription attempt records only character count"` asserts ledger insight equals `{chars: …}` and rendered text is transient. |
| **Voice-draft transient copy discipline** | **IMPLEMENTED** | Transcript held only in actionable draft for review; `currentDraft`/`active` views hide it when terminal; confirmation/cancel/expiry clear it (above). Only confirmed trade fields become journal content via `TradeService`. |
| **Consent gating — external egress vs local OCR** | **IMPLEMENTED** | `aiManager.ts` checks `external = !PROVIDERS[entry.provider].local` before `consentState`; non-screenshot chain stops on `CONSENT_REQUIRED`; `screenshot_extraction` continues to next entry if local (`tesseract`) is configured. Tests: `aiCapability.test.ts` "a text feature does not use local OCR as consent fallback" (0 calls) and "missing consent … permits only the configured local screenshot fallback" (`gemini:refused` then `tesseract:success`). |
| **Real-Tesseract unconditional test + stale comment fix** | **IMPLEMENTED** | `tesseractProvider.ts` comment corrected: "The real-binary test in `aiCapability.test.ts` is unconditional, so it will fail here rather than being skipped" (not a skip); `aiCapability.test.ts: OCR: the real tesseract binary reads a real screenshot` runs without `skip`, asserts `isAvailable()===true` and reads fixture `ocr-trade-screenshot.png`. Failure is honest (no binary) and reported as 1/1395 in the full suite, not hidden. |
| **Trades page timezone UX** | **IMPLEMENTED** | `trades/page.tsx` fetches profile timezone, shows `timezoneNote` states (loading / unavailable `role=alert` / success `{{zone}}`), converts screenshot timestamp via `screenshotTimePrefill` with `profileTimeZone` + `sourceTimezone` hint, preserves `apiValue` until edit, `datetime-local` has `step={1}` for seconds, `toApiDateTime` retains exact instant. Translations added to `messages/{en,fa}/trades.json` (`timezoneNoteLoading/Unavailable/Success`). `contentSurfaces.test.ts` adds trades page to `PAGE_UNDER_TEST`. |
| **Timezone helper edge cases** | **IMPLEMENTED** | `screenshotTime.ts` handles explicit ISO offset, numeric offset hint (−720..840), unzoned wall time, invalid calendar (does not overwrite form), DST ambiguous 02:30, seconds preservation, profile-zone fallback to UTC, `isValidTimeZone` guard. |

### 2.2 Previously closed residues (not re-implemented, still verified)

| Residue | Disposition | Why not code now |
|---|---|---|
| Financial `r_multiple` scale, `RangeGuard`, `JalaliCalendar`, `TradingSessionEngine`, achievements domain engine | **IMPLEMENTED** (domain) | Verified at `d5710fe`/AC-24..26, `packages/domain/src/*.test.ts` 17+19+11/11; money parity in load rehearsal. No change in this sweep — preserved. |
| Auth Argon2id, login-history, rate-limit 15 dispatcher routes, cookie `__Host-velora_refresh`, HSTS, CSP nonce, edge authz | **IMPLEMENTED** | Phases 1,4,6; `rateLimitRoutes.test.ts` 17/17, `proxy` tests 7/7. |
| RBAC vocabulary (24 perms, 20 enforced) | **MODERN_EQUIVALENT** | `packages/contracts/src/rbac.ts` + `docs/security/RBAC-CAPABILITY-MAP.md` + `rbacCapabilityMap.test.ts` 5/5; remaining 4 have no substrate (fabricating a permission would be false security). |
| PHP/tree/localized bulk copies, MySQL-specific code, cPanel/FTP/.htaccess machinery, GD pre-processing (crop/upscale/grayscale/negate/contrast), `fas` language pack | **INTENTIONALLY_RETIRED** | Documented in `phase-7 map §3` and `tesseractProvider.ts` header: Modern has no image library; OCR goes `as-is`, confidence fixed at 0.4, user-confirmed draft compensates. Host-framework material has no Modern-native equivalent. |
| Blog demo intelligence keys (`simulatedAnswer`, 72% win rate, 15M order block) | **INTENTIONALLY_RETIRED** | `intelligence/page.tsx` now renders only real weekly-report; `contentSurfaces.test.ts` "fabricated answer/metrics are intentionally retired" asserts keys absent from page and both catalogs. |
| Password policy at login (8–9-char legacy users), `trustedProxyCidrs` values, `subscription.status` vocabulary (`grace`/`expired`), `RPO/RTO`, `ADR-004` naive-datetime sampling, image anonymizer dependency, `Jalali` algorithm window drift, strategy `winRate/order` semantics, CSP release pinning model, second-process secret allowlist for Telegram | **OWNER_DECISION_REQUIRED** | All in `docs/state/current-state.json` `summary.open_owner_decisions` / `MIGRATION_GAP_REGISTER` `OWNER_DECISION_REQUIRED`; no code guesses them away. |
| Telegram live webhook + bot token delivery, Gemini/provider live calls, n8n relay live round trip, MetaAPI per-fill→position assembly live tick, Tesseract binary presence, offsite backup upload + production restore drill, edge HSTS deployed confirmation, `pgRoles` superuser `ALTER DEFAULT PRIVILEGES` on hosted PG | **DEPLOYMENT_GATED** | Code path `RECORDED_RUNTIME` at `e041856`/`b1f90a7`; execution `NOT_VERIFIED` until a real environment with credentials/host exists. No infrastructure was created in this sweep (railway.json, Dockerfiles untouched). |

### 2.3 Migration files (forward-only, ADR-010)

| Migration | Subject | Verified |
|---|---|---|
| 0001–0022 | Base schema → legacy contract parity (trades, users, trading_accounts, webhook_events, …) | `npm run test:migrations` 19/19 + `db/tests/migrations.test.ts` |
| 0023 | Telegram journal (6 tables + widened audit vocabularies) | `telegramJournal.test.ts:0023` |
| 0024 | Auth events | `pgAuthEvents 4/4` |
| 0025–0033 | Financial guards, support, admin console, AI capability, MetaAPI position assembly, email, admin platform, analytics | `0029` assembly 8/8 + `0033` health closed vocab |
| **0034** | **Telegram draft transcript retention** (`telegram_journal_drafts.terminal_transcript_cleared`) | **This sweep** — `telegramJournal.test.ts:0034` backfill + constraint |
| **0035** | **Telegram update processing guard** (`telegram_updates.processing_started_at` + lifecycle CHECK + started_unprocessed index) | **This sweep** — `telegramJournal.test.ts:0035` + `telegramStoreAdapter` + `telegramConcurrency.pg` START RACE |

All 35 migrations apply from scratch on PGlite (`npm run test:migrations` + `db/tests/telegramJournal.test.ts` full history) and on a real PostgreSQL when `DATABASE_URL` is present (see `db/tests/telegramConcurrency.pg.test.ts` — 6 skipped without URL, not a failure).

---

## 3. Capability status (post-sweep, delta = this sweep only)

| Capability area | Pre-sweep | Post-sweep | Note |
|---|---|---|---|
| Telegram — draft transcript privacy | PARTIAL | **IMPLEMENTED** (code) | Constraint + adapters + sweep tests |
| Telegram — update processing at-most-once + worker retry | PARTIAL (claim only) | **IMPLEMENTED** (code) `RECORDED_RUNTIME`; live execution `DEPLOYMENT_GATED` | `beginUpdateProcessing` + `finishUpdate` guards + terminal `failed` |
| AI — screenshot image boundary (4×8 MiB/16 MiB/12 MP/PNG-JPEG-WebP/32..6000px) + 24 MiB body + flag + anonymizer boundary | PARTIAL | **IMPLEMENTED** (boundary) `RECORDED_RUNTIME` | `screenshotExtraction.test.ts` 3/3 + `aiRoutes.test.ts` screenshot 3/3 |
| AI — consent → egress vs local OCR | `STATIC` (described) | **IMPLEMENTED** (enforced) | `aiManager.ts` + `aiCapability.test.ts` 2/2 |
| AI — ledger transcript length only | `STATIC` | **IMPLEMENTED** | `transcriptionLedgerInsight` + test |
| AI — real Tesseract unconditional | `PARTIAL` (stale skip comment) | **IMPLEMENTED** (unconditional, honest failure) | Comment fixed, 1/1395 expected fail documents env absence |
| Web — trades screenshot time + timezone UX | `STATIC` (helper existed) | **IMPLEMENTED** (page wired) | `screenshotTime.test.ts` 4/4 + trades `step=1` |
| Web — intelligence report (real weekly_report) replacing demo | Retro demo retired earlier | **IMPLEMENTED** (7 UTC-day, 200-trade bound, store-backed insights) | `intelligence/page.tsx` + `intelligence.json` fa/en |
| Financial / Domain helpers | VERIFIED | preserved | No regression |

`capability-matrix.json` still reports 13 VERIFIED / 8 IMPLEMENTED / 13 PARTIAL / 9 MISSING (matrix generation is separate from this sweep's 10 code deltas; matrix will be regenerated in the next governance curation — gap register is the authoritative §B inventory).

---

## 4. Key documentation and guard dispositions

| Artifact | Disposition | Details |
|---|---|---|
| `docs/adr/ADR-019-telegram-update-job-architecture.md` | **MODERN_EQUIVALENT** (updated) | Architecture accepted at `e041856`; this sweep appends the durable start-marker amendment (§2 lifecycle, `processing_started_at`, `telegram_updates_processing_lifecycle`, `telegram_updates_started_unprocessed_idx`, retry = terminal). Worker deployment + live round trip remain deployment-gated (MG-WORKER-DEPLOY + D-2). |
| `docs/adr/README.md` | **IMPLEMENTED** | Index corrected 2026-10-08: ADR-018 was present but unlisted; ADR-019 added; **next free ADR = 020** (verified). |
| `docs/telegram/README.md` + `SECURITY.md` + `DEPLOYMENT.md` | **MODERN_EQUIVALENT** | Updated to describe at-most-once start marker, terminal `failed` reconciliation, and that webhook 200 is safe because `claimUpdate` is taken before the answer. §7 still states `NOT_VERIFIED` for live services. |
| `apps/api/src/telegram/telegramBot.ts` header "1. IDEMPOTENCY" | **IMPLEMENTED** | Now names the one-shot `processing_started_at` marker as the replay no-op (not just `claimUpdate`). |
| `apps/worker/src/handlers/telegramUpdateHandler.ts` header 3. | **IMPLEMENTED** | `failed` outcome documented as terminal; queue must not replay side effects. |
| `certificate`/`guard` gates | **IMPLEMENTED** | `tesseractProvider.ts` header documents 0.4 confidence, 8 MiB/8 s/256 KiB bounds, GD non-migration; `aiManager.ts` order comment lists flag→chain→deadline→consent→quota→anonymize→call→record; `kernel/server.ts` documents per-route `maxBytes` cap. |
| `tools/secret-scan.sh`, `ops/backup`, `infra/Dockerfile.api` | **INTENTIONALLY_RETIRED / untouched** | `secret-scan` still PASS; `Dockerfile.api` not modified per task; backup offsite drill still owner-gated (OD-RPORTO). |

---

## 5. Exact test results (strongest available, nothing weakened)

Executed on this worktree after `npm ci` (Node 20.20.2, `typescript@5.5.4`, `pglite@0.5.8`):

- **TypeScript:** `npx -p typescript tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` → **0 errors** (5 projects).
- **Secret scan:** `bash tools/secret-scan.sh` → **PASS (0 findings)**.
- **General battery:** `node tools/run-tests.mjs` (excluding `*.pg.test.ts` + `db/tests` PGlite batch) → **1,395 tests, 1,394 pass, 1 fail, 0 skipped** (PGlite 73 isolated).
  - The **single failure is the unconditional real-Tesseract test** `aiCapability.test.ts: "OCR: the real tesseract binary reads a real screenshot"` — `isAvailable()===false` without the system `tesseract` binary, which this workspace does not have. It is the honest `OCR_UNAVAILABLE` signal; the previous stale skip comment said the test was skipped — now corrected. Deterministic OCR tests (probe 1, byte-cap 1, timeout 1) all pass separately (`tesseractProvider.test.ts` 3/3).
- **PGlite battery:** same run, `--test-concurrency=1` for `db/tests/**` → **73 tests, 73 pass, 0 fail** (migrations, telegram adapter, telegram journal incl. `0034`+`0035`, ledger, audit, etc.).
- **Migrations battery:** `npm run test:migrations` (PGlite from-scratch 0001→0035) → **19/19 pass**.
- **Total of `tools/run-tests.mjs`:** **1,468 tests (1,395 general + 73 PGlite), 1,467 pass, 1 fail (the documented binary-absent OCR), 0 skipped** — `overall: fail` only because the OCR test is unconditional (by design).
- **Focused evidence for this sweep (sampled, all green):**
  - `aiCapability.test.ts` 26/27 (only OCR real binary fails) — consent vs local OCR 2/2, transcription ledger 1/1, quota→next provider 1/1.
  - `telegramBot.test.ts` 19/19 — includes new `durable processing-start marker` race.
  - `telegramUpdateHandler.test.ts` 9/9 — `failed` terminal assertion.
  - `telegramStoreAdapter.test.ts` 7/7 — `beginUpdateProcessing` single-winner + `finishUpdate` immutability + claim still fails after finish.
  - `telegramJournal.test.ts` 8/8 — `0034` transcript backfill/constraint + `0035` lifecycle constraint.
  - `screenshotExtraction.test.ts` 3/3, `screenshotTime.test.ts` 4/4, `tesseractProvider.test.ts` 3/3, `telegramRoutes.test.ts` 9/9 (including oversized 256 KiB webhook 400), `aiRoutes.test.ts` 23/23 (including screenshot with 1.1 MiB padding → 200), `journalApplicationService.test.ts` 10/10 (transcript lifecycle).
- **Real-PostgreSQL batteries:** `*.pg.test.ts` — **SKIPPED** without `DATABASE_URL` (postgres-evidence workflow only); verified shape: `telegramConcurrency.pg.test.ts` adds START RACE `beginUpdateProcessing`, `pgRoles.pg.test.ts` 23/23 when run with superuser (documented prerequisite).

No test was weakened, skipped, or deleted to close a gap. The OCR authentic failure is the proof the suite is not hiding anything.

---

## 6. Genuine remaining work (honest split)

### CODE gates (deterministic repository work, safe to implement next, no owner/ infra choice needed)

- Regenerate `docs/state/capability-matrix.json` + `migration-gap-register.json` twin to move `TRD-03`/`MG-AI-OCR` `MISSING→PARTIAL` (ingest + local fallback landed) and to record `0034`/`0035` as `CLOSED` in the gap register's evidence column — the code is done, only the inventory JSON is stale (this file is the authoritative record until the next governance commit).
- `next build --webpack` pin: `aiRoutes.test.ts: "oversized JSON … is a client 413"` currently exercises the 1 MiB default; add an explicit 24 MiB+ screenshot body that asserts 413 `PAYLOAD_TOO_LARGE` on `extract-screenshot` to pin the ceiling (the floor is already pinned by the 1.1 MiB valid-screenshot test).
- `contentSurfaces.test.ts` digit regex: replace `(/\d/.test(merged[key]))` with `(/\d/.test(toLatin(merged[key])))` so fa catalogs may contain Persian digits if desired — currently fa types that need Persian numerals must use Latin digits to satisfy `currentTranslator`'s `toLatin` (fixed for `intelligence`'s 200 in this sweep; general fix is a one-line test change).
- Achievements `Jalali`/`TradingSession` re-audit hooks (domain → API → web read path) — code ports exist but the read API/web wiring uses a separate gap; not required for residue closure.

### OWNER_DECISION_REQUIRED (recorded, must not be guessed)

- `R1` (password policy at login for 8–9-char legacy users), `R8` (public vs protected `markets`/`news`/`support`), `R9` (strategy winRate/order/untagged), `OD-AC-SUBMAP` (`grace`/`expired` subscription vocabulary), `ADR-004` naive-datetime sampling procedure, `RPO/RTO` targets, `MG-AI-ANONYMIZE` image-library dependency, `CSP` release pinning/manifest model (S2 remainder), second-process secret allowlist (D-2 amendment for `TELEGRAM_BOT_TOKEN` in the worker), `Jalali` algorithm window-drift correction, trusted-proxy CIDR values (code is fail-closed empty; operational CIDRs are per-environment).

### DEPLOYMENT_GATED (code `RECORDED_RUNTIME`, execution `NOT_VERIFIED` until a real environment exists)

- Telegram: live bot token + webhook secret + `TELEGRAM_UPDATE_MODE=webhook|polling` + `VELORA_APP_URL` → `POST /api/v1/webhooks/telegram` → `telegram.update` pg-boss job → worker `TelegramBot` → journal write → channel mirror. Requires (a) `worker` service deployed (MG-WORKER-DEPLOY), (b) `TELEGRAM_BOT_TOKEN` provisioned to that second process (D-2), (c) a Telegram `getUpdates` vs webhook exclusivity check, and (d) a live Bot API round trip (already scripted in tests with `FakeBotApi`).
- MetaAPI position assembly live tick (OD-M-PA-1/2/3 ratification + MetaAPI credentials + history deals fetch).
- AI live provider round trip (Gemini/OpenAI credentials + relay) and the anonymizer dependency if external vision is desired; Tesseract binary presence (`/usr/bin/tesseract`) — until then the honest `OCR_UNAVAILABLE` 503 is the correct answer.
- Backup offsite upload + production restore drill, edge HSTS deployed confirmation, `pgRoles` `ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner` on Railway-hosted PostgreSQL (requires superuser/owner role).
- No `DATABASE_URL`-dependent real-PG concurrency proof was fabricted — those batteries correctly skipped (6 skipped) in this local run.

---

## 7. Is only Telegram live deployment remaining?

**No.** Telegram is one of several deployment-gated items, and several code/owner gates remain:

- **Code gates** (3 small deterministic items above) are not deployment-related.
- **Owner gates** (≥10 decisions) are not Telegram-specific (subscriptions, RPO/RTO, CSP pinning, anonymizer, ADR-004 sampling, trusted proxies, Jalali correction, strategy semantics).
- **Deployment gates** beyond Telegram: MetaAPI live assembly, AI live provider + Tesseract binary, offsite backup, edge HSTS, hosted-PG superuser. Even for Telegram, the worker service definition (`railway.json` `worker` + `infra/Dockerfile.worker`) is the same gate that blocks every background job (FX, copy, sync cadence).

So the correct statement is: **Telegram is code-ready for the next live deployment/verification phase** (repository work complete, idempotent at every boundary, failing closed, with 24 queue-path tests + the new at-most-once markers), **but it is not the only remaining deployment gate**, and it is **not marked live**.

---

## 8. References (source of truth)

- Legacy reference: `veloratrade/veloratrade@edede313280f2f0e298f5ccbf5bbdd4d676c80bd` — actual `main` at sweep start, never modified.
- Modern verified before: `77f0e17603274796073c7a16732b10cf6cac8f25`; after: this commit (see `current-state.json`).
- Key files touched: `apps/api/src/telegram/telegramStore.ts`, `pgTelegramStore.ts`, `memoryTelegramStore.ts`, `telegramBot.ts`, `telegramUpdateHandler.ts`, `apps/api/src/ai/*`, `apps/web/src/features/trades/screenshotTime.ts`, `apps/web/src/app/(app)/trades/page.tsx`, `apps/web/messages/{en,fa}/trades.json`, `apps/web/messages/{en,fa}/intelligence.json`, `db/migrations/0034*`, `0035*`, `db/tests/*`, `apps/web/src/i18n/contentSurfaces.test.ts`.
- No `infra/Dockerfile.api` change, no MySQL/PHP bulk copy, no secret material, no production infrastructure created.

