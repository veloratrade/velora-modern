# ADR-018 — Telegram journal client (external identity + shared journal domain)

Status: **Accepted** (implemented in this change; owner review of the product copy pending)
Date: 2026-10-03
Supersedes: nothing. Extends: ADR-002 (ledger), ADR-004 (time model), ADR-005/ADR-016
(credential handling posture), ADR-007 (job semantics), ADR-008 (webhook ingestion),
ADR-009 (locale), ADR-013 (environment/origin), ADR-017 (agent-context state).

## Context

Velora Modern must expose its trading journal through a Telegram bot. The
requirement is explicit that this must **not** become a second product: one
database, one user table, one journal domain, one authentication model, one AI
architecture.

### Audit performed before this decision (read-only, at `0e9c4d7`)

| Question | Verified finding (STATIC) |
|---|---|
| Existing Journal domain? | **No standalone Journal module in either lineage.** The journal capability is the journaling surface on the ADR-002 trades ledger (`strategy`, `setup`, `emotion`, `notes`), reconciled in `docs/reconciliation/PHASE-C-INC4-JOURNAL-INVENTORY.md`. |
| Trade domain? | Yes — `trades` + `trade_events` (0001/0005), `TradeService`, `packages/domain/tradeLedger.ts`. |
| User model / auth / sessions? | `users`, `user_sessions` (0001); JWT bearer + refresh (`apps/api/src/auth/*`); RBAC roles + installation ownership (`packages/contracts/src/rbac.ts`). |
| Existing Telegram code? | **None. Zero occurrences of "Telegram" (or "تلگرام") anywhere in the repository, roadmap included.** This capability has no lineage to port. |
| Existing AI abstraction? | Yes — `apps/api/src/aicoach/aiProvider.ts` (`AiProvider` port, `openai｜gemini` vocabulary, `UnconfiguredAiProvider` that **fails closed**), `AiCoachService` governance ordering, attempt ledger `ai_coaching_logs` (0017). **No provider implementation exists** and no live provider call is proven anywhere. |
| n8n / Gemini relay? | **Not implemented in Modern.** Referenced only as a *Remote/PHP-era* transport (`docs/capability-registry.md` CAP-AI-01 `GeminiTransportInterface` direct vs `n8n_relay`). Nothing to reuse; nothing may be claimed. |
| File/media storage? | Yes — `trade_attachments` (0015, MIME whitelist JPG/PNG/WebP, ≤5 MiB, `storage_key` + sha256, no bytes in the DB), `AttachmentService` + `LocalAttachmentStorage` (StoragePort), `POST /api/v1/trades/{id}/attachments`. |
| OCR / voice transcription? | **Neither exists.** `trades:extract-screenshot` exists only as a reserved rate-limit key (C-14). `voice_session_logs` (0021) is a *metadata-only* session log for a WebSocket co-pilot that is not implemented. |
| Background jobs? | pg-boss (`apps/worker`, ADR-007, `QueuePort`, `HandlerRegistry`). **The worker is NOT deployed** — documented as an owner decision (`apps/worker/src/index.ts`, B10-a/B10-d). |
| Audit trail? | `audit_log` (0009, widened 0011/0014) — append-only, server-derived actor, `REVOKE`-enforced. |
| Rate limiting? | Fixed-window limiter over a shared store; policies frozen in `RATE_LIMIT_DEFAULTS` (C-14). |
| Idempotency conventions? | `packages/domain/src/idempotency.ts`; `webhook_events UNIQUE (source, event_id)` (ADR-008). |
| Migrations? | Forward-only `0001…0022`; **next free number is 0023**. |
| Deployment? | `railway.json` — a single API service (`migrate && server-main`). No worker service. |

## Decision

Telegram is modelled as an **external identity provider and an additional
client of the existing journal domain** — never as a parallel product.

1. **The journal stays on the ADR-002 ledger.** A journal entry created in
   Telegram is a `trades` row + `trade_events` events written through the
   existing `TradeService`, so it is immediately visible on the web and vice
   versa. No `journal_entries` table, no second write path, no duplicated
   validation. Journaling-eligible fields are exactly the ones the field
   ownership matrix already permits a user to write (`notes`, `strategyTag`,
   `emotionalScore`, `setup`); financial fields remain `FINANCIAL_IMMUTABLE`.
2. **Linking is an explicit, one-time, server-side transaction.** Telegram
   identity is the stable numeric `telegram_user_id` (never `@username`, never
   a display name, never a bio). It is bound to a Velora account only through a
   short-lived, single-use, cryptographically random token that is stored
   **hashed** (sha256 — the same convention as `user_sessions`,
   `email_verifications`) and consumed by an atomic conditional `UPDATE`.
3. **Both directions are supported**: web-first (`Settings → Telegram →
   Connect`) and Telegram-first (bot onboarding → Velora web page → login if
   needed → deep link back into the bot). No password, no session token and no
   credential ever travels through Telegram.
4. **AI stays behind the existing `AiProvider` boundary and fails closed.**
   Journal extraction runs on a **deterministic, framework-free domain parser**
   (`packages/domain`), which is what actually produces candidate fields.
   Voice transcription and chart-image interpretation are optional capabilities
   behind a `MediaInterpreter` port whose default implementation is
   **unconfigured → typed refusal**, exactly mirroring `UnconfiguredAiProvider`.
   No invented values, no heuristic fallback presented as model output.
5. **Processing is synchronous inside the API for the MVP.** Telegram requires
   a prompt webhook response, and the worker is not deployed; a queue-dependent
   bot would be non-functional in the current deployment. Retry safety is
   provided by the `telegram_updates` dedupe claim (Telegram re-delivers the
   same `update_id`), not by a worker. The queue migration path is named, not
   faked.
6. **The Telegram channel is a mirror, never a source of truth.** Channel
   publishing is best-effort and idempotent (`telegram_channel_posts`
   `UNIQUE (channel_id, trade_id)`); a failed publish never affects the stored
   journal record.

## Consequences

- `0023_telegram_journal.sql` is additive and forward-only: 6 new tables, an
  audit-vocabulary widening (no new table for audit — 0009's header explicitly
  forbids a second audit trail), and one additive `ai_coaching_logs.feature`
  discriminator so extraction attempts do not surface in the AI-coach feed.
- Telegram configuration is **capability-absent, not boot-blocking** (ADR-014
  §5 reasoning): a missing bot token leaves the web product untouched and every
  Telegram route answering its documented fail-closed 503.
- The bot's user-facing copy is Persian-first with English parity, matching the
  product's locale contract (ADR-009) and the existing `fa`/`en` surfaces.
- **Not** built, deliberately: a second database, a second auth system, a
  custom ORM, a new AI framework, a WebSocket voice co-pilot, n8n relay
  plumbing that does not exist, and any "AI extracted" claim that was not
  actually produced by configured infrastructure.

## Verification status (ADR-017 vocabulary)

| Item | State |
|---|---|
| Schema/migration, domain logic, services, routes, web UI, tests | `STATIC` + local PGlite battery evidence captured this session |
| Telegram Bot API live call (sendMessage/getFile/…) | `NOT_VERIFIED` — no bot token in scope; exercised against an injected stub |
| Webhook delivery from Telegram's servers | `NOT_VERIFIED` — requires a deployed public origin + `setWebhook` |
| Voice transcription / image interpretation against a provider | `NOT_VERIFIED` — no provider credential in scope |
| Real-PostgreSQL concurrency battery for the link-token race | `VERIFIED` 2026-10-04 — `db/tests/telegramConcurrency.pg.test.ts`, 9/9 on PostgreSQL **16.15** (one test FORCES the interleaving by holding the row lock in a third session) |
| Real-PostgreSQL batteries re-confirmed in the same run | `VERIFIED` — D1 smoke S1–S9 (fresh database, 23/23 migrations) and 70 further real-PG tests (trade concurrency 14/14; store/capability batteries 47/47) on 16.15 |
| Worker-based async processing | `NOT_IMPLEMENTED BY DECISION` (worker not deployed — see Decision 5) |

## Amendment 1 — 2026-10-04: audit round two (enforcement, input bounds, one canonical surface)

`IMPLEMENTED`/`TESTED`/`COMMITTED` were already true when this amendment was
written; what follows changes the strength of three CLAIMS and one UI decision,
with evidence, and nothing about the architecture.

1. **Two advertised rate limits were not enforced.** `telegram:journal` (20/h) and
   `telegram:analyze` (8/h) were declared in `packages/contracts/src/auth.ts` and
   described in `docs/telegram/SECURITY.md` §7, but no call site consulted them —
   only `telegram:update`, `telegram:link-start` and `telegram:channel` were
   wired. A limit that exists only in a table and a document is a claim, not a
   control. Both are now enforced BEFORE the work they bound (media download and
   provider call), so a throttled user spends nothing. Contract values unchanged;
   no limit was loosened.
2. **The media pre-check was missing.** `getFile`'s declared `file_size` was
   ignored, so an oversized voice note or screenshot was downloaded in full before
   the API layer's own cap could refuse it. The declared size is now checked first
   (5 MiB, the same constant the download enforces); the post-download measurement
   remains, because the declaration is a claim rather than a guarantee. The doc
   comment in `telegramApi.ts` that claimed a pre-check it cannot perform was
   corrected rather than left standing.
3. **The webhook ingress was bounded at the kernel's 1 MiB JSON default.** A
   Telegram update carries file REFERENCES, never file bytes, so the cap is now
   256 KiB and an oversized body is refused with the platform's existing
   oversized-body contract (400 `VALIDATION_FAILED`) before the pipeline is
   reached. No new error code was invented for one route.
4. **One canonical web surface, framed as an account.** The linking screen stays at
   `/settings`; it is now titled as the account page (`Settings`/`تنظیمات`) with
   Telegram under an explicit "Connected accounts" heading, and the sidebar nav
   item that opens it is labelled with the page's own name rather than the
   feature's. The signed-in user card became a link to the same surface (it was
   plain `div`s — there was no path from the account chrome to the account
   screen). Nothing was removed and no second Telegram surface exists: a grep of
   `apps/web/src` finds exactly two consumers of the telegram catalog (the sidebar
   label and the settings page).
5. **Verification apparatus defect found and fixed.** `tools/pg-smoke.ts` asserted
   a hard-coded `0001–0005` migration list, so it failed on every database since
   the sixth migration and would have blocked the whole `postgres-evidence`
   workflow at step one — before the new Telegram battery could run. The expected
   set is now discovered from `db/migrations/`. The Telegram battery is wired into
   that workflow as its own step (anti-SKIP: `# skipped 0`, `# fail 0`, executed
   count ≥ declared count).

Scope guard: no `journal_entries` table, no second journal aggregate, no new
queue/worker, no n8n relay, no polling in production, and no change to the single
`claim*`-statement atomicity that the database provides.
