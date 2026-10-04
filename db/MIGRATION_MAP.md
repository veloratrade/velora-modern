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
| `ai_*` (×8), `support_tickets/messages`, `email_notifications`, `user_achievements`, `content_translations`, `system_logs`, `integration_health`, `notifications` | **no target yet** | each is owned by the phase that builds its capability (7 AI, 5 support, 9 secondary parity). They are recorded here so nothing is archived as "assumed safe", and each phase closes its own row. |

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
