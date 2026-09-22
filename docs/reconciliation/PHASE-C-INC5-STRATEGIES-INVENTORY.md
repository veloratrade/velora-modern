# Phase C Increment 5 — Strategies Inventory & Standalone Determination (read-only)

Date: 2026-09-13. Base: `27475deb830ff083632aa7d922c4f158c66c0b74` (increment-4
terminal, baseline 244/244 verified). Evidence sources: Remote frozen snapshot
`remote-snapshot-99e024c829db` (module tree, `prisma/schema.prisma`,
`prisma/migrations/0_init/migration.sql`, dashboard + trades modules,
integration tests), PHP `/home/user/velora-sparse` (`api/index.php` route table,
`api/database/database_corrected.sql`, `src/Dashboard/*`, `src/Trades/*`,
full-tree grep), Local ADRs, increment-3/4 implementation and tests.

## 1. Standalone Strategy determination (authorization Step 2 — all ten questions)

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Remote standalone strategy resource? | **NO** | module tree: accounts, admin, ai, auth, dashboard, entitlements, metaapi, observability, support, trades, users — no strategies module; no Strategy model in `schema.prisma`; no strategies table in `0_init/migration.sql` (full CREATE TABLE list verified) |
| 2 | PHP standalone strategy resource? | **NO** | route table (`api/index.php`): no strategy routes; no controller/service/repository; `tags`/`trade_tags` tables exist **schema-only** — zero code references (grep `trade_tags`/`FROM tags`/`INSERT INTO tags` over `api/src` = empty); MetricsService comment: "roadmap v0.5 tags matrix, base available from v0.1" |
| 3 | Strategies merely strings/metadata on trades? | **YES** | `strategy_tag varchar(64) NULL` on trades (PHP); Remote `strategyTag String? @map("strategy_tag") @db.VarChar(50)` on Trade — free-form, nullable, no FK, no strategy ID |
| 4 | Persistent strategy table? | PHP `tags` (id, user_id, name varchar(60), kind enum('STRATEGY','SETUP','MISTAKE','EMOTION','CUSTOM'), color, created_at) + `trade_tags` join — **schema-only, unused**; Remote: none | verified DDL + zero code usage |
| 5 | Strategy IDs used anywhere? | **NO** | no id reference in either lineage; `trade_features.strategy_tags json` is also an unused feature-store column |
| 6 | Strategies create/edit/delete? | **NO API in either lineage** | route tables verified both sides |
| 7 | Strategy ownership? | Only implicit via `trades.user_id`; the unused PHP `tags` table carries `user_id` (schema-only) | — |
| 8 | Assignment to trades? | Only the free-form `strategy_tag` string; `trade_tags` join unused | — |
| 9 | Performance metrics? | **YES — as a Dashboard projection**, not a Strategy API: `GET /api/v1/dashboard/strategies` exists in BOTH lineages (Remote `getPerStrategy`; PHP `MetricsService::perStrategy`): group trades by trimmed/NULLIF strategy_tag → `{strategy, tradeCount, winRate (scale 4, truncate/bcdiv), pnl (scale 2)}`, order pnl DESC; Remote integration test pins `winRate '1.0000'` format | dashboard modules + tests both sides |
| 10 | Strategy-rule/backtest engine? | **NONE** | grep `backtest|order.block|fair.value.gap|liquidity.sweep` over both lineages = empty |

**Conclusion:** "Strategy" in the product today means (a) a free-form
`strategyTag` journal field on trades, plus (b) a per-strategy aggregation
exposed by the Dashboard capability. There is no standalone Strategy entity,
no CRUD, no IDs, no ownership model, and no rule/backtest engine in either
lineage. Per the authorization's critical rule and Step 2, no strategy CRUD,
entity, migration, or engine is manufactured. The Local capability matrix
row 10 ("Strategies / strategy tags — PORT — verify Remote behavior during
that increment") is now **verified**: nothing standalone exists to port.

## 2. Capability matrix

| Capability | Remote evidence | PHP evidence | Local status | Classification | Action |
|---|---|---|---|---|---|
| Strategy entity | none (string column only) | schema-only `tags`/`trade_tags`, zero usage | none | **NOT IMPLEMENTED** | do not manufacture; future product decision (v0.5 roadmap) |
| Strategy create | none | none | — | NOT IMPLEMENTED | — |
| Strategy read | none (only per-trade strategyTag serialization) | same | delivered (inc 3) | KEEP | verify (regression test) |
| Strategy update | `PUT /trades/:id` merges strategyTag (mutable row) | same | `JOURNALING_EDITED` event, financial 403 (inc 3/4) | KEEP (ADR-002 redesign already in place) | verify |
| Strategy delete/archive | none | none | — | NOT IMPLEMENTED | — |
| Ownership | trades.user_id scoping only | same | trades ownership boundary (inc 3/4) | KEEP | no second ownership model |
| Uniqueness | none (free-form) | none | none | KEEP | no invented uniqueness |
| Trade assignment | free-form string on create/update | same | strategyTag on create + journal edit | KEEP | verify |
| Strategy filtering | search `q` covers strategy (Remote: dead param; PHP: LIKE) | `q` includes strategy_tag | implemented (inc 4, PHP evidence) | KEEP | verify |
| Strategy statistics | `GET /dashboard/strategies` (winRate 4dp truncate, pnl 2dp, pnl DESC) | same (bcdiv 4, bcadd 2) | none | **NOT IMPLEMENTED — Dashboard capability** | inventory only; defer to Dashboard increment (formulas recorded above for that increment) |
| Rule definition | none | none | — | NOT IMPLEMENTED | no invention |
| Backtesting | none | none | — | NOT IMPLEMENTED | no invention |

## 3. Field/ownership matrix (Strategy-affected fields)

| Field | Classification | Editable? | Notes |
|---|---|---|---|
| `strategyTag` (→ trades.strategy) | JOURNAL_USER_EDITABLE (ADR-002 USER_WINS_JOURNALING; established inc 4) | YES — `JOURNALING_EDITED` event | free-form string, optional, null/''→null, ≤64 |
| everything else on the trade | unchanged (13 FINANCIAL_IMMUTABLE → 403; SYSTEM_DERIVED; SYNC_OWNED — inc 4 matrix) | as established | no strategy path may touch them |

## 4. Validation evidence and divergences

- Length: PHP validates ≤64 and stores `varchar(64)` (consistent). Remote
  **service** validates ≤64 but its **DB column is VarChar(50)** — a
  Remote-internal divergence (latent truncation/error); Local validates ≤64
  (service, PHP/Remote-service lineage) with a TEXT column — consistent end to
  end. Documented; no change needed.
- Type/normalization: string, optional, `null`/`''` → null (both lineages);
  not trimmed/uppercased by the service in either lineage (only the Remote
  DASHBOARD trims for grouping; PHP uses `NULLIF(strategy_tag,'')`). Local
  matches (no normalization on write; inc-4 `q` search is case-insensitive).
- No charset restriction in either lineage (only maxLength) — Local matches.

## 5. ADR traceability

- ADR-002: strategyTag mutations remain `JOURNALING_EDITED` events on the
  immutable trades ledger; financial fields untouched; no new event type
  needed (no evidence for one). Replay/ownership/tombstone semantics unchanged.
- ADR-001: not applicable (no financial computation in this increment; the
  deferred per-strategy aggregation formulas are recorded with their scales —
  winRate scale 4 truncate, pnl scale 2 — for the Dashboard increment).
- ADR-004/003/009: not applicable (no timestamps/identity/serialization change).
- ADR-006/010: no new external contracts; no infrastructure introduced.

## 6. Scope of the code delta (evidence work only — no implementation)

1. This inventory + Local capability-matrix row 10 update (verified finding).
2. Regression tests pinning the strategyTag contract (create/read/edit/null
   clear/≤64/q-search/replay/financial immutability) and the API boundary
   (no `/api/v1/strategies` route exists → 404; no manufactured endpoints).
3. Evidence record + AGENTS.md row. No migration, no port, no endpoints.
