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
| Real-PostgreSQL concurrency battery for the link-token race | `NOT_VERIFIED` locally (PGlite covers semantics; a `.pg.test.ts` battery is added for the workflow) |
| Worker-based async processing | `NOT_IMPLEMENTED BY DECISION` (worker not deployed — see Decision 5) |
