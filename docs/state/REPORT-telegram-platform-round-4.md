# Telegram platform round 4 — the loop, the budgets, the operator's panel: consolidated report

Scope: the 15-section round ("Unified Telegram AI Platform — Admin Panel, Provider Management, Research,
Chart Capture, Templates, Publishing and Verification"), continued from
`REPORT-telegram-platform-round-3.md`. This file says what was audited, what was built, what was found broken,
what was executed, and — in separate, named buckets — what could not be verified in this environment. Nothing
here is a commit, push or deploy report: none of those happened (§10).

Baseline: `HEAD 354edaa`, unchanged. The working tree went from **34 `M` / 39 `??`** at the end of round 3 to
**44 `M` / 45 `??`** now (this report is one of them). Every path added by this round is named in §9.

---

## 1. What the audit found, and the two claims it disproved

Both were claims this project had been making about itself in writing:

| Claim on disk | Reality found this round | Resolution |
| --- | --- | --- |
| "The agent runs a multi-step plan" (`MAX_AGENT_TOOL_STEPS = 6`) | The planner made **one** model call and nothing consumed the ceiling. The constant was decorative. | `aiAgentLoop.ts` now enforces it; `MAX_AGENT_TOOL_STEPS` is quoted in `/help` from the same constant, so the prose cannot outlive the code. |
| "Per-tool budgets" (`TOOL_BUDGETS.perUserPerHour`) | `web.search` and `chart.capture` both spent `telegram:analyze`, so a user who searched 300 times was metered as if they had analysed 300 charts. The table enforced nothing. | Three real keys (`telegram:search`, `telegram:capture`, `telegram:agent`) added to `RATE_LIMIT_DEFAULTS`; `aiToolBudgets.test.ts` reads the table against the defaults so they cannot drift. |
| "The admin panel shows AI capabilities" | `grep -rln "admin/ai" apps/web` returned nothing: the API surface existed, the UI did not. | An `Agent tools` tab now reads the endpoint and renders its five states (§6). |
| "`TOOL_BUDGETS` is documentation because `RateLimitKey` is closed" (round-3 inventory) | True then; it described a limit, not a wish. | Section G of the inventory is corrected by section H rather than silently rewritten, so the record shows the decision that changed it. |

No new service, store or data model was created for any of this: the limiter, the audit store, the AI config
store and the bot's registry were extended in place.

## 2. The loop (`apps/api/src/ai/aiAgentLoop.ts`) — what it owns and what it refuses to own

Control flow only. The caller owns egress, rendering and storage; the loop owns ordering, gating and stopping.

* Human history and the model's plan are awaited **together** (the round's standing `Promise.all` rule), so a
  45 s budget is not spent reading the transcript first.
* Every step passes four gates before it runs: registry membership (unknown tool → `malformed-plan`, never a
  silent skip), the budget, the approval-only list, and target verification.
* `stoppedBy` is one of `max-steps | max-model-calls | wall-clock | repeat-guard | tool-budget |
  malformed-plan | planner-unavailable | unverified-target | approval-required`, and `completed` is the
  narrowest outcome: `stoppedBy === null` **and** every step ok. A failed or throwing step is `partial`, and
  `partial` must be explained — the stop reason and the step count travel to the user, not just to a log.
* The model sees short redacted `observation`s. It never sees a payload, and it cannot see its own plan
  reflected back as evidence.
* A stopped run never ends at zero messages: `renderLoopOutcome` always answers, including when the run
  stopped before any tool executed.

## 3. Target verification, and the guard that guarded nothing

`verifyTarget` checks the arguments that name something outside the conversation — `chart.capture.url`,
`post.publish.postId`, `channel.select.channelId` — against the set of URLs, ids and dates that actually
appeared. The first implementation seeded that set from the plan. That is a tautology: the model proposed
`https://example.com`, and the guard confirmed the model had indeed proposed it. Seeding is now from **human
text and tool results only**, and the test that pins it asserts `chart.capture` is stopped with
`unverified-target` when the URL appears only in the model's step. The same rule is what keeps the publish
path honest about destinations elsewhere in the platform.

## 4. Budgets, ceilings and the limiter's own two bugs

* `AgentLoopBudget { maxSteps, maxModelCalls, wallClockMs, perToolLimit }`, with `perToolLimit[tool] ?? 1`;
  `telegramAgentLoopBudget()` derives it from the catalogue plus `AGENT_RUN_DEADLINE_MS` (45 s, deliberately
  larger than the 25 s model deadline so a run can still answer after the model times out).
* Each path pays its own key **once**. A generic pre-check in `performToolStep` was written, measured, and
  removed: it charged a single search twice (once for the agent bucket, once for the tool bucket), which is a
  budget that punishes the user for the platform's routing decision.
* `MemoryRateLimitStore.hit` had two defects, both found by its own battery under `Promise.all`, both live
  before this round: it returned a live reference into its bucket map (the caller could mutate stored state),
  and the deny path re-read an already-expired bucket, so a refusal could be answered as an allow on the next
  call. The store returns immutable snapshots on every path now — the ordering of a burst is observable, which
  is the only way a rate limiter can be tested honestly.
* Fail-open at the bot edge is retained (`allowed()` returns true if the limiter throws), because losing chat
  access to a metering outage is the worse failure — and `memoryRateLimitStore.test.ts` pins both directions.

## 5. What the admin can see, and what the button costs

`GET /api/v1/admin/ai/tools` → `{ items, states, tools }`;
`POST /api/v1/admin/ai/tools/{tool}/validate` → `200` evidence, `424` completed-but-negative,
`422 UNKNOWN_TOOL`, `503 TOOL_NOT_VERIFIABLE`; a deployment without tool services gets `503`, never an empty
list that would read as "this platform has no tools".

`configured | verified | unavailable | failing | unsupported` are carried in the payload, because the
difference between them is the entire content of the screen: `unavailable` is a key to set, `failing` is a
provider that refused, `unsupported` is a runtime that cannot host the capability — no credential changes
that. The raster row in a Worker is `unsupported` and can never collapse into "off"; `capabilities()` never
returns `verified` for it, since nothing was verified.

Reads are `aiManage`; the probe is `aiRouteManage` (super admin), because it spends a provider request with the
platform's credential. The 403 is asserted to happen **before** any fetch: `toolCalls.length === 0`.

The check is a button, never an automatic refresh on mount — a screen that re-probed on open would burn
third-party quota every time an operator looked at it and fill the trail with machine-made "verifications".

## 6. The admin console tab

`apps/web/src/app/(app)/admin/page.tsx` gained the `ai` tab (permission-driven off the server-reported set),
`resources.ts` gained the three typed readers/writers, and both catalogues gained 30 keys each. Nothing about
a state is inferred client-side: the five labels are literal keys — `adminConsole.ai.state.*` — because the
console's guard scans string literals and a composed key would let a missing translation in one locale ship as
"the module is broken". `reason` codes and `runtimeSupported` are printed rather than folded into a boolean.

Two guards were strengthened to cover the new tab rather than let it slip past them:
`apps/web/src/i18n/adminSurface.test.ts` now also reads `aiAdminRoutes.ts` as a route module (so the tab's
permission must be checked server-side, not merely hidden), and its `declaredPermissions()` scan accepts
Legacy's undotted `aiManage`/`aiRouteManage` — those names are carried verbatim so `Role.php` still diffs by
name, and a scan that assumed every permission contains a dot would have rejected them as typos.

## 7. The audit decision, and the vocabulary guard that had to be rewritten

One `AI_TOOL_VALIDATED` row per **executed** probe: `tool:<name> verdict:<ok|errorCode>`, `requestId`,
`actorUserId`, `outcome` success for any completed probe. Reads, refusals and permission denials write nothing.
`provider` is NULL by choice: widening `audit_log_provider_check` to admit a search vendor would change the
meaning of that column for every other row in the table. No endpoint, no body, no credential identity — the
trail is correlation, and `audit_log` is readable under `audit.view` without `audit.view_sensitive`, so
response data in it would launder private content into a general-purpose log. `AiAdminCapability.audit` is a
**required** field: a mount that exposes the button must expose the trail, and a failed append propagates
rather than turning a partial write into a green row.

`apps/api/src/auth/auditVocabulary.test.ts` (3 cases) compares the code's `AUDIT_ACTIONS` with the last live
`audit_log_action_check`. Its second case was wrong on first writing and was corrected during review: it
asserted the CHECK has never narrowed. History says otherwise — 0036 dropped 0027's two admin actions and 0040
restored them. A test cannot encode "never" against a fact, so it now asserts that 0036's narrowing is the
**only** one in all 41 migrations and that the restored pair is live; silently permitting "monotonic from 0040
onward" would have given the next narrowing a place to hide.

Migration `db/migrations/0041_audit_ai_tool_action.sql` is the only schema change this round needed, and it
follows the house pattern (drop + recreate one constraint, no new table, no new column). `db/MIGRATION_MAP.md`
carries its row, including what is deliberately *not* audited.

## 8. Full-suite result

```
npm test → EXIT=0
  general batch: tests=1732 pass=1731 fail=0 skipped=1 killed=0 → pass
  PGlite batch:  tests=85   pass=85   fail=0 skipped=0 killed=0 → pass
tsc -b packages/contracts packages/domain apps/api apps/worker   → exit 0
tsc -b apps/web                                                   → exit 0
```

Per-file (executed directly this round): `aiAgentLoop` 19 · `aiToolBudgets` 6 · `aiAgentPlanner` 4 ·
`aiTools` 17 · `aiRoutes` 31 (6 new admin-tools cases) · `auditVocabulary` 3 · `telegramBot` 86 (6 new agent
cases) · `telegramAgent` 10 · `rateLimiter`+`memoryRateLimitStore` 13 · `telegramStoreAdapter` 10 (new #10) ·
`db/tests/migrations` 25 (new #25 for 0041) · `adminSurface` 9.

Two things went red in the full run that a file-by-file habit would have missed, and both were kept as
findings rather than edited away:

* `telegramAgent.test.ts`'s "every declared tool is shaped for enforcement" asserted a hard-coded list of four
  legal `limitKey`s. It broke the moment `web.search`/`chart.capture` moved onto the newly enforced keys — the
  right symptom, the wrong guard. It now reads the legal set from `RATE_LIMIT_DEFAULTS` (so it cannot fall
  behind again) and keeps pinning the family rule, `telegram:*`.
* `aiCapability.test.ts`'s real-`tesseract` case is environment-limited, not a code defect; see §9.2.

## 9. Status buckets — separated, as required

### 9.1 Executed and verified here
Everything in §8 was run in this sandbox against real code: the loop's nine stop reasons and its `completed`
rule, target verification including the self-feeding-guard regression, budget parity between the catalogue and
the limiter, the limiter's snapshot and expiry semantics, the admin endpoint's four outcomes and its
read/write permission asymmetry, the audit row's content and its absence on refusals, the migration's
constraint over the whole 18-name union, `image_file_id` atomicity against PGlite, and the console guards
(keys in both locales, classes defined, permissions checked server-side, no Persian literals in code).

### 9.2 Environment-limited (a dependency is absent here)
* **OCR**: `tesseract` is not installed and this project may not `apt-get install` to make a suite green. The
  case now skips with the named reason `NO_TESSERACT_BINARY` instead of failing, so the run says "unverified"
  rather than "the code is wrong". The sibling case still pins what absence must do: `OCR_UNAVAILABLE`, never
  an empty string that reads like a successful read.
* **Persian banner raster**: `@resvg/resvg-js` is a native Node module. Proven working in Node
  (`evidence/banner-velora-bias-fa.png`, 1080×686, bidi-correct); reported as `unsupported` in a Worker,
  which is what the admin panel now says out loud.

### 9.3 Credential-blocked (nothing was fabricated to cover it)
No search key, no browser-automation endpoint and no model-provider secret exists in this sandbox. Live
`web.search`/`chart.capture` behaviour is therefore proven against injected `fetchImpl` stubs only, and a real
`verified` row in the admin panel requires a deployment with credentials. Nothing in this round claims a
provider answered.

### 9.4 PostgreSQL — PGlite only, never the live branch
`0041` (and `0038`–`0040` from round 3) plus the adapter statements were executed on **PGlite**, which is
real PostgreSQL semantics in-process but single-session. That means: constraint and CHECK behaviour is
evidence; concurrent-session behaviour and the live Neon branch are **not** touched. `db/tests/migrations.test.ts`
#25 was re-run this round (25/25, 51.5 s) after having been written-but-unexecuted.

### 9.5 Real Bot API — not verified
No bot token is available here, so no `sendMessage`, `sendPhoto` or callback was ever delivered to Telegram.
Bot behaviour is proven through the injected transport in `telegramBot.test.ts` (86 cases), including the
publish audit trail and its retry leg.

### 9.6 Browser / UI — verified at source and type level only
No dev server was driven against a live API, so the `Agent tools` tab has not been rendered. What is verified:
`tsc -b apps/web` exit 0, the 30 new keys resolve in both locales, every class it applies exists in the
stylesheets, and every permission it gates on is enforced by a route module. What is not: pixel layout, RTL
behaviour of the new table, and the click path through a real ApiError.

### 9.7 Change-control, search, and the tree
* **Nothing deployed, committed or pushed.** `apps/worker-cf/` remains untracked; its agent branch is written
  to the same callback contract as Node and would need a real `wrangler` deploy plus a D1 migration policy
  review before it does anything. No Worker deployment state was read or written, and no secret was changed —
  D1 remains intake/dedupe only.
* **No destructive action on real data**: this round wrote no row to the live database, deleted nothing, and
  `TELEGRAM_TEST_USER_ID` (`keep_all`) is untouched.
* **Web search unavailable** in this environment; nothing in this report cites an external source. (The
  round's decisions come from the code and the two constraints documents, not from the web.)
* **Secret scan**: the full diff plus all 60 untracked source files were scanned for key/token/JWT/webhook
  patterns and for secret-named literal assignments — no findings, no `.env` file touched.
* Paths this round added or changed: `apps/api/src/ai/{aiAgentLoop,aiAgentLoop.test,aiAgentPlanner,aiAgentPlanner.test,aiToolAdmin,aiToolBudgets.test,aiRoutes.test}.ts` (loop, planner, admin, budgets),
  `apps/api/src/auth/{auditStore,auditVocabulary.test}.ts`, `apps/api/src/ratelimits/*`, `apps/api/src/server-main.ts`,
  `apps/api/src/telegram/{telegramBot,telegramAgent,telegramStore,pgTelegramStore,memoryTelegramStore,telegramCopy}.ts` + tests,
  `packages/contracts/src/{auth,telegram}.ts`, `packages/domain/src/index.ts`, `apps/web/src/app/(app)/admin/page.tsx`,
  `apps/web/src/lib/api/resources.ts`, `apps/web/src/i18n/adminSurface.test.ts`, `apps/web/messages/{en,fa}/admin.json`,
  `db/migrations/0041_audit_ai_tool_action.sql`, `db/MIGRATION_MAP.md`, `db/tests/{migrations,telegramStoreAdapter}.test.ts`,
  `apps/worker-cf/src/runtime.ts`, `docs/state/{CHANGE_LOG.md,WORKING-INVENTORY-telegram-full-product.md,this report}`.

## 10. Explicitly not done

* No commit, no push, no deploy, no secret change, no Worker deployment state change.
* `web.search`/`chart.capture` were not exercised against live providers (no credentials) and the admin panel
  reflects that as `configured`/`unavailable` rather than pretending otherwise.
* The captured-image artifact store from earlier rounds is still not built: the D1/Neon split forbids storing
  screenshot bytes where intake metadata lives, and no existing store in the platform holds binaries — that
  remains the named missing dependency, not a button.
* Chart-capture OCR into the journal stays out of scope by policy: capture results are separated from AI
  annotation, and the journal records what the human approved, not what a model inferred.
* No second audit store, no per-tool quota service, no new `AiFeature`: all three were considered and
  rejected because an existing mechanism does the job.
