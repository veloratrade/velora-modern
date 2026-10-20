# Telegram full-product round — consolidated report

Round: **Velora Modern Telegram — Full Product Implementation, Channel Publishing, Template Studio, AI Agent
and Bug-Fix Cycle** (§1–§16). Nothing was committed, pushed or deployed. No secret, token, Hyperdrive, cron or
access-gate value was read, printed or changed.

---

## 1. Baseline and working tree

Audit started from the working tree as truth (not from a commit or from memory).

| | value |
| --- | --- |
| HEAD at baseline | `354edaae` |
| `git status --porcelain` at the end of the round | **29 modified, 24 untracked** |
| Untracked at baseline / now | 13 → 24 (the 11 additions are this round's files: agent, post service, post port, both their tests, `0037`, `0038`, the domain template/banner modules and their test, the working inventory) |
| Pre-existing changes preserved | yes — every one of the 25 files that were modified before this round is still modified, none reverted; `apps/worker-cf/` remains untracked and untouched, deliberately not "tidied" into git |

`tools/probe.mts` (scratch) was deleted before this report. Two more scratch probes lived in `/tmp` only.

---

## 2. Journal / checklist / stats rules that were kept in force

- **UNREVIEWED ≠ UNKNOWN ≠ a mistake.** Coverage sentences report recorded states; they never call a gap an
  error, and a truncated read says so (`/checklist coverage [N]`, capped, discloses the cap).
- **An invalid date never becomes "today".** `/post ۱۴۰۵-۱۳-۰۱`, an unreadable window, or an ambiguous day is
  refused with the reason; the day is *only* ever resolved by the shared chat-date contract
  (`readLeadingChatDate` + `journal.parseReportDateArg`), which `/stats`, `/checklist` and now `/post` all use.
- **Stored `occurred_close_at_utc` / `report_date` are never rewritten** to make a query or a card work; per-user
  timezone semantics live in the journal service, and the post path reads them through it (`todayInUserZone`
  was made public for exactly that reason — one rule, not two).
- **Ownership, authorization, rate limit and update dedupe** are enforced where the write happens, and a Telegram
  retry of the same update is refused earlier by the update claim.

---

## 3–4. Stats, dates, media and labelling

`/stats` keeps its `today|yesterday|week|all` + specific-date grammar with Jalali support, and a bounded read is
labelled as sampled in the post too — the sampled note is a **template value** (`stats.sampled`), so a published
card cannot present a bounded sample as a whole-history fact. AI interpretation is a separate labelled field
(`PreviewRequest.analysis`), never merged into recorded data. Voice / image / chart screenshot go through the
existing interpreter + AI Manager + feature guard + anonymization; where the runtime has no capability, the reply
says the capability is unavailable. Nothing fabricated: no invented OCR text, candles, prices, or "success".

---

## 5. Channel publishing (first-class, in the existing bot)

Reused: `telegram_channels` (0023), the bound-channel verification flow (`getMe` / `getChat` / `getChatMember`),
the existing `telegram:channel` rate-limit key, `sendPhoto` + caption budget, `clamp`, `safeSend`, `esc`.
Added: the outbox (`0037`), the `STANDBY` state (`0038`), `TelegramPostService`, and `/channel list` /
`/channel use <chat id>`.

Publishing flow: **preview → row in `DRAFT` → approval tap → claim → send → `PUBLISHED`/`FAILED`**.

Safety properties, each pinned by a test:
- The destination is the post row's `chat_id`, resolved from the user's own bindings. An id present in a message
  or a button is a *candidate* that must pass the owner check; `/channel use` can only select an already-verified
  row and never binds a new one.
- **Permissions are re-read at send time**, not only at preview: `blockedReason()` re-calls `getChatMember` after
  the row is claimed, so a bot removed from the channel between preview and approval is refused
  (`CHANNEL_UNVERIFIED`) instead of discovering it remotely.
- Duplicate prevention: `UNIQUE (user_id, dedupe_key)`, a claim that only accepts `status IN (…)` with
  `attempts < maxAttempts` (clamped 1..5), `already-published` and `in-flight` as distinct answers, and a row
  stuck in `PUBLISHING` reported as "may already be posted" — never auto-retried.
- The private-test access gate was not weakened; no token or private id is echoed anywhere (the log line carries
  the outcome and nothing else).
- Failure handling: a send failure records `FAILED` + the code + `retry_after_seconds`, and the user is told
  whether a retry is sensible.

---

## 6. Template Studio

`/template` list · `/template save <name> <body>` · `/template delete <name>`; `{{placeholder}}` only.

- Single-pass substitution over the **original** body, so a value that looks like a token is never re-scanned
  (`renderTemplate("A {{symbol}} B", {symbol:"{{notes}}", notes:"SAFE"}) === "A {{notes}} B"`, byte-pinned).
- **Unknown placeholders do not vanish**: they stay in the text verbatim and are reported
  (`postUnknownFields`), and a known field with no value renders `— ثبت نشد` / `— not recorded` and is listed in
  `gaps`. `0` is a reading; absence is absence.
- `{{1+1}}` and any non-name shape are reported as `unsupported` and **never evaluated**; the save path refuses
  such a body outright and writes nothing. No expressions, no code execution, no `eval`.
- Limits: 8 000-char body, Telegram's 4 096 / 1 024 budgets applied at render time with a re-cut that measures
  balanced markup (truncation cannot emit a broken tag), tag whitelist, `href` refused unless https **and** on
  the allowlist (label kept).
- Versioned append-only with `expectedVersion` → `{status:"conflict", current}`; a retired name is reusable.
- Bilingual; the schema it needed was one table (`telegram_post_templates`), not a second service.
- Fill from real sources: the checklist of the named day, `/stats` for the window, one trade, the user's own
  note; AI text only as a labelled `analysis` value. Preview → publish only after the explicit tap on the final
  content.

---

## 7. The two polished built-ins

`velora.bias` (Trading Bias card) and `velora.setup` (Checklist / Setup card), plus `velora.weekly` for the
window view. Every field is a real one: `date`, `symbol`, `timeframe`, `dailyBias`, `marketLeg`, `priceLocation`,
`pdArrayH4`, `pdArrayH1`, `pdArrayM15`, `m1Cisd`, `smt`, `macroTiming`, `stopLoss`, `risk`, `checklist.*`,
`stats.*`, `notes`, `link`. RTL for Persian with Latin digits, Velora identity (SVG banner: card `#0e1626`,
gold `#d4af37`, gain `#4ade80`, loss `#f87171`, 1080 px wide, height derived from the rows so contrast and
typography survive as an image). The banner is bound to the draft it belongs to (`banner_svg` on the post row) and
its `rowsShown`/`rowsDropped`/`truncatedValues` are reported, not hidden.

**Rasterization is blocked in this environment** — see §14. The SVG is stored as the artwork source, delivery
degrades to the text card, and the bot says so (`postNoBanner` / `postBannerPreview`) instead of inventing an
image reference.

---

## 8. Keyboards and links

Two callback actions added, both keyed by the **post id** — never a Persian template name (the grammar is
`[A-Za-z0-9_-]{1,48}`) and never a chat id: `post_pub:<postId>` (approve+publish this exact content) and
`post_no:<postId>` (dismiss, writes nothing). Buttons obey the same authorization as commands: the tapper's
identity is resolved and the row is read through `findPost(userId, postId)`, so a valid id in somebody else's
hand yields `genericError` and no send. A keyboard is attached **only** when `blockedReason === null`, so there is
never a button whose action can only fail. Menu gains "📤 Channel post" **only when the post service is wired**
(`MENU_TARGETS` + its handler were extended together; the existing "every minted button has a case" test guards
that). Links: the only URL-bearing buttons are ones this bot mints from `appUrl` (https, single parsed host);
template text cannot introduce a destination. Telegram is not, and is not claimed to be, blind to the text —
`sendPhoto` only accepts a `file_id` or an https URL, enforced in the transport.

---

## 9. Natural-language agent

`telegramAgent.ts` — **deterministic, no provider call**, so it behaves identically in the API process, a Worker
and a test, and `/help` can promise it.

`TOOL_REGISTRY` (11): `stats.read`, `checklist.read`, `checklist.gaps`, `journal.draft`, `template.list`,
`post.prepare`, `post.publish`, `channel.status`, `channel.select`, and the two declared-blocked rows
`web.search → NO_WEB_PROVIDER`, `chart.capture → NO_BROWSER_AUTOMATION`. Read-only steps first
(`effect:"read"`), `effect:"external"` structurally **implies** `requiresApproval: true` (asserted in tests).

Routing precedence is a decision, not a heuristic: **a verb that changes the world outranks a noun that
describes one** (publish/select 30 > prepare 25 > gaps 20 > plain read 10 > blocked 5), so "publish it now, the
checklist stats look good" is a publish question, not a stats answer.

Integration rule that matters most: the agent runs **after** the journal parser has said "there is nothing here to
file", and it executes only by calling the bot's own command handlers. So it can neither steal a journal entry nor
be a wider door than the command surface. A bare "publish it" without a post id returns the one question it needs
(`ambiguous → candidates:["postId"]`) and never an invented id.

`validateArgs` enforces per-schema bounds (`days` 1..366, enum membership, strings ≤ 500) and **drops unknown
keys**, so a sentence that names `userId`, `chatId` or `token` cannot put them into a store call. Timeouts and
bounded retries live in the transport and the claim (≤5 attempts, `retry_after_seconds`); per-user cost control is
the existing `telegram:analyze` / `telegram:journal` / `telegram:channel` budgets. Approval is required for
publishing, third-party sending, data modification, permission changes and irreversible actions; **live trade
execution is not in the registry at all**. Partial completion is stated as such.

---

## 10. `/help`

Built per runtime: media lines come from the interpreter the process was constructed with, and the post/template/
channel lines appear **only** when `deps.posts !== undefined`. The blocked capabilities are named as absent inside
the help text rather than advertised or silently omitted. Bilingual, existing keyboard conventions untouched.

---

## 11–12. Preserve / reuse constraints

L3 `Promise.all` overlap and its justification were left as they were (bench: −313.6 ms, `bfd1f09c @100 %`); no
gate, rate limit or ownership check was loosened; **no Worker deployment state was touched**. All new persistence
went through the existing PG + migration conventions (append-only 0037, a widening 0038) and reused the existing
models and services — no parallel service, no second AI egress path, no D1 growth, no real user data modified for
convenience. `TelegramPostService` reads user data through a `PostDataPort` bridged to `JournalApplicationService`
(`telegramPostPort.ts`) precisely so a published post cannot disagree with the journal.

---

## 13. Tests — what was run, and what it caught

Commands (all from `velora-modern/`):

```
TZ="Asia/Tehran" node node_modules/tsx/dist/cli.mjs --test apps/api/src/telegram/*.test.ts \
    db/tests/telegramStoreAdapter.test.ts db/tests/migrations.test.ts        → 202 tests, 202 pass, 0 fail
TZ="Asia/Tehran" node node_modules/tsx/dist/cli.mjs --test <each file>        per file:
    apps/api/src/telegram/telegramBot.test.ts            69 pass 0 fail   (12 new post/template/agent tests)
    apps/api/src/telegram/telegramPostService.test.ts    22 pass 0 fail
    apps/api/src/telegram/telegramAgent.test.ts          10 pass 0 fail
    apps/api/src/telegram/telegramApi.test.ts            14 pass 0 fail
    apps/api/src/telegram/telegramUpdatePipeline.test.ts  8 pass 0 fail
    packages/domain/src/telegramTemplates.test.ts        27 pass 0 fail
    packages/contracts/src/telegramCallback.test.ts       3 pass 0 fail
    db/tests/migrations.test.ts                            22 pass 0 fail  (0037 battery + new 0038 test)
    db/tests/telegramJournal.test.ts                        8 pass 0 fail  (PGlite batch)
    db/tests/telegramStoreAdapter.test.ts                   9 pass 0 fail
./node_modules/.bin/tsc -b packages/domain packages/contracts apps/api --force   clean
npm test   general batch: tests 1657 · pass 1656 · fail 1
           PGlite batch:  tests   81 · pass   81 · fail 0
```

Coverage added deliberately included the hostile cases: wrong-owner button, rate-limited publish, re-delivered
update, unknown/unsupported/oversized template input, untrusted template markup, expression body, dismissed
preview, selection of an unbound channel, empty journal answering as "empty", and the blocked capability
answering as a refusal.

**No test was weakened, narrowed, skipped or deleted to make the suite pass.** The only test-file edits that look
like that were: renaming fixtures for the `netR→averageR` field rename, `todayFor` becoming `async` because the
port signature had to be, adding the two new callback subjects to the contracts battery (the test *requires* a
subject per action — it failed until one was supplied), and extending 0023's exact table list with the two tables
0037 legitimately added.

---

## 14. Bugs found and fixed (all real, all in code paths a user reaches)

1. **`isAllowedLink(url, [])` returned `true`** — an unset allowlist permitted *every* https host. A user template
   containing `<a href="https://evil.example/steal">click</a>` would have been published as a live phishing link
   in the user's own channel. Empty now means "nothing permitted", and `renderTemplate` forwards the configured
   hosts to the sanitizer instead of trusting the default. Pinned by a new domain test.
2. **`builtinTemplate(word) !== undefined`** in `/post` — that function returns `null`, so every non-built-in
   word was treated as a built-in id and a saved template could never be named. Fixed + comment.
3. **A bare `/post` threw `TEMPLATE_NOT_FOUND`** instead of opening the default card. The default
   (`velora.bias`) now lives in the command surface; `preview()` still refuses an unresolvable name, so explicit
   callers keep their refusal.
4. **`values["date"]` assigned inside `if (checklist !== null)`** — a post about a day the user never filed
   printed "date: not recorded" for a date they had literally typed. Moved out of the branch.
5. **`{{time}}` in the built-in cards** could only ever render "not recorded" (a trade's only time is a UTC
   instant; under a local "Time" label that is a wrong clock, not a missing one) — removed from the two built-ins,
   kept as a field a user may name.
6. **Template fields `netR` / `bestR` / `worstR` named metrics that do not exist** in the data layer → renamed to
   `averageR` / `bestTrade` / `worstTrade`, matching the words `/stats` itself uses, so no fabricated figure can
   ride a plausible name into a public post.
7. **`publish` did not re-check Telegram-side permission at send time** (found by the service suite: a send
   happened while `memberStatus = "left"`) → post-claim `blockedReason(channel)` re-read.
8. **`chat_id > 0` CHECK for a Telegram destination** rejected real channel ids (negative `-100…`) → `<> 0`.
9. **0023's exact-table-list test** still expected six tables after 0037 added two — visible only in the repo's
   own full runner, the second time that runner caught what a filtered run could not.
10. `TelegramChannelRecord` import path, the memory store's `outbox` field name, and three authored regex/typo
    defects in the agent (an unescaped `/` inside a regex literal, a stray Cyrillic `о`, Korean glyphs) — caught
    by `tsc` before any of them shipped.

---

## 15. Changed files, by purpose

| Purpose | Files |
| --- | --- |
| Templates + banner rendering (domain) | `packages/domain/src/telegramTemplates.ts`, `bannerRender.ts`, `index.ts`, `telegramTemplates.test.ts` |
| Publishing service + data port | `apps/api/src/telegram/telegramPostService.ts` (+ `.test.ts`), `telegramPostPort.ts` |
| Deterministic agent | `apps/api/src/telegram/telegramAgent.ts` (+ `.test.ts`) |
| Bot surface (commands, buttons, prose, help, menu) | `telegramBot.ts`, `telegramCopy.ts`, `telegramBot.test.ts` |
| Transport | `telegramApi.ts` (+ `.test.ts`) — `sendPhoto`, `isSendablePhotoRef`, caption limit |
| Ports + adapters | `telegramStore.ts`, `pgTelegramStore.ts`, `memoryTelegramStore.ts`, `db/tests/telegramStoreAdapter.test.ts` |
| Schema | `db/migrations/0037_telegram_post_templates.sql`, `0038_telegram_channel_standby.sql`, `db/tests/migrations.test.ts`, `db/tests/telegramJournal.test.ts`, `db/MIGRATION_MAP.md` |
| Contracts | `packages/contracts/src/telegram.ts` (2 actions, `post` menu target), `telegramCallback.test.ts` |
| Wiring | `apps/api/src/telegram/telegramProcessorFactory.ts`, `apps/api/src/journal/journalApplicationService.ts` (one method made public) |
| Docs | `docs/state/WORKING-INVENTORY-telegram-full-product.md`, `docs/state/CHANGE_LOG.md`, this report |

**DB changes:** two forward-only migrations, as above. `0038` is a widening of one CHECK plus one new CHECK; no
row is rewritten, no backfill, no destructive test, no real user data touched.

---

## 16. Blocked, unavailable, and unverified — stated plainly

| Capability | Status | Exact missing dependency / reason |
| --- | --- | --- |
| Rasterized banner image (SVG → PNG upload) | **BLOCKED** | No rasterizer in either runtime: no `sharp`/`resvg`/`svgexport` installable here, and `sendPhoto` accepts only a `file_id` or an https URL. `BannerSink` therefore has **no shipping implementation**; the SVG is stored on the post row and delivery degrades to the text card, which the bot says out loud. |
| Browser automation / chart capture | **BLOCKED** | No headless browser (Playwright/Puppeteer) and no install path in the sandbox. `chart.capture → NO_BROWSER_AUTOMATION` is a declared, refused tool — not a silent fallback. |
| Web search | **BLOCKED** | No search provider configured; adding one would be a second, ungoverned egress path. `web.search → NO_WEB_PROVIDER`. |
| Voice / image AI transcription in a post | **DEGRADED, honest** | `UnconfiguredMediaInterpreter` in this environment ⇒ the media path reports "not enabled here"; the original screenshot stays the source artifact and any AI layer is a separate labelled value. |
| Real Bot API delivery (a live publish into a channel) | **NOT VERIFIED** | No bot token in this environment by design. All send assertions run against the recording fake, which enforces the same local guards (caption budget, unsendable ref). |
| PostgreSQL behaviour | **VERIFIED for schema, not for the adapter's runtime SQL** | The PGlite batch (81) covers the migrations and constraints; the two adapters are exercised by `telegramStoreAdapter.test.ts` (9) and the memory adapter by the service suite. A live Neon run of the new outbox statements was not performed this round. |
| OCR test | **ENVIRONMENTAL FAILURE** | `tesseract` binary absent (`/usr/bin`, `/usr/local/bin`, `PATH` checked; `apt-get` is not available). Not a code defect; the test was not weakened. |
| Worker / deployment | **NOT TOUCHED** | No deployment, no config change, `apps/worker-cf/` left untracked as found. |
| Publish auditing (`AuditAction`) | **DOCUMENTED GAP** | `AuditAction` has no `JOURNAL_CHECKLIST_SAVED`-style publish entry and the journal service exposes no `AuditWrite` hook, so a publish is logged via `deps.log` (event + outcome only) rather than into `audit_log`. Closing it means widening audit vocabulary in another owner's table — deliberately not improvised here. |

**Done-criteria check.** Every capability in §3–§10 is either implemented and tested to the limit of this
environment, or listed above with the exact missing dependency. No command, button or help line is claimed as a
completed feature on its own. Nothing was committed or pushed, and no deployment state changed.
