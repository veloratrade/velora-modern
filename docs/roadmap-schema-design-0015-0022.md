# VELORA — PHASE 5 ROADMAP-ALIGNED SCHEMA DESIGN
### Carrying the Modern (PostgreSQL) database forward through the Master Roadmap v0.1 – v3.0

**Authority:** `veloratrade/veloratrade` → `docs/pdf/Roadmap.pdf` — *"VELORA: COMPLETE MASTER ROADMAP (v0.1 – v3.0)"* (17 pages, author "CTO & Principal Systems Architect", document title `Velora_Master_Roadmap_v0.1_v3.0`), read at pinned commit `edede313280f2f0e298f5ccbf5bbdd4d676c80bd`. This is the design authority the owner named for this phase.
**Target:** `veloratrade/velora-modern`, foundation lineage, pinned at `ced4e58ff5cc49471aae063d4eef84460aefc604` (tree `7796c37e…`).
**Status:** design executed and verified; **nothing committed, nothing pushed, no production database touched**.

---

## 1. What this design is

The Legacy product roadmap specifies, version by version, exactly which database objects must exist. The Modern foundation already implements the v0.1 core and the v0.2 sync substrate on PostgreSQL. This design adds **the remaining roadmap-specified schema** as seven forward-only migrations, `0015` … `0021`.

```
0015_tags_and_attachments.sql      v0.5  tags · trade_tags · trade_attachments
0016_analytics_aggregates.sql      v0.5 + §3  user_analytics_daily · account_performance_summary · composite indexes
0017_billing_and_ai_coach.sql      v1.0  subscriptions · ai_coaching_logs · users.plan vocabulary
0018_portfolio_and_prop.sql        v1.5  currency_rates · account_groups · account_group_members · prop_firm_rules
0019_ea_ingestion_and_push.sql     v2.0  trading_accounts.ea_api_key_hash · device_tokens
0020_tenancy_social_copy.sql       v2.5  tenants · public_profiles · copy_relationships · signal_queue
0021_developer_api_and_ml.sql      v3.0  developer_api_keys · ml_model_predictions · voice_session_logs
```

Result: **18 application tables → 37** (plus `schema_migrations`). Every table the roadmap names is present, under the roadmap's own name.

---

## 2. How the two authorities were reconciled (stated, not assumed)

There are two roadmap documents in play, and they are not interchangeable:

| Document | Scope | Used for |
|---|---|---|
| `veloratrade/veloratrade → docs/pdf/Roadmap.pdf` (**owner-designated**) | the *product* roadmap v0.1→v3.0: versions, features, and an explicit **"Database Changes:"** line per version | **the design authority for this phase** — table names, capabilities, DB deltas |
| `velora-modern → docs/migration/ROADMAP.md` | the *delivery* roadmap of the Modern repository (Phases 0…7) | engineering conventions only (ADR references, evidence rules, plan/role separation, Phase 6.5/7 scoping) |

`FACT` — the PDF's target architecture line reads *"Next.js 14 (App Router) | PHP 8.3 REST API | MySQL 8.0 | MetaApi Bridge | Linux cPanel Infrastructure"*, i.e. it is written for the PHP/MySQL stack. The Modern target is PostgreSQL. This design therefore ports the **capabilities and entity names** the PDF specifies onto the existing Modern PostgreSQL conventions — it does not port the MySQL engine, and it does not copy column types for similarity (a rule the repository already states in `0004`: *"Remote's 18,2 is NOT copied — no precision change for schema similarity"*).

---

## 3. Where the roadmap's requirements were already satisfied (no duplicate objects created)

| Roadmap line | Already in Modern | Design action |
|---|---|---|
| v0.1 core (auth, trades, metrics, CRUD DB) | `0001` … `0004`, `0006`, `0007` | none |
| v0.2 `metaapi_account_id`, `sync_status`, `last_synced_at` | `0012`, `0013` | none |
| v0.2 `connection_credentials_encrypted` | `0010 user_credentials` — AES-256-GCM envelope (iv/tag/key_version), unique nonce guard | kept as the single credential store; **documented divergence**, no second credential column |
| v1.0 *"Add role column to users"* | `0001` + `0006` (`user|admin|super_admin`) | none |
| v1.0 *"Create … admin_audit_logs"* | `0009 audit_log` (+`0011`,`0014`) — append-only, REVOKE-enforced, server-derived actor | **mapping declared: roadmap `admin_audit_logs` ≡ Modern `audit_log`**; a second audit trail is forbidden by `0009`'s own rationale |
| §3 *"field level AES-256-GCM before writing to MySQL"* | `0010` | reused verbatim by `0019` for push tokens |
| §12 *"Always use DECIMAL … never floating point"* | ADR-001 matrix (`NUMERIC(20,2)` money, `NUMERIC(20,8)` prices) | enforced in every new column |

---

## 4. Design invariants carried into all seven migrations

1. **Forward-only and additive** (ADR-010). No existing migration is modified; no column is dropped or retyped; no row is read or rewritten. Every `CREATE` is `IF NOT EXISTS`; every constraint change is `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` (the house pattern from `0005`/`0006`/`0007`/`0011`/`0014`).
2. **Idempotent by execution, not by claim.** Re-running the whole chain applies nothing (`schema_migrations` gate) — verified.
3. **Time is `TIMESTAMPTZ`, UTC-only** (ADR-004). No naive timestamp column is introduced anywhere.
4. **Money is `NUMERIC(20,2)`; prices/quantities `NUMERIC(20,8)`; ratios `NUMERIC(18,8)`; conversion rates get their own `NUMERIC(24,10)`.** The schema stores *what was computed*; it does not decide *how money is rounded* — OD-1 and OD-5 remain open.
5. **Ownership is a database invariant, not a convention.** New child tables carry a denormalized `user_id` with a **composite foreign key** back to the parent (`trades(id,user_id)`, `trading_accounts(id,user_id)`, `tags(id,user_id)`), so cross-tenant rows are impossible rather than merely discouraged. This is stronger than the Legacy schema, which enforces ownership only in application code.
6. **No plaintext secret ever gets a column.** EA keys, push tokens and developer API keys are stored as hashes or as the reviewed AES-256-GCM envelope. Verified: a query for plaintext-looking columns (`ea_api_key`, `api_key`, `push_token`, `transcript_audio`, `stripe_secret`) returns **0** rows in the resulting schema.
7. **Privacy is expressed as an absence plus an explicit opt-in**: no raw audio column exists at all; a transcript is storable only when `transcript_retained = true`; public profiles default `show_absolute_amounts = false`; AI coaching does not store the prompt or the raw model response.

---

## 5. Per-migration rationale (Condensed — each file carries its own full header)

### `0015_tags_and_attachments.sql` — roadmap v0.5
Roadmap: *"Database Changes: Create tags, trade_tags, trade_attachments, and user_analytics_daily tables."* Column vocabulary is taken from the PHP reference DDL (`api/database/database.sql`: `tags(kind enum STRATEGY|SETUP|MISTAKE|EMOTION|CUSTOM)`, `trade_tags`, `trade_screenshots(category BEFORE|AFTER|OTHER)`) — PHP remains the contract source for existing behaviour. `trade_attachments` is the roadmap's name for the `trade_screenshots` capability, reshaped for object storage (per `db/MIGRATION_MAP.md`: binary objects move to object storage). The roadmap's own upload rule (*"MIME-type whitelist JPG/PNG/WebP, max file size 5MB"*) becomes a `CHECK`, so a disallowed or oversized object cannot be registered even if application code is wrong. `trade_events.type` is deliberately **not** widened — tagging is already representable as `JOURNALING_EDITED` (ADR-002).

### `0016_analytics_aggregates.sql` — roadmap v0.5 + §3 *"Decoupled Analytics Engine"*
Roadmap §3: *"updates pre-aggregated summary tables (user_analytics_daily, account_performance_summary). The UI fetches pre-calculated snapshots instantaneously."* plus *"Enforce composite indexing on (account_id, open_time) and (account_id, symbol)"*.
**The day bucket is not absolute.** A "daily" figure is undefined until a timezone is chosen, and the Legacy source timezone is `BLOCKED_ON_SAMPLING` (ADR-004). Rather than silently assuming UTC, the table carries `tz_basis` + `tz_basis_source` **inside the primary key**, so a row claims to be *that day in that zone* — never "the" day. If the owner later ratifies a different basis, new rows appear alongside instead of overwriting history. The composite index uses the **canonical** UTC column `occurred_open_at_utc` (ADR-004: instants are UTC; the naive legacy `open_time` is evidence, never a sort key).
Both tables are **derived**: every column is recomputable from `trades`, so a rebuild is always possible.

### `0017_billing_and_ai_coach.sql` — roadmap v1.0
Roadmap: *"Create subscriptions, ai_coaching_logs, and admin_audit_logs tables. Add role column to users."* → two new tables (the other two requirements are already satisfied, §3). `users.plan` existed since `0002` with **no constraint**; this adds `CHECK (plan IN ('free','pro','enterprise'))`, sourced from Modern's own roadmap Phase 6.5, which also requires Plan and Role to remain strictly separate — a plan value can never widen a role. A partial unique index enforces **at most one live subscription per user**, so a failed-payment downgrade cannot leave two active rows competing. **No prompt and no raw model response is stored** — the prompt is assembled from a user's trades including free-text `notes`, so keeping it would duplicate user content (and any PII in it) into a third store.

### `0018_portfolio_and_prop.sql` — roadmap v1.5
Roadmap: *"Create currency_rates, account_groups, prop_firm_rules tables"*, plus the drawdown monitor and the 80 % alert rule. Two roadmap-sourced design points are encoded: (a) an FX **rate is not money** — it gets `NUMERIC(24,10)` with `rate > 0`, and money stays at 2 dp; (b) the roadmap's own test requirement distinguishes *"high equity peak vs balance tracking"*, so `drawdown_basis ∈ (balance, equity)` is an explicit column instead of an assumption. `account_group_members` is the minimal correct shape for grouping (an array column could carry neither membership metadata nor a foreign key). `alert_threshold_pct` defaults to **80.00** — the roadmap's acceptance criterion 2.

### `0019_ea_ingestion_and_push.sql` — roadmap v2.0
Roadmap: *"Add ea_api_key_hash to trading_accounts. Create device_tokens table"* and *"EA Authentication via single-use rotated API secret keys"*. The roadmap itself names the column as a **hash**, so only a SHA-256 hex value is storable (plus rotation/revocation/last-seen timestamps) — no plaintext, no prefix, nothing derivable. `device_tokens` reuses the reviewed `0010` AES-256-GCM envelope (a push registration token is a bearer capability: possession means "can notify this device"), with a non-secret `token_fingerprint` for dedupe and the same nonce-uniqueness guard.

### `0020_tenancy_social_copy.sql` — roadmap v2.5
Roadmap: *"Create tenants, public_profiles, copy_relationships, signal_queue tables"* and *"Prevent public profiles from leaking ticket numbers, account IDs, or exact balance sizes (percentage-based display option)"*. The leakage rule is implemented as an **absence plus a default**: a profile has no column able to hold a ticket, an account id or a balance, and `show_absolute_amounts` defaults to false. **Multi-tenant isolation is deliberately NOT decided here** — the roadmap lists it as a *backend* change, and choosing one-schema-per-tenant versus row-scoped tenancy in DDL would silently settle an open architecture question; `tenants` therefore carries a tenant label with tenant-scoped uniqueness only. `signal_queue` follows the durable-queue discipline already established by `sync_reservations` (lease, attempts, terminal state; rows are never deleted, so a dropped signal stays visible as evidence).

### `0021_developer_api_and_ml.sql` — roadmap v3.0
Roadmap: *"Create developer_api_keys, ml_model_predictions, voice_session_logs tables"*, *"OAuth2 Scoped Tokens"*, *"100 req/min per API key"*. Scopes are `CHECK`-constrained to a closed vocabulary and the rate limit defaults to **100** — both taken from the roadmap text. `ml_model_predictions.features` stores engineered values only, never a copy of the trade rows they were built from. Voice sessions store **metadata by default**: there is no raw-audio column, and `transcript` carries a `CHECK (transcript IS NULL OR transcript_retained)` so a transcript cannot be retained without explicit consent.

---

## 6. Legacy → Modern carry-forward (the data half of the migration)

The complete table-level map is in `phase5-evidence/legacy_to_modern_map.csv` (42 rows, one per Legacy table plus the production-only ones). Status histogram:

| Status | Count | Meaning |
|---|---|---|
| TRANSFORMED | 14 | a Modern counterpart exists; columns are re-typed/scaled per ADR-001/002/004 |
| EXACT | 1 | `email_preferences` — same semantics, same categories |
| MAPS_TO_ROADMAP_TABLE | 3 | `tags`, `trade_tags`, `trade_screenshots` → the new `0015` tables |
| PARTIAL | 1 | `auth_events` → representable inside `audit_log` |
| SUPERSEDED | 1 | `sync_jobs` → lease/reservation substrate + queue (rows are ephemeral state) |
| DEFERRED_TO_PHASE | 19 | AI tables (Modern Phase 7), support desk, notifications, achievements, ops logs |
| NOT_PORTED | 3 | `trade_features` (a second source of truth), `content_translation_*` (retired capability) |

### 6.1 ⚠ The two Legacy databases diverge — the source of record must be chosen by the owner

`FACT` (verified this session):

| | staging (`piknet_velora_staging`) | live production (`piknet_velora`) |
|---|---|---|
| tables | **36** | **31** |
| canonical v1.0 time columns | present — but **100 % NULL**, every trade `unresolved` | **absent** |
| `trading_accounts.timezone/_source` | present | absent |
| `tags` / `trade_tags` / `trade_screenshots` / `trade_features` / `trade_events` / `notifications` | **absent** | **present** |
| `trades` shape | 32 cols, `direction enum('buy','sell')`, everything `numeric(18,8)/(24,8)` | 34 cols, `direction varchar(4)`, `entry_price numeric(15,5)`, `commission numeric(15,2)`, `contract_size numeric(20,8) DEFAULT 100000`, `status enum('OPEN','CLOSED') DEFAULT 'CLOSED'` |

Neither database is a superset of the other. The owner indicated staging as the source because it is further ahead; this design **follows that** — but the six production-only tables mean a staging-only export would silently lose tagging/journaling data that exists in production. Resolving this is an `OWNER DECISION` (§8, OD-10), not something a transform script may decide.

### 6.2 Transform rules per concern

| Concern | Rule (mechanical, executable) | Gate |
|---|---|---|
| ids | preserve legacy id; `BIGINT GENERATED ALWAYS AS IDENTITY`; `setval` fixup after load (per `db/MIGRATION_MAP.md`) | — |
| email | canonical lowercase + duplicate scan **before** import (ADR-003/D-02) | duplicate scan must return 0 |
| prices / volume | `numeric(15,5)`/`(15,2)` → `NUMERIC(20,8)`; widening is lossless | — |
| money (`commission`, `swap`, `profit_loss`, `net_pnl`) | 8-dp or 2-dp source → `NUMERIC(20,2)`; **narrowing is lossy**; the rounding rule is **not** chosen here | **OD-1 / OD-5** |
| `profit_loss` → `net_pnl` | copy verbatim **or** recompute under the parity contract — both are implementable; the choice changes cents | **OD-1** |
| `r_multiple` | recompute under the chosen R contract (the stored Legacy value is already 4-dp truncated) | **OD-1** |
| naive `open_time`/`close_time` | → `occurred_at` **as supplied**, `time_status = 'unresolved'`, raw text preserved; **no timezone is invented, no UTC instant is fabricated** | **OD-3 / OD-4 (ADR-004 sampling)** |
| direction | validate the value set first (`enum(buy,sell)` vs `varchar(4)`), then map to the Modern `CHECK (direction IN ('buy','sell'))` | value-census query first |
| symbol | `XAU/USD` → `XAUUSD` canonicalisation is **required** (12 of 28 staging rows used the slashed form = 43 %) — recorded as a mapping table so the rewrite is auditable | **no symbol→contract_size map may be invented** (Phase-4 rule) |
| `contract_size` | copy verbatim; staging values observed ∈ {1, 100, 100000} | — |
| users.timezone | copied verbatim (staging aggregate: UTC 63 / Asia/Tehran 19) | display-time semantics stay OD-4 |
| ephemeral rows | sessions, rate-limit contents, expired/consumed tokens, notification log, queue/lease state | **not migrated** (`db/MIGRATION_MAP.md`) |
| attachments | rows + **bytes**: object storage via StoragePort; 1:1 referential check + per-object checksum | storage decision (OD-11) |

### 6.3 Load order (referential, fail-closed)

```
users → trading_accounts → trades → trade_exits → tags → trade_tags → trade_attachments (metadata)
      → audit_log / trade_events (reconstructed history) → derived tables (rebuild, never copy)
```

### 6.4 Validation gates (each must be a number, not a sentence)

1. per-table row counts `source == target`; 2. money sums per user/account equal within the declared rounding rule; 3. orphan checks = 0 (every `trade_id`/`account_id`/`tag_id` resolves); 4. `SELECT count(*) FROM trades WHERE allocated_volume > volume` = 0; 5. duplicate canonical email scan = 0; 6. every `trade_tags`/`trade_attachments` row passes the composite ownership FK; 7. per-id checksum manifest for the whole export; 8. a **rehearsal run on a disposable PostgreSQL** before any staging load.

---

## 7. What this design deliberately does NOT do

1. **It does not decide OD-1 … OD-5.** No rounding mode, no R-multiple formula, no timezone, no commission width, no contract-size source is asserted anywhere in the DDL. The schema is built so that either choice remains executable.
2. **It does not implement the tenant data boundary** (backend concern, roadmap leaves it open).
3. **It does not port `trade_features`** — it would create a second source of truth for facts already on `trades` + `tags`.
4. **It does not create a second audit trail** for `admin_audit_logs`.
5. **It does not widen `trade_events.type`** — no roadmap feature requires a new event type that `JOURNALING_EDITED`/`TRADE_IMPORTED`/… cannot express.
6. **It does not move any data.** The migrations create empty, correct structures; the extract/transform/load is a separate, owner-authorised step with its own rehearsal.
7. **It does not touch application code** (repositories, services, routes) — a schema alone changes no behaviour.

---

## 8. Open decisions this design surfaces (owner-gated — none decided here)

| ID | Decision | Why it matters |
|---|---|---|
| OD-1 | historical money rounding (parity truncate vs half-even) | changes stored cents on imported trades |
| OD-2 | R-multiple formula/basis | changes stored R for every trade |
| OD-3 | Legacy source timezone interpretation (ADR-004 sampling) | without it no historical trade can be resolved to a UTC instant |
| OD-4 | timezone semantics (`users.timezone` display-only vs authoritative) | affects every day-bucketed aggregate |
| OD-5 | commission/swap storage width | width vs safe-migration trade-off |
| **OD-10 (new)** | which Legacy database is the source of record (staging, production, or a union) | §6.1 — neither is a superset |
| **OD-11 (new)** | object-storage target + retention for attachments | `trade_attachments.storage_key` needs a real store |
| **OD-12 (new)** | whether `users.plan` vocabulary (`free|pro|enterprise`) is confirmed | the CHECK now enforces it (sourced from Modern roadmap Phase 6.5) |
| **OD-13 (new)** | voice/ML retention policy | the schema defaults to metadata-only; retention length is a policy choice |

---

## 9. Evidence produced with this design

| Artefact | What it proves |
|---|---|
| `phase5-evidence/schema_before_0014.json` | the schema as it was: 18 application tables, full column/index/constraint dump |
| `phase5-evidence/schema_after_0021.json` | the schema after the new chain: 37 application tables |
| `phase5-evidence/roadmap_schema_verification_output.txt` | **78/78 assertions pass, 0 fail** — including 40+ negative tests (cross-owner attach, oversize/illegal MIME, second live subscription, tenant-invalid slug, consent-less transcript, nonce reuse, scope escalation, …) |
| `phase5-evidence/migration_suite_result.txt` | the repository's own suite: **19/19 tests pass**, chain applies cleanly and is idempotent |
| `phase5-evidence/legacy_to_modern_map.csv` | 42-row Legacy→Modern table map with status per table |
| `phase5-evidence/roadmap_requirement_coverage.csv` | every roadmap DB requirement → where it is satisfied |
| `db/tests/roadmapSchemaVerification.pglite.ts` | the harness itself (runnable with `npx tsx`) |

**Engine note:** all execution used PGlite (PostgreSQL 16 semantics in WASM), the same disposable engine the repository's own migration tests use. This is dev/test evidence — not production hosting evidence.

---

## 10. Addendum — `0022_legacy_contract_parity.sql` (gap closure, built after the three-world analysis)

The three-world gap analysis (staging ↔ production ↔ this schema, `phase5-evidence/gap_register.csv`) separated two things that look alike but are not:

- **Schema parity** — a field that already holds data in the Legacy databases and therefore needs a destination. Adding it decides nothing: an unused column is inert and can be deprecated later without touching data.
- **Product decisions** — e.g. "should `strategy_tag` become a `tags` row instead of a column?" (roadmap v0.5 introduces `tags`/`trade_tags` for exactly that). Those stay open.

`0022` adds only the first kind, plus the one roadmap security requirement that had no representation:

| Added to | Columns | Gap closed |
|---|---|---|
| `trades` | `strategy_tag`, `emotional_score`, `confidence`, `mistake`, `market_context`, `lot_size` | GAP-07/08/09 |
| `trading_accounts` | `starting_balance`, `account_type`, `auto_sync_enabled`, `consecutive_errors`, `last_error`, `connected_at`, `disconnected_at`, `connection_checked_at`, `last_incremental_at` | GAP-01/10/11 |
| `users` | `first_name`, `last_name`, `locale_source`, `locale_updated_at` | GAP-13 |
| `webhook_events` | `signature_verified`, `signature_algorithm`, `signature_verified_at` (+ evidence CHECK) | GAP-02 |
| indexes | `trades_user_strategy_tag_idx`, `trading_accounts_sync_errors_idx` (both partial) | — |

**Rules this migration follows (and one it refuses to):** every added `NOT NULL` column carries a default, so a Legacy-shaped `INSERT` that omits it still succeeds — proven by a test that inserts a trade without any of the new columns and observes `NULL`/defaults rather than invented values. Bounds mirror the **storage type** (`tinyint unsigned` → `0..255`), never an assumed rating scale. And `locale_source` is deliberately **unconstrained**: the Legacy column is `varchar(16) DEFAULT 'default'` and its real value set has not been censused, so a CHECK vocabulary here would be a guess — exactly the class of decision (`GAP-04`) that stays with the owner.

Closed gaps after `0022`: **8 of 24**; the remaining 15 are decision-, evidence-, or environment-gated (see the register's `status_after_0022` column). The migration changes no existing column, drops nothing, and reads no row.

---

## 11. Post-build verification record (Phase 5C) — conformance against the Master Roadmap

After `0022` was applied, the built schema was audited **automatically** against every
roadmap version's database requirements (8 × "Database Changes" lines) plus the §3
architecture pillars and the §12 CTO checklist. Results — 37-row matrix, no claim
without a schema lookup:

| Verdict | Count |
|---|---|
| CONFORMS | 28 |
| CONFORMS-BY-MAPPING (`connection_credentials_encrypted` → `user_credentials` envelope; `metaapi_fills` → `sync_fills`) | 2 |
| SCHEMA-READY / APP-PENDING (every `/api/v1/...` endpoint — application layer, not built here) | 7 |
| **MISSING / VIOLATION** | **0** |

Automated negative checks that passed on the resulting schema: **zero** floating-point
columns anywhere (ADR-001 / roadmap §12), **zero** card/PAN/CVV columns (v0.1 PCI-DSS),
**zero** plaintext secret columns, and `trades` carries no hash column at all (this last
one is why the v2.5 "prove execution against server history hash" criterion is recorded
as a *shortfall*, not as satisfied — see the gap register).

Six acceptance-criteria shortfalls were found in this pass and are tracked as GAP-25…GAP-30
(outbound alert delivery substrate; per-trade attestation; per-account risk parameters for
the voice intervention; tenant custom domain; FX granularity; developer monetization).
They come from the roadmap's **Acceptance Criteria**, not from its "Database Changes"
lines, which is why the migration-level audit did not surface them.

### 11.1 Consolidated DDL snapshot

`db/schema-snapshots/modern-target-0022.sql` is a **generated** snapshot of the schema at
the head of the chain (37 application tables, 44 indexes, 51 FKs, 1 trigger + its guard
function). It exists for review and archival: a reader can see the whole target schema in
one file. It is **not** the source of truth — `db/migrations/` remains authoritative
(ADR-010, forward-only). The snapshot was verified by re-executing it from scratch on a
fresh disposable engine: all 37 tables recreated.

### 11.2 How to re-run every number in this document

```bash
npm ci
npm run test:migrations                                        # 19/19 — chain applies + idempotent
npx tsx db/tests/roadmapSchemaVerification.pglite.ts           # 78/78 — contract incl. negatives
```
