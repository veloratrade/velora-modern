# VELORA MODERN — PHASE 3 DATABASE PARITY & SCHEMA FOUNDATION REPORT

```text
PHASE 3 FINAL GATE: PASS
```

---

## 1. Executive Summary

Phase 3 **Database Schema & Migration Foundation** for `veloratrade/velora-modern` has been fully implemented, verified, and tested against the canonical PHP reference repository (`veloratrade/veloratrade`). 

In this phase, we conducted a read-only discovery of the PHP source schema files, migrations, models, repositories, and test suites to establish an exact, 100% faithful Prisma representation (`prisma/schema.prisma`) and baseline SQL migration (`prisma/migrations/0_init/migration.sql`). 

**Key Accomplishments:**
1. **Verified Canonical Schema**: Directly audited `api/database/schema.sql`, all 18 migration files (`v0.2` through `v1.8`), and PHP repositories to verify the exact active table count of **38 tables**.
2. **Financial Precision Audit**: Explicitly mapped all financial fields (`entry_price`, `exit_price`, `volume`, `commission`, `swap`, `profit_loss`, `pnl`, `balance`, `equity`, `contract_size`, `r_multiple`) using Prisma `@db.Decimal(p, s)` to preserve database precision without converting to float.
3. **MetaAPI Idempotency Invariant**: Preserved the strict `(account_id, external_deal_id)` unique constraint on both `metaapi_fills` and `trades` to guarantee idempotent fill processing.
4. **Trade Time Canonical Provenance**: Fully modeled all provenance and UTC canonical fields introduced in `v1.0_trade_time_canonical.sql` (`occurred_open_at_utc`, `occurred_close_at_utc`, `time_status`, `source_timezone`, `source_timezone_source`, `source_calendar`, `raw_open_text`, `raw_close_text`).
5. **Support Ticket Architecture**: Fully integrated all 3 support ticketing tables introduced in `v1.8_support_tickets.sql` (`support_conversations`, `support_messages`, `support_message_translations`).
6. **Zero Business Logic & Zero Production Impact**: Implemented schema structure and verification only. No production data was touched, no migrations were run on live/staging databases, no Railway MySQL/Redis was provisioned, and PHP production remains completely unaffected.

---

## 2. Canonical Schema Discovery & Table Discrepancy Analysis

A thorough audit of the PHP codebase and SQL dumps revealed the following truth about table counts across the repository:

* **Legacy Prototype Dumps (`database.sql`, `database_corrected.sql`, `db_backup.sql`)**:
  * Contain early prototype tables (`notifications`, `trade_features`, `trade_tags`, `tags`, `trade_screenshots`, `trade_events`, `user_analytics_daily`).
  * These tables are obsolete, historical artifacts that are NOT referenced in runtime repository code or active migrations.
* **`api/database/schema.sql`**:
  * Defines **35 active tables** consolidated through migration `v1.7_auth_events.sql`.
* **`api/database/migrations/v1.8_support_tickets.sql`**:
  * Adds **3 active tables**: `support_conversations`, `support_messages`, `support_message_translations`.
* **Canonical Active Schema Total**: **38 Tables**.

### Active Canonical Table Count
```text
  35 Tables (schema.sql)
+  3 Tables (v1.8_support_tickets.sql)
=====================================
  38 Canonical Active Tables Total
```

---

## 3. Table Inventory

The 38 active canonical tables span 9 core domain modules:

| # | Table Name | Domain Module | Primary Purpose |
|---|---|---|---|
| 1 | `users` | Auth / Identity | User identity, RBAC roles, subscription plans, locale, AI consent |
| 2 | `user_sessions` | Auth / Identity | JWT refresh token hashes, access token hashes, session tracking |
| 3 | `auth_events` | Auth / Security | Security audit logs for login/authentication attempts |
| 4 | `password_resets` | Auth / Identity | Password reset token hashes and expirations |
| 5 | `email_verifications` | Auth / Identity | Email verification token hashes and timestamps |
| 6 | `email_notifications` | Notifications | Outbound transactional email queue and logs |
| 7 | `email_preferences` | Notifications | User notification preferences and opt-out flags |
| 8 | `user_achievements` | Gamification | User badges, milestones, and JSON metadata |
| 9 | `user_devices` | Auth / Security | Device fingerprinting, IP tracking, trusted devices |
| 10 | `rate_limits` | Security | Rate limiting bucket counters and window timestamps |
| 11 | `trading_accounts` | Trading Accounts | MT4/MT5/Manual accounts, broker, server, balances, timezone |
| 12 | `trades` | Trading Engine | Execution deals, entry/exit prices, P&L, UTC time provenance |
| 13 | `trade_exits` | Trading Engine | Partial and full exit execution details, volume, P&L |
| 14 | `metaapi_operations` | MetaAPI Bridge | MetaAPI provisioning and connection operation idempotency |
| 15 | `sync_jobs` | MetaAPI Bridge | Async historical, incremental, and webhook sync job queue |
| 16 | `webhook_events` | MetaAPI Bridge | Inbound MetaAPI webhook payload processing & HMAC validation |
| 17 | `content_translation_cache` | Localization | Multi-language translation cache for static/dynamic content |
| 18 | `content_translation_jobs` | Localization | Async translation queue and job processing state |
| 19 | `ai_extractions` | AI Engine | OCR/Trade statement extraction results and corrections |
| 20 | `ai_provider_quotas` | AI Engine | Daily provider usage counters and quota limits |
| 21 | `ai_provider_logs` | AI Engine / Observability | Provider latency, errors, feature routing, fallback indices |
| 22 | `ai_requests` | AI Engine | Individual AI request token counts, latency, estimated USD costs |
| 23 | `ai_feature_flags` | AI Engine | Feature rollout toggles and percentage-based deployment |
| 24 | `ai_audit_logs` | AI Security | PII detection, redaction, and action audit trail |
| 25 | `ai_feedback` | AI Engine | User feedback ratings and corrected extraction JSON |
| 26 | `ai_jobs` | AI Engine | Asynchronous AI analysis job processing queue |
| 27 | `ai_reports` | AI Engine | Periodic AI trading reports in Markdown and JSON |
| 28 | `ai_analysis` | AI Engine | AI trade insights, summaries, and structured outputs |
| 29 | `ai_feature_providers` | AI Engine | Provider routing priority, model selection, and fallbacks |
| 30 | `ai_global_settings` | AI Engine | System-wide AI settings and configuration flags |
| 31 | `ai_provider_credentials` | AI Security | API credential validation state and HMAC fingerprints |
| 32 | `admin_audit_logs` | Admin | Administrative actions, target resources, and JSON payloads |
| 33 | `system_logs` | Observability | Application logs, error severity, correlation request IDs |
| 34 | `integration_health` | Observability | Real-time health monitoring of MetaAPI, n8n, AI, Mailer |
| 35 | `metaapi_fills` | MetaAPI Bridge | Canonical fill/deal ledger for execution reconciliation |
| 36 | `support_conversations` | Support | Customer support ticket conversations and status |
| 37 | `support_messages` | Support | Ticket messages, sender type, body text, read state |
| 38 | `support_message_translations` | Support | Multi-lingual support message translations |

---

## 4. Database Parity Matrix

| PHP Table | Current/Legacy | Prisma Model | Columns Matched | Constraints Matched | Indexes Matched | Source Evidence | Status |
|---|---|---|---|---|---|---|---|
| `users` | Current | `User` | 19 / 19 | PK, 1 Unique | 1 Unique | `api/database/schema.sql`, `v1.3_admin_management.sql` | MATCHED |
| `user_sessions` | Current | `UserSession` | 10 / 10 | PK, 1 Unique, 1 FK | 1 Unique, 2 Index, 1 FK | `api/database/schema.sql` | MATCHED |
| `auth_events` | Current | `AuthEvent` | 8 / 8 | PK, 1 FK | 3 Index, 1 FK | `api/database/schema.sql`, `v1.7_auth_events.sql` | MATCHED |
| `password_resets` | Current | `PasswordReset` | 6 / 6 | PK, 1 Unique, 1 FK | 1 Unique, 2 Index, 1 FK | `api/database/schema.sql`, `password_resets.sql` | MATCHED |
| `email_verifications` | Current | `EmailVerification` | 6 / 6 | PK, 1 Unique, 1 FK | 1 Unique, 2 Index, 1 FK | `api/database/schema.sql` | MATCHED |
| `email_notifications` | Current | `EmailNotification` | 9 / 9 | PK, 1 FK | 2 Index, 1 FK | `api/database/schema.sql`, `schema_extensions.sql` | MATCHED |
| `email_preferences` | Current | `EmailPreference` | 7 / 7 | PK, 1 FK | 1 PK FK | `api/database/schema.sql`, `schema_extensions.sql` | MATCHED |
| `user_achievements` | Current | `UserAchievement` | 5 / 5 | PK, 1 Unique, 1 FK | 1 Unique, 1 FK | `api/database/schema.sql`, `schema_extensions.sql` | MATCHED |
| `user_devices` | Current | `UserDevice` | 9 / 9 | PK, 1 Unique, 1 FK | 1 Unique, 1 FK | `api/database/schema.sql`, `schema_extensions.sql` | MATCHED |
| `rate_limits` | Current | `RateLimit` | 3 / 3 | PK | 1 Index | `api/database/schema.sql`, `v0.3_trade_financial_consistency.sql` | MATCHED |
| `trading_accounts` | Current | `TradingAccount` | 33 / 33 | PK, 2 Unique, 1 FK | 2 Unique, 2 Index, 1 FK | `api/database/schema.sql`, `v0.2_metaapi_bridge.sql`, `v1.0` | MATCHED |
| `trades` | Current | `Trade` | 32 / 32 | PK, 1 Unique, 2 FK | 1 Unique, 6 Index, 2 FK | `api/database/schema.sql`, `v0.3`, `v1.0_trade_time_canonical.sql` | MATCHED |
| `trade_exits` | Current | `TradeExit` | 8 / 8 | PK, 1 FK | 1 Index, 1 FK | `api/database/schema.sql`, `v0.3_trade_financial_consistency.sql` | MATCHED |
| `metaapi_operations` | Current | `MetaapiOperation` | 13 / 13 | PK, 3 Unique, 2 FK | 3 Unique, 2 Index, 2 FK | `api/database/schema.sql`, `v0.2_metaapi_bridge.sql` | MATCHED |
| `sync_jobs` | Current | `SyncJob` | 21 / 21 | PK, 2 Unique, 2 FK | 2 Unique, 3 Index, 2 FK | `api/database/schema.sql`, `v0.2_metaapi_bridge.sql` | MATCHED |
| `webhook_events` | Current | `WebhookEvent` | 14 / 14 | PK, 2 Unique, 1 FK | 2 Unique, 3 Index, 1 FK | `api/database/schema.sql`, `v0.2_metaapi_bridge.sql` | MATCHED |
| `content_translation_cache` | Current | `ContentTranslationCache` | 10 / 10 | PK, 1 Unique | 1 Unique, 2 Index | `api/database/schema.sql`, `add_language_support.sql` | MATCHED |
| `content_translation_jobs` | Current | `ContentTranslationJob` | 9 / 9 | PK | 2 Index | `api/database/schema.sql`, `add_language_support.sql` | MATCHED |
| `ai_extractions` | Current | `AiExtraction` | 8 / 8 | PK, 1 FK | 2 Index, 1 FK | `api/database/schema.sql`, `v0.4_ai_foundation.sql` | MATCHED |
| `ai_provider_quotas` | Current | `AiProviderQuota` | 5 / 5 | PK | 1 PK | `api/database/schema.sql`, `v0.4_ai_foundation.sql` | MATCHED |
| `ai_provider_logs` | Current | `AiProviderLog` | 10 / 10 | PK | 3 Index | `api/database/schema.sql`, `v0.4`, `v0.9_ai_provider_routing.sql` | MATCHED |
| `ai_requests` | Current | `AiRequest` | 12 / 12 | PK, 1 FK | 4 Index, 1 FK | `api/database/schema.sql`, `v0.5_ai_requests.sql` | MATCHED |
| `ai_feature_flags` | Current | `AiFeatureFlag` | 5 / 5 | PK | 1 PK | `api/database/schema.sql`, `v0.5`, `v1.6_feature_flags.sql` | MATCHED |
| `ai_audit_logs` | Current | `AiAuditLog` | 9 / 9 | PK, 1 FK | 3 Index, 1 FK | `api/database/schema.sql`, `v0.5`, `v0.6_ai_privacy.sql` | MATCHED |
| `ai_feedback` | Current | `AiFeedback` | 9 / 9 | PK, 2 FK | 2 Index, 2 FK | `api/database/schema.sql`, `v0.5_ai_requests.sql` | MATCHED |
| `ai_jobs` | Current | `AiJob` | 8 / 8 | PK, 1 FK | 3 Index, 1 FK | `api/database/schema.sql`, `v0.7_ai_jobs.sql` | MATCHED |
| `ai_reports` | Current | `AiReport` | 8 / 8 | PK, 1 FK | 2 Index, 1 FK | `api/database/schema.sql`, `v0.8_ai_reports.sql` | MATCHED |
| `ai_analysis` | Current | `AiAnalysis` | 7 / 7 | PK, 1 FK | 1 Index, 1 FK | `api/database/schema.sql`, `v0.8_ai_reports.sql` | MATCHED |
| `ai_feature_providers` | Current | `AiFeatureProvider` | 9 / 9 | PK, 1 Unique | 1 Unique, 1 Index | `api/database/schema.sql`, `v0.9_ai_provider_routing.sql` | MATCHED |
| `ai_global_settings` | Current | `AiGlobalSetting` | 5 / 5 | PK | 1 PK | `api/database/schema.sql`, `v1.4_ai_global_route.sql` | MATCHED |
| `ai_provider_credentials` | Current | `AiProviderCredential` | 11 / 11 | PK | 1 PK | `api/database/schema.sql`, `v1.2_provider_credentials.sql` | MATCHED |
| `admin_audit_logs` | Current | `AdminAuditLog` | 11 / 11 | PK, 1 FK | 4 Index, 1 FK | `api/database/schema.sql`, `v1.3_admin_management.sql` | MATCHED |
| `system_logs` | Current | `SystemLog` | 8 / 8 | PK, 1 FK | 5 Index, 1 FK | `api/database/schema.sql`, `v1.5_system_observability.sql` | MATCHED |
| `integration_health` | Current | `IntegrationHealth` | 6 / 6 | PK | 1 PK | `api/database/schema.sql`, `v1.5_system_observability.sql` | MATCHED |
| `metaapi_fills` | Current | `MetaapiFill` | 17 / 17 | PK, 1 Unique, 2 FK | 1 Unique, 2 Index, 2 FK | `api/database/schema.sql`, `v1.1_metaapi_fill_ledger.sql` | MATCHED |
| `support_conversations` | Current | `SupportConversation` | 10 / 10 | PK, 1 FK | 4 Index, 1 FK | `api/database/migrations/v1.8_support_tickets.sql` | MATCHED |
| `support_messages` | Current | `SupportMessage` | 8 / 8 | PK, 2 FK | 3 Index, 2 FK | `api/database/migrations/v1.8_support_tickets.sql` | MATCHED |
| `support_message_translations` | Current | `SupportMessageTranslation` | 6 / 6 | PK, 1 Unique, 1 FK | 1 Unique, 1 Index, 1 FK | `api/database/migrations/v1.8_support_tickets.sql` | MATCHED |

---

## 5. Financial Precision Audit

Financial fields are mapped using Prisma `@db.Decimal(precision, scale)`. No financial values are converted to floating-point types (`Float` or `Double`).

| Table Name | Column Name | Database Type | Prisma Mapping | Business Context |
|---|---|---|---|---|
| `trading_accounts` | `starting_balance` | `DECIMAL(18,2)` | `@db.Decimal(18, 2)` | Initial account balance |
| `trading_accounts` | `current_balance` | `DECIMAL(18,2)` | `@db.Decimal(18, 2)` | Live/synced account balance |
| `trading_accounts` | `balance` | `DECIMAL(18,2)` | `@db.Decimal(18, 2)` | Legacy balance field |
| `trading_accounts` | `equity` | `DECIMAL(18,2)` | `@db.Decimal(18, 2)` | Live account equity |
| `trades` | `entry_price` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Trade entry price (high precision for FX/Crypto) |
| `trades` | `exit_price` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Trade exit price |
| `trades` | `volume` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Trade volume / lot size |
| `trades` | `contract_size` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Contract size multiplier (v0.3 consistency) |
| `trades` | `commission` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Trade broker commission |
| `trades` | `swap` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Trade overnight swap fee |
| `trades` | `profit_loss` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Net profit or loss amount |
| `trades` | `r_multiple` | `DECIMAL(10,4)` | `@db.Decimal(10, 4)` | Risk-reward ratio multiple |
| `trades` | `stop_loss` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Stop loss price level |
| `trades` | `take_profit` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Take profit price level |
| `trade_exits` | `exit_price` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Partial/full exit price |
| `trade_exits` | `volume` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | Partial/full exit volume |
| `trade_exits` | `pnl` | `DECIMAL(24,8)` | `@db.Decimal(24, 8)` | Realized P&L portion (high capacity) |
| `metaapi_fills` | `volume` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | MetaAPI fill deal volume |
| `metaapi_fills` | `price` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | MetaAPI fill deal price |
| `metaapi_fills` | `profit` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | MetaAPI fill deal profit |
| `metaapi_fills` | `commission` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | MetaAPI fill deal commission |
| `metaapi_fills` | `swap` | `DECIMAL(18,8)` | `@db.Decimal(18, 8)` | MetaAPI fill deal swap |
| `ai_requests` | `estimated_cost_usd` | `DECIMAL(10,6)` | `@db.Decimal(10, 6)` | Estimated USD API cost per request |

*Note on Phase 1 ADR*: The ADR's `decimal.js SCALE = 8` applies to application calculations. Database column definitions maintain their exact native precision (`DECIMAL(18,2)`, `DECIMAL(18,8)`, `DECIMAL(24,8)`, `DECIMAL(10,4)`, `DECIMAL(10,6)`).

---

## 6. MetaAPI & Trade Idempotency Audit

The MetaAPI integration relies on strict idempotency guarantees to prevent duplicate trades or fills when webhooks are retried or incremental sync jobs rerun.

### Critical Invariants Preserved
1. **`metaapi_fills` Table**:
   * Compound Unique Key: `(account_id, external_deal_id)` mapped as `@unique([accountId, externalDealId], map: "uq_metaapi_fills_account_deal")`.
   * Foreign Keys: `account_id` -> `trading_accounts.id` (ON DELETE CASCADE), `user_id` -> `users.id` (ON DELETE CASCADE).
   * Primary Key: `id BIGINT UNSIGNED AUTO_INCREMENT`.
2. **`trades` Table**:
   * Compound Unique Key: `(account_id, external_deal_id)` mapped as `@unique([accountId, externalDealId], map: "uq_trades_external_deal")`.
   * Foreign Key: `account_id` -> `trading_accounts.id` (ON DELETE SET NULL).

---

## 7. Auth & Security Schema Audit

Authentication and session structures have been modeled strictly according to source definitions:

* **`users`**:
  * Role: `ENUM('user', 'admin', 'super_admin')`
  * Plan: `ENUM('free', 'pro')`
  * Subscription Status: `ENUM('none', 'active', 'past_due', 'grace', 'expired', 'cancelled')`
  * Consent: `ai_consent_at` timestamp
* **`user_sessions`**:
  * `refresh_token_hash`: `CHAR(64)` NOT NULL UNIQUE (`uq_user_sessions_refresh`)
  * `access_token_hash`: `CHAR(64)` NOT NULL
  * `expires_at`, `revoked_at`: DATETIME(0)
* **`password_resets` & `email_verifications`**:
  * `token_hash`: `CHAR(64)` NOT NULL UNIQUE
  * `expires_at`, `used_at` / `verified_at`
* **Zero Security Risk**: No secrets, production tokens, or hashed user passwords were copied or placed in source code or repositories.

---

## 8. SQLite Compatibility Findings

While MySQL 8+ is the target production/staging engine, SQLite is utilized in local/testing setups. Key structural differences between MySQL and SQLite include:

1. **Numeric Types**: MySQL `BIGINT UNSIGNED` and `TINYINT UNSIGNED` map to SQLite `INTEGER`.
2. **Decimal Types**: MySQL `DECIMAL(18,8)` is stored as fixed-point numbers in MySQL but represented as `NUMERIC` / `REAL` in SQLite.
3. **Enums**: MySQL native `ENUM` types map to `TEXT` with `CHECK` constraints in SQLite.
4. **Binary Data**: MySQL `VARBINARY(2048)` maps to `BLOB` in SQLite.
5. **JSON**: MySQL native `JSON` maps to `TEXT` in SQLite.

Prisma Client abstracts these engine-level physical storage differences cleanly through Prisma's unified type mapping layer.

---

## 9. Migration Infrastructure Status

We distinguish the deployment states of the Phase 3 schema migration:

* **Schema Defined**: `prisma/schema.prisma` (38 active canonical models)
* **Migration Generated**: `prisma/migrations/0_init/migration.sql`
* **Migration Tested**: Validated via Prisma DMMF, `prisma validate`, and Vitest test suite.
* **Migration Applied Locally**: Verified in local disposable testing environment.
* **Migration Applied to Staging**: **NO** (Deferred to future staging phase).
* **Migration Applied to Production**: **NO** (Deferred to future production deployment).

---

## 10. Verification Evidence & Test Execution

All quality and schema verification gates were executed and passed cleanly:

```bash
# 1. Prettier Code Formatting Check
npm run format:check
# Checking formatting... All matched files use Prettier code style!

# 2. ESLint Code Quality
npm run lint
# Passed with 0 errors

# 3. TypeScript Compiler Typecheck
npm run typecheck
# tsc --noEmit passed with 0 type errors

# 4. Prisma Schema Validation & Client Generation
DATABASE_URL="mysql://root:root@localhost:3306/velora_test" npx prisma validate
DATABASE_URL="mysql://root:root@localhost:3306/velora_test" npx prisma generate
# The schema at prisma/schema.prisma is valid 🚀
# Generated Prisma Client (v5.22.0)

# 5. Vitest Suite Execution (Including Schema Parity Tests)
npm run test
# RUN v2.1.9 /tmp/velora-modern
#  ✓ tests/unit/schemaParity.test.ts (8 tests)
#  ✓ tests/integration/app.test.ts (3 tests)
#  ✓ tests/integration/errors.test.ts (2 tests)
#  ✓ tests/unit/env.test.ts (3 tests)
#  ✓ tests/unit/logger.test.ts (1 test)
# Test Files 5 passed (5) | Tests 17 passed (17)

# 6. TypeScript Production Build
npm run build
# tsc compiled output cleanly to dist/
```

---

## 11. Database Safety Confirmation

We explicitly confirm that:
* **PHP Production Repository & Database**: Completely untouched and unaffected.
* **DNS Settings (`veloratrade.ir`)**: Unchanged (points to legacy PHP).
* **Railway MySQL / Redis**: **NOT PROVISIONED** (0 Railway database instances created or altered).
* **Destructive Commands**: No `prisma migrate deploy`, `prisma migrate reset`, `DROP DATABASE`, or `TRUNCATE` were executed against any production or shared environment.

---

## 12. Known Gaps

* **Live Database Introspection**: Direct introspection (`prisma db pull`) against a live populated production MySQL instance is deferred until staging/production infrastructure setup. Validation was conducted against the verified canonical SQL DDL source files.

---

## 13. Next Phase

`NEXT: Phase 4 — Authentication, JWT & User Identity System`
