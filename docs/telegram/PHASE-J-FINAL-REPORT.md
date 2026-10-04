# §39 — Final report: Telegram Journal Client

**Date:** 2026-10-04 (Asia/Tehran)
**Branch:** `feat/telegram-journal-client`
**Base:** `main` @ `0e9c4d7e6e1f984287490ce02f5681c208e35c7a`
**Branch HEAD at the time of this evidence:** `e6d861a5c3c62bedcfc42daa0dc73efb1263dc01` (plus the state commit carrying this file)
**Decision record:** `docs/adr/ADR-018-telegram-journal-client.md`

This report separates six things that are routinely conflated. Read the status
word before the sentence that follows it.

| Status | Meaning in this report |
|---|---|
| **IMPLEMENTED** | the code exists in this tree and typechecks |
| **TESTED** | an automated suite in this repository exercises it, and the result is recorded below |
| **COMMITTED** | it is in a git commit on the branch named above |
| **PUSHED** | it is on the remote — **no** |
| **DEPLOYED** | it runs somewhere outside this sandbox — **no** |
| **VERIFIED** | it was observed working against the real external service — **no** |

---

## 1. Status summary

| Area | IMPLEMENTED | TESTED | COMMITTED | PUSHED | DEPLOYED | VERIFIED (live) |
|---|---|---|---|---|---|---|
| Telegram identity + linking model | yes | yes | yes | **no** | **no** | **no** |
| Migration `0023` + DB constraints | yes | yes (PGlite) | yes | **no** | **no** | **no** (real-PG concurrency unproven) |
| Bot surface, commands, menus, confirmation card | yes | yes | yes | **no** | **no** | **no** (no live bot) |
| Text / voice / screenshot journal paths | yes | yes | yes | **no** | **no** | **no** (voice/image need a provider credential) |
| AI boundary (analysis, transcription, image reading) | yes | yes | yes | **no** | **no** | **no** (no provider credential) |
| Web Settings → Telegram (website-first linking) | yes | build + typecheck | yes | **no** | **no** | **no** |
| Update stream (webhook **and** polling) | yes | yes | yes | **no** | **no** | **no** (no delivered webhook) |
| Rate limits, audit trail, error handling | yes | yes | yes | **no** | **no** | **no** |
| Operator documentation + gap register | yes | n/a | yes | **no** | n/a | n/a |

**Nothing in this work was pushed, merged, deployed or exercised against a live
Telegram or Gemini service.** No production claim is made anywhere in this
report, in the ADR, or in `docs/telegram/**`.

---

## 2. What was built (IMPLEMENTED)

**One client, not a parallel system.** Telegram uses the existing users table,
the existing bearer auth, the existing PostgreSQL schema, the existing journal
domain and the existing AI governance. A journal confirmed in Telegram is a
`trades` row written through `TradeService` (ADR-002 ledger) and is visible in the
web app immediately; a trade created on the web appears in `/last` and `/history`.

| Commit | Subject | Contents |
|---|---|---|
| `e0887afc59a7dd9ad38d78fc47e0e644510bf04c` | `feat(telegram): decision record, migration 0023 and the domain foundation` | ADR-018; `0023_telegram_journal.sql` (6 tables, widened audit vocabulary, `ai_coaching_logs.feature`); `packages/contracts/src/telegram.ts`; `packages/domain/src/{telegramLinking,journalExtraction}.ts`; `time.ts#wallClockIn`; 5 `telegram:*` rate-limit keys |
| `55ac1e4512b08481e033115247a437df810dc1e8` | `feat(telegram): bot, update pipeline, linking service, HTTP surface and AI seam` | `config` / `api` / `store` (+`pg`,`memory` adapters) / `linkService` / `bot` / `pipeline` / `poller` / `routes`; `journal/{application,analysis}Service`; `aicoach/{mediaInterpreter,geminiProvider}`; the 3 wiring edits + audit vocabulary widening |
| `745d6418e888c89d48a2b75f40f9855a07457c57` | `test(db): migration 0023 constraints and the real PgTelegramStore statements` | two PGlite batteries |
| `e8d8d045b103c08dc56e0ad7f8b8364f9c17e18d` | `feat(web): Settings -> Telegram connection (website-first linking)` | the Settings screen, `telegram.json` catalogs (fa/en, 42 keys each), sidebar entry, resource functions |
| `e6d861a5c3c62bedcfc42daa0dc73efb1263dc01` | `docs(telegram): operator guide, design map and security notes` | `docs/telegram/{DEPLOYMENT,README,SECURITY}.md` |

Deliberately **not** built, and recorded as decisions rather than omissions:
`journal_entries` table, a second auth system, a separate Telegram database, an
n8n relay transport (it does not exist in Modern — `MG-TG-2`), a second update
consumer, and any worker/queue path (`apps/worker` is undeployed — `MG-TG-3`).

---

## 3. What was proven (TESTED)

`node tools/run-tests.mjs` → **945 tests, 945 passed, 0 failed, 0 cancelled,
0 skipped**, ~180 s. Baseline on this branch before the Phase F batteries was
**851/851**; the delta is the batteries below. `npm run typecheck` → **exit 0**
(5 projects). `bash tools/secret-scan.sh` → **PASS (0 findings)**. `npx next build`
→ **exit 0** with `/settings` and `/en/settings` in the route table.

| Suite | Tests | What it pins |
|---|---|---|
| `packages/domain/src/telegramLinking.test.ts` | 19 | linking state machine, admission rules, token shape |
| `packages/domain/src/journalExtraction.test.ts` | 22 | Persian/English parsing, stop-loss keyword ambiguity, no invented fields |
| `apps/api/src/telegram/telegramLinkService.test.ts` | 11 | deep-link opacity, stored-hash-only, replay, expiry-before-collision, both collision rules, every status state |
| `apps/api/src/telegram/telegramBot.test.ts` | 12 | token-free onboarding, one question at a time, duplicate `update_id`, forged/foreign/stale callbacks, private-chat channel refusal |
| `apps/api/src/telegram/telegramRoutes.test.ts` | 9 | ingress order (503→405→401→400→409), `/status`, link start + 429, unlink 409, channel DELETE |
| `apps/api/src/telegram/telegramPoller.test.ts` | 9 | offset discipline, failed-update redelivery, `CONFLICT` backoff, mode mismatch, claim-before-answer |
| `apps/api/src/telegram/telegramApi.test.ts` | 10 | token absent from every error/stack/URL, failure classification, download cap, posting-rights truth table |
| `apps/api/src/telegram/telegramConfig.test.ts` | 7 | fail-closed resolution, redaction, per-capability degradation, mode gates |
| `apps/api/src/journal/journalApplicationService.test.ts` | 10 | no write before confirmation, missing fields reported not invented, exactly one trade, TTL/cancel/reuse |
| `apps/api/src/journal/journalAnalysisService.test.ts` | 6 | `notes` never leave, bounded sample, `coach` tagging, refusals forwarded |
| `apps/api/src/aicoach/mediaInterpreter.test.ts` | 8 | fails closed with no credential, transcript count only, prose → `EMPTY_RESULT`, key never in URL/data/error |
| `apps/api/src/aicoach/geminiProvider.test.ts` | 5 | key never in URL/body/errors, `UNPARSEABLE_OUTPUT` for prose, classified failures without body echo |
| `db/tests/telegramJournal.test.ts` | 6 | migration constraints, widened vocabularies (PGlite) |
| `db/tests/telegramStoreAdapter.test.ts` | 7 | the real `PgTelegramStore` statements — claims, single-use tokens, ownership scoping (PGlite) |

**Defects the tests found and fixed** (the reason the batteries are not theatre):
the poller reset its backoff after a successful *read* even when the batch then
threw (a permanently failing update was retried once a second, forever); the
analysis payload's declared sample bound was unreachable (`history()` clamps to
20); the pipeline reported the update-id string as the update `kind`; and the
poller bypassed schema validation entirely, so a schema-invalid update would have
stalled the stream forever while the offset refused to move.

---

## 4. What was committed (COMMITTED)

Six commits on `feat/telegram-journal-client`, working tree clean at the time of
writing, each with a message that states what it proves. Branch HEAD:
`e6d861a5c3c62bedcfc42daa0dc73efb1263dc01` (before the state commit that carries
this report; `git log -1` is authoritative).

`docs/state/CHANGE_LOG.md` **AC-9** records all of it, including the two facts a
future session must not misread:

- `current_verified.modern_sha` is **unchanged** at `ab0eed7…` — it records `main`,
  and none of this is on `main`;
- `tools/agent-context.mjs` reports **`DRIFTED`** while this branch is checked out.
  That is the tool working correctly, not a state defect.

---

## 5. What was NOT done (PUSHED / DEPLOYED)

- **PUSHED: no.** No `git push`, no remote branch, no pull request. The branch
  exists only in this workspace.
- **DEPLOYED: no.** No Railway service was created or reconfigured; no
  `setWebhook` was called; no environment variable was set anywhere; the API was
  never started outside a test harness.
- **VERIFIED against live services: no.** See §6.

---

## 6. What remains UNVERIFIED (be explicit)

| Claim | Why it is unverified | What would close it |
|---|---|---|
| A real Telegram user journals and sees it in the web journal | no bot token in scope | owner supplies `TELEGRAM_BOT_TOKEN`; run the bot; confirm a trade in both clients |
| A real Telegram webhook is delivered and accepted | needs a deployed public HTTPS endpoint | deploy + `setWebhook` + `getWebhookInfo` |
| A real voice note is transcribed | no provider credential | set `GEMINI_API_KEY`; send a voice note |
| A real screenshot is read | no provider credential | as above |
| A real journal analysis is produced | no provider credential | as above (`GEMINI_API_KEY`) |
| Two sessions racing a link token / a draft claim | PGlite is single-session | run the statements concurrently against a real PostgreSQL 16 |
| The n8n relay transport | does not exist in Modern | owner decision (`MG-TG-2`) |
| Worker/queue processing of Telegram work | worker undeployed | MG-WORKER-DEPLOY (`MG-TG-3`) |

`docs/telegram/DEPLOYMENT.md` §7 carries the same list for operators; the gap
register carries it as `MG-TG-1`, `MG-TG-2`, `MG-TG-3` (totals: **31 OPEN /
16 PARTIAL / 6 CLOSED = 53**).

---

## 7. Deployment requirements (what an operator must supply)

Exactly five secrets/values, and the fail-closed rules that keep a partial
configuration from pretending to work:

| Variable | Needed for | If missing |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | everything | whole surface answers `503`; `/health`, `/ready` stay green |
| `TELEGRAM_BOT_USERNAME` | deep links | linking disabled, text journalling still works |
| `TELEGRAM_WEBHOOK_SECRET` | webhook ingress | ingress disabled (`TG-004`) |
| `VELORA_APP_URL` (or `APP_ORIGIN`) | link URL | `TG-005`, linking disabled |
| `TELEGRAM_UPDATE_MODE` | stream choice | `TG-006`; `polling` in production → `TG-007`, capability off |
| `GEMINI_API_KEY` | voice, screenshots, analysis | those features refuse with a clear message; text journalling unaffected |

Production consumes by **webhook** (polling is refused when `APP_ENV=production`),
and exactly one consumer may exist per bot. Full runbook:
`docs/telegram/DEPLOYMENT.md`.

---

## 8. Definition of done — against the original criteria

| Criterion | State |
|---|---|
| Telegram bot with the specified menu and commands | IMPLEMENTED, TESTED, COMMITTED |
| Telegram identity model (numeric id is the identity; username cosmetic) | IMPLEMENTED, TESTED, COMMITTED |
| Secure linking: one-time token, expiry, replay protection | IMPLEMENTED, TESTED (incl. PGlite), COMMITTED |
| Telegram-first onboarding with `[ 🔐 اتصال امن به Velora ]` | IMPLEMENTED, TESTED, COMMITTED |
| Website-first linking via Settings → Telegram | IMPLEMENTED, build-verified, COMMITTED |
| Ownership enforced; no client-supplied ids | IMPLEMENTED, TESTED, COMMITTED |
| Journal domain integrated (same journal both clients) | IMPLEMENTED, TESTED, COMMITTED |
| Text / voice / screenshot paths | IMPLEMENTED, TESTED with a scripted provider; **live paths UNVERIFIED** |
| AI through the existing architecture; AI cannot mutate financial records | IMPLEMENTED, TESTED, COMMITTED |
| Idempotency for repeated Telegram updates | IMPLEMENTED, TESTED (unit + PGlite), COMMITTED |
| Rate limits | IMPLEMENTED, TESTED, COMMITTED |
| Error handling for every class (DB, Telegram API, expired token, AI, malformed, rate limit, timeout, unauthorized) | IMPLEMENTED, TESTED, COMMITTED |
| Security checks (no secret in logs; no credential via chat; non-disclosure) | IMPLEMENTED, TESTED; `secret-scan` PASS |
| Migration verified | PGlite-verified (constraints + adapter); **real-PostgreSQL run NOT executed in this session** |
| Tests added; existing tests green | 945/945, 0 failed, 0 skipped |
| Docs updated | ADR-018, `docs/telegram/**`, `CHANGE_LOG` AC-9, gap rows, `CURRENT_STATE` §2a |
| Deployment requirements documented | `docs/telegram/DEPLOYMENT.md` |
| PUSH / DEPLOY / live verification | **not done — deliberately, and not claimed** |
