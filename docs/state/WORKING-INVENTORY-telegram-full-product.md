# Private implementation inventory — Telegram full-product round

Working notes only (spec §1). Baseline: HEAD `354edaae`, branch `main`, **no upstream**, 0 staged,
25 `M` + 13 `??` — all pre-existing, none of it mine to touch. Every line below was read in the
tree this round, not recalled from an earlier report.

## A. EXISTS — reuse, do not rebuild

| Capability | Where | Shape |
|---|---|---|
| Channel registration + verification | `telegramBot.ts:834-903` (`handleChannelCommand`) | Client chat id treated as a CANDIDATE only; `getChat` + `getChatMember` decide. Rejects `private`. Statuses `ACTIVE`/`INSUFFICIENT_PERMISSIONS`. |
| Channel store | `telegramStore.ts:179-201`, pg `:460-540`, memory `:330-380` | `upsertChannel` (reopen-on-conflict), `findActiveChannel`, `findChannel`, `revokeChannel`, `claimChannelPost`, `finishChannelPost`, `listPublishedTradeIds`. |
| Publish idempotency | `telegramBot.ts:836` + `telegram_channel_posts_once_unique UNIQUE (channel_id, trade_id)` | Claim-before-send, `PUBLISHED`/`FAILED` + `error_code`; "already mirrored" is a claim miss, not an error. |
| Bot API wrapper | `telegramApi.ts:104-119` | `sendMessage` (HTML + `inline_keyboard` + `disable_notification`), `getChat`, `getChatMember` (`canPostMessages`), `getFile`, `downloadFile`, `answerCallbackQuery`, `getUpdates`, `getMe`. |
| Callback vocabulary | `contracts/telegram.ts:226-258` | Closed set `CALLBACK_ACTIONS` mirrored in `CALLBACK_RE`; `buildCallbackData`/`parseCallbackData`; `MENU_TARGETS` closed. |
| Draft → confirm workflow | `journalApplicationService.ts` (`openFromText`, `answer`, `confirm`, `cancel`) | `claimDraftForConfirmation` + `releaseConfirmationClaim`, `DRAFT_ALREADY_CONFIRMED`, ownership-before-anything, `missingJournalFields` enforced at confirm. |
| Checklist persistence + merge | `journalChecklist.ts`, `journal_daily_checklists` (0036) | 11 items; `CONFIRMED`/`UNREVIEWED`/`UNKNOWN` closed; DB-enforced `complete = confirmed_items = 11`; sparse-map merge. |
| Coverage aggregate | `summarizeChecklistCoverage` (`journalStats.ts:301`), `checklistCoverageSummary` | received/needed + `truncated` tripwire added last round; span clamped to the store's own bound. |
| Shared date contract | `jalali.ts:242-420` (`resolveChatDate`, `readLeadingChatDate`, `toLatinDigits`, `GREGORIAN_YEAR_FLOOR`) | Persian+Latin digits, `j:`/`g:`/`جلالی`/`شمسی`/`میلادی`, round-trip validation, ambiguous ⇒ refusal. Consumed by /stats, /checklist, journal text. |
| OCR / screenshot extraction | `ai/screenshotExtraction.ts`, `tesseractProvider.ts`, `aiCapability.test.ts` | Deterministic parse of provider text; confidence markers. |
| Image anonymization | `ai/imageAnonymizer.ts` | Applied inside `AiManager.call`; not bypassable by callers. |
| AI egress boundary | `ai/aiManager.ts:128-287` | consent → feature flag → quota → deadline → route fallback → ledger; `requiresStructuredOutput`; refusal codes. |
| Media interpreters (runtime-aware) | `aiManagerMediaInterpreter.ts`, `telegramProcessorFactory.ts:177`, `mediaAvailable` gate in bot | Help/feature text is gated on an interpreter that is actually configured. |
| Rate limits | `RATE_LIMIT_DEFAULTS` (`contracts/auth.ts`) incl. `telegram:update/journal/analyze/channel/link-start` | `bot.allowed(tgId, key)`. |
| Attachments (source artifacts) | `attachments/attachmentService.ts`, `trade_attachments` (0015), `attachPendingMedia` `telegramBot.ts:800-824` | `category: BEFORE`, stores original bytes under the trade. **This is the "keep the original screenshot" mechanism.** |
| Access gate | `docs/telegram/…` + gate in `dispatch` (private-test allowlist) | Untouched by design. |
| L3 latency optimization | `telegramBot.ts:208` + `tools/l3-overlap-bench.mts` | Preserved as-is. |

## B. PARTIAL — extend, do not fork

1. **Channel selection**: schema allows N registered channels (`UNIQUE (user_id, chat_id)`) but
   `telegram_channels_one_active_per_user` (0023:255, partial unique on `status='ACTIVE'`) permits
   exactly **one active**. → Multi-channel "select a target" must be implemented as *choosing which
   registered channel is active*, not as N active rows. Loosening that index is a safety-invariant
   change and is NOT done here.
2. **Publishing**: exists only as *trade mirroring* (`telegram_channel_posts.trade_id NOT NULL` + FK).
   A prepared/template post has no trade → the existing table cannot hold it.
3. **Help**: accurate, but lists only current commands; nothing about templates/agent/channel posts.
4. **Free-text routing**: every non-command message becomes a journal draft (`telegramBot.ts:301`),
   so "which checklist fields are unknown?" is captured as a trade. The agent layer must run BEFORE
   that fallthrough.
5. **`sendPhoto`**: absent from the wrapper; photo posts therefore impossible without extending it.

## C. GENUINELY MISSING (build)

- Template grammar (placeholders, unknown-placeholder reporting, length/markup safety, versioning).
- Built-in template definitions (Bias card, Setup card) + Persian/English + RTL.
- Banner composition (SVG only — see D) and its association with a draft/post.
- Generic outbox post persistence (draft → preview → approve → publish) with its own dedupe key.
- Natural-language intent routing + a typed, authorization-checked tool registry.
- `/template`, `/post` command surfaces and their callbacks.

## D. BLOCKED by environment — must be reported, never simulated

| Dependency | Status |
|---|---|
| Browser automation | **None.** `playwright` appears only in `docs/audits/**` prose; zero imports, zero dep entries. |
| Web search provider | **None.** `web_search`/`fetch_url`/search API: 0 hits in `apps`/`packages`. |
| Chart capture (TradingView etc.) | **Blocked** with the two above. |
| Image rasterization (SVG→PNG) | **Blocked.** Root deps are only `postgres`, `tsx`, `@electric-sql/pglite`, `wrangler`, `typescript`, `@cloudflare/workers-types`, `@types/node`: no `sharp`/`canvas`/`jimp`/`resvg`. A Worker has no canvas. |
| Real PostgreSQL / live Telegram | Available only through the owner's fixture-guarded harness; unit + PGlite are not the same thing. |

**This table is the state at AUDIT time and is deliberately not edited** — three of its four rows changed
during implementation; see §G for the close-out, and do not read the rows above as today's state.

Consequences I accept and will state in the report: banners are composed as **SVG text** (real,
deterministic, testable, stored as the source artifact) and delivered as a text card; no claim that
an image was posted; no claim that a search or a chart capture succeeded; help does not advertise
either.

## E. Change-control lines held

No commit/push/deploy; no secret/token/credential change; no Hyperdrive/Cron/env-var/access-gate/
worker-config change; no new `AiFeature` or provider route (agent tools are local, the AI Manager
boundary is reused, not extended); no destructive test against a real DB; untracked
`apps/worker-cf/wrangler.jsonc` left untracked.

---

## F. Status at the end of the round

Every row of §1–§10 of the brief is either implemented-and-tested to this environment's limit or recorded above as
blocked with its exact missing dependency. The consolidated report is
`docs/state/REPORT-telegram-full-product-round.md`; the capability table mirror lives in
`../13-TELEGRAM-FEATURE-EXPANSION-AUDIT.md` (Round 3).

Two inventory entries changed meaning during implementation and are corrected here rather than left stale:
the banner work was **stored, not shipped as a bitmap** at the time of writing (superseded by §G: a rasterizer now exists in the Node runtime), and the outbox tables are two, not one
(`telegram_post_templates`, `telegram_outbox_posts`) — which is also why 0023's exact table-list test had to grow.

---

## G. Round 3 close-out (2026-10-19) — what the audit rows above became

The four blocked rows are the reason this round exists, and each is now in a named state. The audit table is
left as written so the record of what was known before the work stays legible; this section is what changed.

| Audit finding | State after round 3 | Where the proof is |
|---|---|---|
| Browser automation: none | **Implemented against a browserless-protocol service over HTTPS** — `apps/api/src/ai/aiBrowserService.ts`. No browser binary is bundled into this process (a Worker cannot run one; the API image does not have one), so the capability is a configured service, and the state is `unavailable` with the missing secret named until `BROWSERLESS_URL` + `BROWSERLESS_TOKEN` resolve. | `apps/api/src/ai/aiTools.test.ts` (7 browser cases), `POST /api/v1/admin/ai/tools/browser_capture/validate` |
| Web search provider: none | **Implemented** for Tavily, Brave and Serper, each with its own authentication header and its own key; one provider's verdict never lands on another. Migration 0039 gave the admin store the five tool keys to make that configurable without a redeploy. | `aiTools.test.ts` (4 search cases + the SSRF table), `db/tests/migrations.test.ts` #21 |
| Chart capture: blocked with the two above | **Available where the browser service is configured**, gated to the chart-host allowlist and to `assertSafeUrl` (no internal address, no credential-bearing URL, no redirect following). Reads pixels through `interpretImageAndRecord` — the same guarded vision path as a user-forwarded screenshot — and answers OBSERVED vs NOT READ, writing nothing to the journal. | `telegramBot.test.ts`: the capture, host-refusal and "nothing invented" tests |
| Image rasterization: blocked, no `sharp`/`resvg` | **Unblocked in the Node runtime**: `@resvg/resvg-js` and `vazirmatn` are real dependencies, the module AND the font are probed, and a preview/publish path uploads a real PNG and stores the returned `file_id`. `unsupported` remains the honest state in a Worker (`runtime: "node"` in the catalogue), and the absence of a font is a refusal to render rather than an image of empty boxes. | `docs/state/evidence/banner-velora-bias-fa.png`, `.../banner-velora-setup-en.png`; `aiTools.test.ts` rasterizer test; `telegramBot.test.ts` banner upload tests |

Two rows are still open, by decision rather than by oversight, and both are recorded in
`docs/state/REPORT-telegram-platform-round-3.md` §15:

* **Captured screenshots are not stored.** `AttachmentService` is trade-scoped and this product forbids a
  parallel store; capture therefore reports a digest and dimensions instead of persisting an artifact.
* **The per-tool hourly budgets in `TOOL_BUDGETS` are documentation, not enforcement.** The enforced ceiling
  is the existing `telegram:analyze` bucket, because `RateLimitKey` is a closed union in
  `packages/contracts` and widening it for one round's convenience is the kind of change this project defers
  to an owner decision.

Also corrected here: the audit trail defect this round found and fixed — `audit_log_action_check` had been
narrowed by migration 0036 (dropping 0027's two admin actions, which made admin session-revocation and
email-verification fail their audit insert *after* committing). 0040 restores them and adds
`TELEGRAM_POST_PUBLISHED`; `db/tests/migrations.test.ts` #24 now walks the whole union so a future rewrite
cannot silently drop a name again.

## H. Round 4 close-out (2026-10-20) — the loop, the budgets, the operator's panel

**One correction to the record above first.** Section G states that "the per-tool hourly budgets in
`TOOL_BUDGETS` are documentation, not enforcement", because `RateLimitKey` was a closed union. That is no
longer true and was never a good resting place: a ceiling that is written down and enforced by nobody is how
a budget becomes a rumour. Three keys (`telegram:search`, `telegram:capture`, `telegram:agent`) now exist in
`packages/contracts`, `TOOL_BUDGETS.perUserPerHour` is read from those defaults by `aiToolBudgets.test.ts` so
the table and the limiter cannot drift apart, and each key is spent exactly once per call. The one thing that
did *not* change is the principle the sentence was protecting: no new limiter, store or bucket family was
invented — the keys were added to the limiter every entry point already uses (`apps/api/src/ratelimits/*`,
shared by the Node processor and the Worker runtime).

| Item | Runtime | State |
| --- | --- | --- |
| `apps/api/src/ai/aiAgentLoop.ts` + `.test.ts` (19) | `node` | VERIFIED — control flow only: seeds history and the model's plan in parallel, gates every step, executes through the caller's callback, stops on `max-steps`, `max-model-calls`, `wall-clock`, `repeat-guard`, `tool-budget`, `malformed-plan`, `planner-unavailable`, `unverified-target`, `approval-required`. `completed` only when every step is ok and nothing stopped it. No egress, no storage, no rendering inside. |
| Planner v2 (`telegram_agent_planner_v2`) + `AgentPlanStep.historyIndex` | `node` | VERIFIED — one model call, no loops in the planner, approval-only tools never offered, `history` and `remainingMs` sent so the model plans from what already happened and inside the time left. `interpretPlan` re-validates against the registry. |
| Target verification (`verifyTarget`, `MUST_BE_KNOWN`) | `node` | VERIFIED — a step may only name a URL/id/date the human typed or a tool returned, and the allow-list is seeded from **human text and tool results only**. A guard fed from the model's own output is not a guard; that bug was found and fixed here. |
| `apps/worker-cf/src/runtime.ts` agent branch | `cloudflare-worker` | WIRE-ONLY, NOT DEPLOYED — same callback contract as Node, `perToolLimit: 1`, `stoppedBy` → copy mapping. D1 stays intake/dedupe; it stores nothing about the run. |
| `packages/contracts/src/auth.ts` three rate-limit keys + `RateLimitKey` | both | VERIFIED by `tsc -b` and the suites; widening a closed union was an owner-level change and is recorded in `CHANGE_LOG`. |
| `apps/api/src/ratelimits/rateLimiter.ts` snapshots | both | VERIFIED (13) — `MemoryRateLimitStore.hit` returns an immutable snapshot per call and does NOT re-read an expiring bucket on the deny path. Both defects were live here and were caught by `memoryRateLimitStore.test.ts` under `Promise.all`. |
| `GET /api/v1/admin/ai/tools` · `POST …/tools/{tool}/validate` | `node` | VERIFIED (31) — five states (`unavailable`, `configured`, `verified`, `failing`, `unsupported`) travel in the payload; a runtime without tool services answers 503, never an empty list; a refusal sends no bytes to the provider and writes no audit row; `POST` requires the super-admin route permission that reading does not. |
| Admin console `Agent tools` tab + `resources.ts` | `web` | VERIFIED against the source guards in `apps/web/src/i18n/adminSurface.test.ts` (9) and `tsc -b apps/web`; NOT rendered in a browser here — no dev server was run against a live API. |
| `auditVocabulary.test.ts` (3) + migration 0041 | both | VERIFIED on PGlite — `AI_TOOL_VALIDATED`; every action in code is allowed by the one live action `CHECK`, 0036's narrowing stays the single recorded exception, and `db/MIGRATION_MAP.md` says what is deliberately NOT audited. |
| `db/tests/telegramStoreAdapter.test.ts` #10 | PGlite | VERIFIED — `image_file_id` is written atomically with the transition and a finish that names no id cannot erase the stored one. |

**What a tool check does and does not put in the trail.** One `AI_TOOL_VALIDATED` row per *executed* probe,
with the verdict and the code, correlated by `requestId`. No provider endpoint, no response body, no
credential identity: the audit table is an append-only trail readable by `audit.view` without
`audit.view_sensitive`, so putting provider response data in it would launder private data into the log. Reads,
refusals and permission denials write nothing. `provider` is left NULL on purpose — widening
`audit_log_provider_check` to admit a search vendor would change the meaning of the column for every other
row, and this row does not need it.

**Still blocked here, for the same reasons as round 3.** No credential means no live provider verification:
`validate` on a configured platform is exercised against injected stubs, so "the endpoint answered" is proven
only where a real key exists. `@resvg/resvg-js` remains Node-only, so raster rows say `unsupported` in a
Worker. Nothing was deployed, committed or pushed; `apps/worker-cf/` is still untracked. The real Bot API was
never called (no token), and no browser session was driven, so the admin tab is verified at source and type
level only.

## I. Round 5 close-out (2026-10-20) — the panel was opened in a browser, and the browser corrected it

Round 4's table row for the admin UI said "NOT rendered in a browser here". It is now: the `Agent tools` tab
was driven through real headless Chromium against the real API app (in-memory stores, provider fetch mocked —
`tools/admin-ui-verify/`), in six server-side scenarios, 46 rendered checks, all green in the final matrix.
What the pass actually corrected, in order of how much it mattered: the client was discarding the 424
verdict body (the evidence now travels: `err.data` on `ApiError`, recovered by `adminAiToolVerdictFromError`,
rendered with state/status/code/latency/instant); the "Last checked" column was deleted as a column that
could only ever read "never" under the deliberate no-cache contract; the duplicated
"Not possible in this runtime · Not possible in this runtime" suffix is gone; and the decorative "Tool"
badge became the tool count. Regression guards for all four live in `adminSurface.test.ts` (10 tests), and
the reload-after-green-verdict case is pinned to show NO stale green. Full-suite after the fixes: general
1733/1732/0-fail/1-named-skip, PGlite 85/85, `tsc -b apps/web` 0, production `npm run build -w apps/web` 0.
Sentinel scan across every response body, console line and DOM in all six scenarios: clean. Still
`BLOCKED_BY_ENVIRONMENT`: real provider credentials (so `verified` against a live vendor remains mock-only),
`tesseract`, real Bot API, Worker deployment; nothing committed, pushed or deployed, tree at 45 `M` / 48 `??`
against `354edaa`. `docs/state/REPORT-telegram-platform-round-5.md` holds the eleven answers;
`docs/state/evidence/admin-ui-round5/<scenario>/` holds the screenshots and per-check results.
