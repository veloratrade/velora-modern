# MySQL → PostgreSQL Migration Map (Phase 1 record — transform itself is evidence-gated)

Source of requirements: `docs/migration-strategy.md` + Accepted ADRs. The legacy
timezone is **BLOCKED_ON_SAMPLING** (ADR-004): no transform code exists until the
sampling procedure is executed and the owner confirms the interpretation.

| Concern | MySQL (verified) | PostgreSQL (implemented in `migrations/0001_core.sql`) |
|---|---|---|
| bigint unsigned ids | AUTO_INCREMENT | `BIGINT GENERATED ALWAYS AS IDENTITY` (ID-preserving import + `setval` fixup later) |
| email | utf8mb4_unicode_ci (case-insensitive) | canonical lowercase `TEXT` + plain `UNIQUE` (ADR-003/D-02); duplicate scan BEFORE import |
| prices/volume/contract | decimal(15,5)/(15,2)/(18,8) mixed | `NUMERIC(20,8)` (ADR-001 matrix) |
| currency amounts | decimal(15,2)/(18,2) | `NUMERIC(20,2)` |
| r_multiple | decimal(10,4) | `NUMERIC(20,8)` — parity rule in `packages/domain/src/legacyParity.ts`: imported values are preserved BY VALUE and a historical recomputation is compared at the LEGACY scale with the LEGACY mode (bcmath-truncate). MG-RMULTIPLE-SCALE, CLOSED 2026-10-04 |
| naive datetimes | `datetime` (TZ meaning unresolved) | `timestamptz` UTC + dual `source_time_naive`/`source_tz_offset` (ADR-004); legacy transform BLOCKED |
| enum status | `enum('OPEN','CLOSED')` | CHECK constraints |
| trade mutation | mutable rows + PUT/DELETE | ledger: `trade_events` append-only + `version` + tombstone `deleted_at` + allocation CHECK/trigger (ADR-002/D-01) |
| external ids | external_deal_id column (index set unverified) | `UNIQUE (account_id, external_deal_id)` idempotency |
| refresh tokens | sha256-hashed, 30d TTL | same semantics (`user_sessions`) |
| webhook raw | webhook_events table | same + `UNIQUE (source, event_id)` dedupe (ADR-008) |
| rate limiting | rate_limits buckets | same shared-store shape (Redis swap-in only per ADR-007 triggers) |

## Not migrated (ephemeral)

caches, `rate_limits` contents, expired verification/reset tokens,
retention-expired AI rows, worker queue/lease state (see migration-strategy §5).

## Screenshots

Rows AND bytes: binary objects move to object storage via StoragePort
(ADR-010); migration validation requires per-object checksums + 1:1 referential
check. Screenshot tables are a Phase 2 schema addition.

---

## Field-level mapping (Phase 4 · MG-SCHEMA-MAPPING · MG-DATA-MIGRATION)

Written record for the tables in the rehearsal fixture. The RULE is enforced by
A12 in `tools/lib/legacyLoadGates.ts`: **every exported column must be declared**,
either with a target column or with `target: null` + a reason. An undeclared
column FAILS the load, because an unwritten mapping is how a column's contents
disappear quietly.

| Legacy table.column | Modern target | Note |
|---|---|---|
| `users.id/email/password_hash/full_name/timezone/plan/locale/status/email_verified_at/ai_consent_at/created_at` | same-named columns | bcrypt `$2y$` hashes are imported unchanged (ADR-005); emails are canonicalised to lowercase before the uniqueness check (ADR-003/D-02) |
| `users.subscription_status`, `plan_started_at`, `plan_expires_at`, `plan_updated_at` | **no target — recorded, not loaded** | Modern `subscriptions` (0017) is the **Stripe** object: `provider TEXT NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe')`, `plan CHECK (plan IN ('pro','enterprise'))`, partial `UNIQUE (user_id) WHERE status IN ('active','trialing','past_due')`. The legacy lifecycle is provider-less and its vocabulary (`none|active|past_due|grace|expired|cancelled`) is not the Stripe vocabulary. Loading it there would fabricate a billing subscription in a vocabulary that does not accept it. The user-visible fact survives in `users.plan`. **OWNER DECISION** (OD-AC-SUBMAP). |
| `trading_accounts.account_number` | `external_account_id` | plus `account_number_masked` for display where a mask exists |
| `trading_accounts.id/user_id/broker_server/account_type/platform/provider/label/currency/leverage/timezone/status/sync_status/balance/starting_balance/consecutive_errors/created_at` | same-named columns | empty `leverage` → `'100'` (the column's own NOT NULL DEFAULT), declared explicitly rather than guessed |
| `trades.profit_loss` | `net_pnl` | the value is copied verbatim; it is never recomputed at load time (recomputation is a VALIDATION step — gate 6 — not a transform) |
| `trades.open_time` / `close_time` | `raw_open_text` / `raw_close_text` | the ORIGINAL naive text is preserved next to the resolved instant (ADR-004: the provider's evidence must stay auditable) |
| `trades.occurred_open_at_utc` / `occurred_close_at_utc` | `occurred_at` / `occurred_close_at_utc` | `source_timezone`/`time_status`/`source_time_naive` are carried as their own columns |
| `trades.outside_boundary` | **no target — recorded, not loaded** | the instant itself is present and validated; the per-row boundary taint has no modern equivalent and carries no decision |
| `trade_exits.exit_price/volume/pnl/exited_at` | `price`/`volume`/`pnl`/`exited_at` | `recorded_at` is set to the source's `exited_at` (the row's own event time, not the load time) |
| `support_conversations` / `support_messages` (Legacy `v1.8_support_tickets.sql`) | **`support_tickets` / `support_messages`** (0026) | **Phase 5 — MAPPED.** The concept was renamed (the route contract is `/support/tickets`, the row is a ticket with messages) and the two LEGACY-ONLY tables are `support_message_translations` (phase 7 / AI — dropped here rather than created empty) and the sentinel semantics of `first_reply_at` (kept as an idempotency marker, not a display value). Two Legacy DEFECTS are deliberately not reproduced: an internal note no longer moves status/waiting_for/counters/`last_message_at`/`first_reply_at`, and an admin asking for an internal note is refused instead of silently getting a user-visible reply. Per-column record: `support_conversations.id→support_tickets.id` (ID-preserving load), `user_id→user_id`, `subject→subject` (1..200), `status`/`waiting_for` (same four/two-value vocabularies, now CHECK-enforced together), `assigned_admin_id→assigned_admin_id`, `priority→priority`, `first_reply_at→first_reply_at`, `last_message_at→last_message_at`, `unread_*_count→unread_*_count`, `created_at`/`updated_at→same`; `support_messages.message_type` keeps `text|system_note`, `metadata_json→metadata` (jsonb), `edited_at`/`deleted_at→same`. |
| `ai_*` (×8), `email_notifications`, `user_achievements`, `content_translations`, `system_logs`, `integration_health`, `notifications` | **no target yet** | each is owned by the phase that builds its capability (7 AI, 9 secondary parity). They are recorded here so nothing is archived as "assumed safe", and each phase closes its own row. |

### Import mechanics (verified in the rehearsal)

* **ID-preserving**: `INSERT … OVERRIDING SYSTEM VALUE` (the target columns are
  `GENERATED ALWAYS AS IDENTITY`), followed by
  `setval(pg_get_serial_sequence(table,'id'), MAX(id), true)` for every table.
* **Quarantine, never invention**: a row whose timeline is unresolved is excluded
  from the load with its reason written to a quarantine file, and its money is
  subtracted from the expected totals so the parity gate stays exact.
* **Money parity is exact**: totals are compared as decimal STRINGS (the manifest
  total minus the quarantined rows' own values). No float touches a money value.

Run: `REHEARSAL_DATABASE_URL=… SOURCE_COMMIT_SHA=$(git rev-parse HEAD) npx tsx tools/load_rehearsal.ts`
(target database name must end in `_rehearsal`).

---

## Legacy table inventory reconciliation (AC-31 · 2026-10-05)

The audit-era claim ("8+ legacy tables without modern target") is re-audited against
the integrated tree (migrations 0001–0029). Legacy schema source of record:
`_database/database_corrected.sql` + `api/database/migrations/*.sql` — **45 tables**
(file-level duplicates deduplicated; recount documented in AC-31). Status of every one:

| Legacy table | Modern target | Status |
|---|---|---|
| `users` | `users` (0001, 0020 locale provenance) | MAPPED — except the subscription-lifecycle columns (`subscription_status`, `plan_started_at/expires_at/updated_at`): recorded, not loaded (Stripe-object `subscriptions` 0017 has an incompatible vocabulary) — **OD-AC-SUBMAP** |
| `trading_accounts`, `trades`, `trade_exits`, `trade_tags`, `tags` | same names | MAPPED (field-level rows above; trades carry ADR-004 dual-time evidence columns) |
| `trade_events` | `trade_events` (0007 ledger) | MAPPED — semantics differ by design (Legacy: rows for history; Modern: append-only ledger + version + tombstone, ADR-002) |
| `trade_screenshots` | `trade_attachments` (0014) | MAPPED via StoragePort (ADR-010; bytes to object storage, row + checksum in PG) |
| `metaapi_fills` | `sync_fills` (0012) | MAPPED — append-only evidence ledger, now byte-immutable under roles.sql |
| `sync_jobs` | **no table — replaced by design** | pg-boss queues + `sync_reservations` (0019) + `sync_position_state` (0029); a job row per sync would duplicate what the reservation/state pair already proves |
| `metaapi_operations` | **no table — replaced by design** | operation evidence = `sync_fills` + `trade_events` (TRADE_IMPORTED with deterministic uid) + `webhook_events`; a separate operations log would be a second journal for the same facts |
| `webhook_events` | `webhook_events` (0011) | MAPPED (+ `UNIQUE (source, event_id)`, ADR-008) |
| `rate_limits`, `password_resets`, `email_verifications`, `user_sessions`, `user_devices`, `email_preferences`, `user_analytics_daily` | same names | MAPPED |
| `auth_events` | `auth_events` (0024) | MAPPED (anti-enumeration NULL-user semantics preserved) |
| `support_conversations`, `support_messages` | `support_tickets`, `support_messages` (0026) | MAPPED (renamed by design; two Legacy defects not reproduced — see field-level rows) |
| `support_message_translations` | **no target — dropped by design** | phase-5 record: never created empty; translation of support messages is an AI-assist concern, not a stored translation pair |
| `admin_audit_logs` | `audit_log` (0009, extended 0027) | MAPPED — one append-only trail for admin actions, served by `GET /api/v1/admin/audit-logs` (+`?targetUserId=`) |
| `ai_feature_flags` | `ai_feature_flags` (0028) | MAPPED |
| `ai_feature_providers` | `ai_feature_routes` (0028) | MAPPED — same columns/semantics, Modern naming (phase-7 map) |
| `ai_provider_credentials` | `ai_provider_credentials` (0028) | MAPPED (envelope-encrypted) |
| `ai_provider_quotas` | `ai_provider_quotas` (0028) | MAPPED |
| `ai_global_settings` | `ai_settings` (0028) | MAPPED |
| `ai_feedback` | `ai_feedback` (0028) | MAPPED |
| `ai_requests`, `ai_provider_logs`, `ai_audit_logs`, `ai_extractions` | **ONE ledger**: `ai_coaching_logs` (0023, extended 0028) | MAPPED-BY-DESIGN — four attempt tables collapse into one ledger (`route`, `fallback_index`, `latency_ms`, `input_hash`, wider `feature` vocabulary); a second journal for the same fact was refused (phase-7 map) |
| `ai_analysis`, `ai_reports` | the ledger's `insight` + `window_from/window_to` + `feature='analysis'|'report'` | MAPPED-BY-DESIGN (phase-7 map) |
| `ai_jobs` | **not migrated — recorded** (phase-7 map) | Legacy's three user AI routes are synchronous with a deadline; the async path belongs with the worker (phase 8) |
| `content_translation_cache`, `content_translation_jobs` | **no target** | cache-only content localization capability (Legacy `POST /api/v1/content-translations/lookup` + worker ingestion) — absent end-to-end; owned by the content-translation decision (see MG-I18N-COVERAGE note: Modern serves fa/en natively per-surface, so the cache exists to translate CONTENT, not chrome) |
| `email_notifications` | **no target** | MG-EMAIL-TYPES: delivery/typing of the remaining transactional emails |
| `integration_health` | **no target** | phase 8 (admin integrations block, AC-16 inventory) |
| `notifications` | **no target** | in-app notifications capability (audit §4.2 n/a — Legacy table + bell UI; Modern has no notification surface) |
| `system_logs` | **no target** | phase 8/9 (admin log viewer block) |
| `user_achievements` | **no target (storage)** | the achievements ENGINE is ported (domain, AC-26) with Legacy repository semantics + catalog; a persistence home + surface is phase 9 |
| `trade_features` | **no target** | Legacy ML feature-engineering cache for `ml_model_predictions` (developer/E-A seam); Modern's developer capability (0016) does not consume precomputed features — LEGACY_ONLY unless the developer seam is re-scoped |

**Result:** of the 45 legacy tables, **33 have modern targets** (27 direct/renamed
mappings + 6 collapse-to-one-ledger by design), **3 are replaced or dropped by
design** (no table needed: `sync_jobs`, `metaapi_operations`,
`support_message_translations`), and **9 remain without targets** (`ai_jobs`
[recorded, phase 8 worker], `content_translation_cache` + `content_translation_jobs`,
`email_notifications`, `integration_health`, `notifications`, `system_logs`,
`user_achievements`, `trade_features`) — each owned by a named capability/phase/
decision, none silently dropped. The users-subscription columns remain the only
column-level gap (OD-AC-SUBMAP).
The users-subscription columns remain the only column-level gap (OD-AC-SUBMAP).
