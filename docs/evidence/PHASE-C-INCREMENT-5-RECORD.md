# Phase C Increment 5 Record — Strategies (2026-09-13)

**Scope:** Strategies capability only. Start HEAD `27475deb830ff083632aa7d922c4f158c66c0b74`
(verified: branch, clean tree, main/snapshot untouched, 0 remotes, baseline
244/244 before any change; `npm ci` + dependency-order rebuild after workspace
restore — snapshot-excluded `dist`/`node_modules`, known environment property).
Full inventory: `docs/reconciliation/PHASE-C-INC5-STRATEGIES-INVENTORY.md`.

| # | Commit | Content |
|---|---|---|
| 1 | `dce51c2` | strategies inventory + standalone determination (read-only); capability-matrix row 10 updated to the verified finding |
| 2 | `7dfe0c6` | strategyTag contract regression tests (service 21→22, routes 9→10) — verify, don't build |
| 3 | this commit | evidence record + AGENTS.md row |

**No implementation commits were manufactured** (authorization: a properly
evidenced NOT IMPLEMENTED result is acceptable and, here, correct).

## 1. Standalone Strategy determination (verified facts)

- **Remote:** NO standalone Strategy resource — no strategies module, no Prisma
  model, no strategies table (full `0_init/migration.sql` CREATE TABLE list
  verified); `strategyTag String? VarChar(50)` is a free-form column on Trade.
- **PHP:** NO standalone Strategy resource — no strategy routes/controller/
  service; `tags` (kind incl. 'STRATEGY') + `trade_tags` tables exist
  **schema-only with zero code references** (MetricsService comment: "roadmap
  v0.5 tags matrix"); `strategy_tag varchar(64)` free-form on trades.
- **Local:** strategyTag delivered as journal metadata on the trades ledger
  (increments 3/4); no Strategy entity — correctly, per the evidence.

"Strategy" in the product today = (a) the free-form `strategyTag` journal
field + (b) a per-strategy aggregation exposed by the **Dashboard** capability
(`GET /api/v1/dashboard/strategies`, both lineages: group by trimmed tag →
`{strategy, tradeCount, winRate scale-4 truncate, pnl scale-2}` ordered pnl
DESC; Remote integration test pins `winRate '1.0000'`). No strategy IDs, no
CRUD, no ownership model, no rule/backtest engine anywhere (grep-verified:
`backtest|order.block|fair.value.gap|liquidity.sweep` = empty in both lineages).

## 2. Capability matrix (summary — full matrix in the inventory)

| Capability | Classification | Evidence |
|---|---|---|
| Strategy entity / create / update(CRUD) / delete | **NOT IMPLEMENTED** | absence verified in both lineages; PHP tags tables schema-only (roadmap v0.5) |
| strategyTag trade metadata (read/assign/edit) | **KEEP** | delivered inc 3/4; regression-tested this increment |
| Ownership | **KEEP** | trades ownership boundary only; no second model created |
| Uniqueness | **KEEP (none)** | free-form in both lineages; no invented uniqueness |
| Strategy filtering (q search) | **KEEP** | delivered inc 4 (PHP evidence); regression-tested |
| Strategy statistics | **NOT IMPLEMENTED — Dashboard capability** | both lineages expose it under /dashboard/strategies; formulas inventoried for the Dashboard increment; NOT implemented here (Step 9 boundary) |
| Rule definition / backtesting | **NOT IMPLEMENTED** | zero evidence in either lineage; no invention |

## 3. Field/ownership matrix

`strategyTag` (→ `trades.strategy`): **JOURNAL_USER_EDITABLE** (ADR-002
USER_WINS_JOURNALING; established increment 4) — string, optional,
null/''→null, ≤64, no charset restriction, no normalization on write, editable
only via `JOURNALING_EDITED` events. Every other trade field unchanged from
the increment-4 matrix (13 FINANCIAL_IMMUTABLE → 403; SYSTEM_DERIVED;
SYNC_OWNED). No strategy path may touch financial facts (regression-tested).

Documented divergence: Remote **service** validates ≤64 while its **DB column
is VarChar(50)** (Remote-internal latent bug); PHP is consistent at 64; Local
validates ≤64 with a TEXT column — consistent end to end.

## 4. ADR traceability

ADR-002: strategyTag mutations remain `JOURNALING_EDITED` events on the
immutable ledger; replay reproduces final strategy values (tested); tombstoned
strategy data unsearchable (tested); no new event type (no evidence for one).
ADR-001: not applicable (no financial computation; deferred aggregation
formulas recorded WITH their scales — winRate scale 4 truncate, pnl scale 2 —
for the Dashboard increment). ADR-003/004/009: not applicable. ADR-006/010:
no new external contracts, no infrastructure.

## 5. Persistence / API

No migration (nothing to persist — no entity), no port, no endpoints.
`/api/v1/strategies` does not exist (test-pinned 404 for all methods — the
no-manufactured-CRUD boundary). Memory/PGlite/real-PostgreSQL tiers unchanged
from increments 3/4 (real PostgreSQL remains NOT IMPLEMENTED, Phase D).

## 6. Tests (exact, on committed tree)

| Command | Result |
|---|---|
| `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` | 0 errors |
| `npm test` | **246/246** (tradeService 22, tradeRoutes 10, tradePersistence 6, tradeLedger 12, prior 196) |
| `npm run test:migrations` | 5/5 |
| `npx tsx tools/parity-smoke.ts` | 6 pass / 0 fail |
| `bash tools/secret-scan.sh` | PASS (0 findings) |
| lint | N/A — no lint script in repo |

## 7. Security — NO REGRESSION

No new code paths beyond tests; auth/ownership/non-disclosure/body-size/
fail-closed controls unchanged and re-verified by the full battery; secret
scan 0 findings; no client-controlled ownership fields introduced.

## 8. Open items (evidence-backed only)

- **Dashboard increment:** per-strategy statistics (formulas + route evidence
  inventoried in §1; Remote test pins winRate format `'1.0000'`).
- **Future product decision (owner):** whether the PHP v0.5 "tags matrix"
  (tags/trade_tags tables, kinds STRATEGY/SETUP/MISTAKE/EMOTION/CUSTOM) is
  promoted to a real capability — requires product owner input; no repository
  evidence of intended API shape exists.
- **Phase J:** trade_features.strategy_tags json (AI feature store) — unused.

## 9. Git evidence

Branch `reconcile/foundation-first`; start `27475de` (clean) → end = this
commit; tree clean at close. `main` (`07977504…`) and tag
`remote-snapshot-99e024c829db` (tree `83621817…`) untouched; 0 remotes.
Push **NO**; merge **NO**; deployment **NO**.
