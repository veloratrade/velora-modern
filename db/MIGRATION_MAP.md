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
| r_multiple | decimal(10,4) | `NUMERIC(20,8)` |
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
