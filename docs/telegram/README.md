# Telegram Journal Client — design map

Decision record: `docs/adr/ADR-018-telegram-journal-client.md`.
Operator guide (configuration, modes, deployment, what is not verified):
`docs/telegram/DEPLOYMENT.md`.

This file is the **map**: which module owns which invariant, and why the code is
shaped the way it is. Every claim here is checkable in the named file.

---

## 1. Where the code lives

| Module | Owns | Notes |
|---|---|---|
| `db/migrations/0023_telegram_journal.sql` | 6 tables + widened audit vocabulary | additive; no new append-only table, so no new REVOKE |
| `packages/contracts/src/telegram.ts` | paths, states, callback vocabulary, `classifyUpdate()`, `telegramDeepLink()` | the frozen boundary both sides read |
| `packages/domain/src/telegramLinking.ts` | linking state machine, admission rules, token shape | IO-free, framework-free |
| `packages/domain/src/journalExtraction.ts` | deterministic text → draft (+ missing fields) | no model call, no invention |
| `apps/api/src/telegram/telegramConfig.ts` | fail-closed env resolution, findings `TG-001…TG-007`, secret holder | redacts in `String()`/`JSON.stringify()` |
| `apps/api/src/telegram/telegramApi.ts` | the only module that speaks to `api.telegram.org` | bounded timeouts, bounded download, typed failures |
| `apps/api/src/telegram/telegramStore.ts` (+ `pg`/`memory` adapters) | the persistence PORT | the atomic claims live in the `pg` adapter |
| `apps/api/src/telegram/telegramLinkService.ts` | one-time token, both link directions, state resolution | one live link per identity *and* per account |
| `apps/api/src/telegram/telegramBot.ts` | every user-visible decision | never resolves a user itself |
| `apps/api/src/telegram/telegramUpdatePipeline.ts` | parse → mode gate → claim → dispatch | one path for webhook and polling |
| `apps/api/src/telegram/telegramPoller.ts` | the development consumer | offset discipline + backoff |
| `apps/api/src/telegram/telegramRoutes.ts` | HTTP surface (ingress + authenticated) | identity from `claims.sub` only |
| `apps/api/src/journal/journalApplicationService.ts` | drafts → confirmed trades, `latest`/`history` | client-agnostic: **not** under `telegram/` |
| `apps/api/src/journal/journalAnalysisService.ts` | facts → existing AI coaching pipeline | excludes `notes`; bounded sample |
| `apps/api/src/aicoach/mediaInterpreter.ts` | voice/image interpretation | default **fails closed** |
| `apps/api/src/aicoach/geminiProvider.ts` | the provider transport | key in a header only |
| `apps/web/src/app/(app)/settings/page.tsx` | website-first linking UI | six states, no optimistic "connected" |

The journal modules deliberately sit **outside** `telegram/`: the web journal and
the Telegram journal are the same journal, and putting the shared layer inside one
client's directory would invite a second one later.

---

## 2. The invariants, and where each is enforced

| Invariant | Enforced by |
|---|---|
| One row per Telegram update; a redelivery is a duplicate, not a second effect | `telegram_updates.update_id` PK + `claimUpdate` (`INSERT … ON CONFLICT DO NOTHING RETURNING`) |
| A link token is single-use and expires | `consumeLinkToken`: `UPDATE … WHERE status='PENDING' AND expires_at > now() RETURNING` — one statement, no read-then-write |
| One live link per Telegram identity, one per Velora account | two partial unique indexes on `telegram_identities`; the adapter maps the constraint NAME to `IDENTITY_TAKEN` / `ACCOUNT_TAKEN` |
| A user cannot unlink someone else | `revokeIdentity(userId, identityId)` predicate; a guessed id removes nothing |
| No client-supplied authorisation | every authenticated route resolves identity from `claims.sub`; no route accepts a user/account/Telegram id |
| Confirmation writes exactly once | `claimDraftForConfirmation` (actionable → `CONFIRMING`) then `markDraftConfirmed` (only from `CONFIRMING`) |
| `CONFIRMED` implies a real trade | FK on `confirmed_trade_id` + `UNIQUE (telegram_user_id, source_message_id)` |
| The mirror cannot post twice, or post a foreign trade | `UNIQUE (channel_id, trade_id)` + composite FK to the owning user's trade |
| A channel is only bound after the server verified posting rights | `getChatMember` for the **bot's** id; `canPostMessages` for channel/supergroup, membership for group |
| One consumer per update stream | mode gate in the resolver (`TG-007`), `409` in the ingress, poller mode mismatch stop |
| Missing values are never invented | `journalExtraction` reports `missingRequired`; the AI prompt says "do not guess" and returns `null` |
| AI cannot mutate a financial record | `JournalApplicationService` is the only writer (via `TradeService`); analysis has no writer at all |
| No credential in a log, an error or a URL anyone else sees | secret holder + fixed error text; asserted by `telegramApi.test.ts` and `geminiProvider.test.ts` |

---

## 3. Two ways to be a client, one journal

```
Telegram user ──► Bot API ──► [webhook ingress | poller] ──► TelegramUpdatePipeline
                                                                    │
                                                          TelegramBot.handleUpdate
                                                    (claim → process → record outcome)
                                                                    │
                    ┌───────────────┬────────────────┬──────────────┴───────────┐
              TelegramLinkService  JournalApplicationService        JournalAnalysisService
                    │                    │                                  │
             telegram_identities,   TradeService (ADR-002 ledger)      AiCoachService
             telegram_link_tokens   → trades / trade_events →         (consent, bound,
                    │                 the SAME journal the web shows   ledger, validate)
                    └────► verification via getChatMember                   │
```

Web app ──► `/api/v1/telegram/*` (bearer) ──► same services, same rows.
A trade confirmed in Telegram is visible in the web journal; a trade created on
the web appears in `/last` and `/history`.

---

## 4. UX contract (the bot is a professional tool, not a toy)

- Menu: 📝 New Journal · 📊 Last Trade · 📚 Journal History · 🧠 Analyze · ⚙️ Settings.
- Commands: `/start` `/help` `/journal` `/last` `/history` `/analyze` `/settings`
  `/link` `/unlink` `/channel`.
- Confirmation card: `[تأیید][ویرایش][لغو]`; the draft is re-rendered after every
  `ویرایش`, so the user always confirms exactly what will be written.
- One question at a time: the bot asks for the single most valuable missing field,
  never a wall of prompts.
- Analysis answers carry a disclaimer and are labelled as an analysis, never as a
  trading instruction.
- Persian or English by the user's stored `users.locale` (default `fa`); numbers
  render with Latin digits as the rest of the product does.
- Errors are sentences with a next step, never codes or stack traces.

---

## 5. Evidence

| Battery | What it proves |
|---|---|
| `packages/domain/src/telegramLinking.test.ts` (19), `journalExtraction.test.ts` (22) | the state machine and the parser, including Persian number handling and stop-loss keyword ambiguity |
| `apps/api/src/telegram/telegramLinkService.test.ts` (11) | deep-link opacity, stored-hash-only, replay, expiry, both collision rules, every `status()` state |
| `apps/api/src/telegram/telegramBot.test.ts` (12) | token-free onboarding, one question at a time, duplicate `update_id`, forged/foreign/stale callbacks, private-chat channel refusal |
| `apps/api/src/telegram/telegramRoutes.test.ts` (9) | ingress auth order (503/405/401/400/409), `/status`, link start + rate limit, unlink mapping, channel DELETE |
| `apps/api/src/telegram/telegramPoller.test.ts` (9) | offset discipline, a failed update staying in the window, `CONFLICT` backoff, mode mismatch, claim-before-answer |
| `apps/api/src/telegram/telegramApi.test.ts` (10) | token never in an error/stack/URL, failure classification, download cap, posting-rights truth table |
| `apps/api/src/telegram/telegramConfig.test.ts` (7) | fail-closed resolution, redaction, per-capability degradation, mode gates |
| `apps/api/src/journal/journalApplicationService.test.ts` (10) | no write before confirm, missing fields reported not invented, exactly one trade, TTL/cancel/reuse |
| `apps/api/src/journal/journalAnalysisService.test.ts` (6) | `notes` never leave, bounded sample, `coach` feature tagging, refusals forwarded |
| `apps/api/src/aicoach/mediaInterpreter.test.ts` (8) | fails closed with no credential, transcript counts only, prose → `EMPTY_RESULT`, key never in a URL/data/error |
| `db/tests/telegramJournal.test.ts` (6) | the migration's constraints and the widened audit vocabulary |
| `db/tests/telegramStoreAdapter.test.ts` (7) | the real `PgTelegramStore` statements — claims, single-use tokens, ownership scoping |

Labels: the `apps/**` and `packages/**` suites are unit/module evidence; the
`db/tests/**` suites are **PGlite** evidence (real PostgreSQL semantics, one
session) and are not real-server concurrency evidence. Nothing in this list is
production or live-service evidence — see DEPLOYMENT.md §7.
