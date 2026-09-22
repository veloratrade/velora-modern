# Phase C Increment 3 Record — Trades (2026-09-12)

**Scope:** Trades capability only. Start HEAD `cf19d9b3b52af604ad44819228ac49660cfb41f4`
(increment-2 terminal, clean tree, baseline 206/206 verified before any change).
Inventory: `docs/reconciliation/PHASE-C-INC3-TRADES-INVENTORY.md`.

| # | Commit | Content |
|---|---|---|
| 1 | `4e4937b` | trades inventory (read-only, both lineages) + `EXIT_CANCELLED` contract type |
| 2 | `6b08d4c` | domain fold extension + TradeStore port + MemoryTradeStore + TradeService + tests |
| 3 | `cff5b85` | 0005 migration + engine transactions + PGlite store + persistence tests (amended once to include the replay-payload service refactor that belongs to this unit) |
| 4 | `1330e7d` | kernel routes (9) + server-main dev wiring + HTTP contract tests |
| 5 | this commit | evidence record + AGENTS.md row |

## Capability matrix (Remote evidence | Local behavior | Classification)

- **Create `POST /trades`** — Remote validation matrix + PnL server-computed | ported onto `TRADE_CREATED` ledger event; commission/swap validated at scale 2 (ADR-001 — stricter than lineages' (10,8), DOCUMENTED DIFFERENCE); accountId ownership → 400 `accountNotOwned` (lineages agree) | PORT
- **Get `GET /trades/:id`** — flat trade, non-disclosing 404 | ported (string ids; `version` exposed — Local addition) | PORT
- **Search `GET /trades`** — symbol CONTAINS / direction / from→openTime≥ / to→closeTime≤ / page/limit / openTime DESC; `q`,`order` accepted-but-ignored (repository-verified) | ported exactly; limit clamp 1..200 (PHP — Remote unclamped, DOCUMENTED DIFFERENCE) | PORT
- **Update `PUT /trades/:id`** — mutable row, full revalidation, PnL recompute | journaling-only `JOURNALING_EDITED` event + version; financial fields → 403 FORBIDDEN (ADR-002 ownership matrix: user never emits FINANCIAL_CORRECTED); remedy tombstone+recreate; empty PUT = 200 no-op (Remote-evidenced) | **REDESIGN (ADR-002)**
- **Delete `DELETE /trades/:id`** — physical delete + exits purged | `TOMBSTONE_SET` + `deleted_at`; 404 after; `{deleted:true}` ported | **REDESIGN (ADR-002)**
- **Exits `GET/POST /:id/exits`, `DELETE /exits/:exitId`** — cumulative cap 422, chronology 422, proportional cost allocation, list ASC | ported + PHP input hardening (exitType choice, positive decimals, notes≤255); exit delete = tombstone + `EXIT_CANCELLED` + allocation decrement | PORT + PHP HARDENING + **REDESIGN (ADR-002)** for deletion
- **Symbols `GET /trades/symbols`** — absent in Remote; PHP `{symbols}` DISTINCT ORDER BY | ported (route order before `/:id` per PHP) | PORT (PHP)
- **Time model** — Remote server-local parse → UTC-naive string; PHP account-TZ canonical (users.timezone display-only) | **user profile TZ (ADR-004 D-11)**, two-pass DST-safe Intl conversion, ISO-8601 Z, `timeStatus` resolved/unresolved, raw preserved | **REDESIGN (ADR-004 — ADR wins)**
- **Session/Jalali engine, extract-screenshot, MetaApi routes** — PHP subsystems | NOT IMPLEMENTED (`session:'unconfigured'` placeholder ported from Remote) | NOT IMPLEMENTED (Phase H/J)

## ADR-002 traceability

- **Immutable ledger:** no in-place mutation, no physical DELETE anywhere; every mutation = append-only `trade_events` row (`event_uid` UNIQUE).
- **Corrections:** user corrections = `JOURNALING_EDITED` (financial corrections reserved to sync/webhook/admin — Phase H conflict policy per ADR open Q3).
- **Tombstones:** trade delete and exit delete are tombstones; tombstoned ≡ missing (non-disclosing 404); fold `TombstoneError` blocks further mutation.
- **Ownership:** every store query user-scoped; foreign ≡ missing ≡ tombstoned; accountId ownership verified pre-create (400).
- **Idempotency:** manual create has NONE (evidenced absence in both lineages — duplicates create duplicates; documented, not invented); event replay dedup via `event_uid`; `(account_id, external_deal_id)` UNIQUE reserved for Phase H sync upserts.
- **Concurrency:** optimistic `expectedVersion` → 409 CONFLICT on every mutation; fold over-allocation guard AND 0001 DB trigger double-enforce; PGlite store uses single-session transactions + `FOR UPDATE` (in-wasm — real multi-client locking = Phase D).
- **Auditability:** every mutation persists its full domain `LedgerEvent` in the event payload; PGlite test proves **projection == fold(event replay)** over a 6-event trade life.

## PnL integration (Local engine = authority)

- Verified: vector A (the Remote integration-test create payload) → net 493.5 / r 1.645 through `computePnl(…, "half-even")` at create; proportional exit allocation (ratio scale 8, costs at currency scale 2) reproduces 145.00 for the evidenced 0.5/1.0 case with commission 10.00.
- Intentional differences (all documented, none silent): `half-even` for new computations (ADR-001; Remote truncates at scale 8 in places); exit cost allocation rounded to scale 2 (lineages keep 8); increment-2 vector divergences (B risk, C r, D net) unchanged — engine untouched.
- Unresolved fixtures: none introduced; external serialization precision remains OD-3 fixture-pending.

## Persistence boundary (never combined)

1. **Memory adapters** (MemoryTradeStore/MemoryUserStore/MemoryAccountStore): dev/test, promise-chain serialization (Remote's own in-memory pattern), no durability claims.
2. **PGlite in-wasm** (tradePersistence.test.ts, migrations 0001–0005): real service + port + SQL contract incl. trigger and CHECK enforcement. **PGlite ≠ real PostgreSQL ≠ production.**
3. **Real PostgreSQL: NOT IMPLEMENTED — Phase D** (durable stores, multi-client transactions/locks, real-PG verification of the ledger invariants).

## Tests (exact, on committed tree)

| Command | Result |
|---|---|
| `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` | 0 errors |
| `npm test` | **236/236** (tradeLedger 12, tradeService 16, tradeRoutes 8, tradePersistence 4 PGlite, + prior 196) |
| `npm run test:migrations` | 5/5 |
| `npx tsx tools/parity-smoke.ts` | 6 pass / 0 fail |
| `bash tools/secret-scan.sh` | PASS (0 findings) |
| lint | N/A — no lint script in repo |

## Security review — NO REGRESSION

No secrets/credentials/tokens added (test-only constants clearly marked; scan 0 findings); auth boundary unchanged (401 before any service call); ownership enforced on every route (cross-user non-disclosure test-verified at service, store, and HTTP layers); fail-closed 503 unconfigured (test-evidenced); body-size cap + JSON-object validation unchanged (kernel `parseJsonBody`); no DB ops in HTTP handlers; no floats in money (domain decimal module throughout); ADR-002 hardening ADDS tamper-evident history and 409 concurrency semantics.

## Documented differences / open items

- PUT financial fields → 403 (ADR-002); Remote/PHP allow user financial edits (REMEDY: tombstone + recreate). Exit-input status 400 (PHP) vs Remote unvalidated; volume-cap/chronology 422 (Remote integration-test evidenced; PHP likely 400 — fixture-pending detail).
- `EXIT_CANCELLED` added to the event vocabulary (constraint widened in 0005, forward-only) — the ADR-002-compliant representation of the evidenced exit-deletion endpoint.
- Exit 404 code `NOT_FOUND` (Remote) vs PHP `TRADE_EXIT_NOT_FOUND` — Remote wins; PHP difference documented.
- `q`/`order` search params accepted and ignored (Remote-verified dead params) — no parity claim made.
- server-main: increment-2 had added capability imports without wiring them into `createApp` (found during this increment's delivery work; actual wiring completed in `1330e7d`).
- Phase H: MetaApi sync/import sources, conflict field-group mapping (ADR open Q3), session/Jalali engines, `external_deal_id` idempotent upserts. Phase D: real-PG stores + multi-client locking. Phase J: extract-screenshot, raw_*_text population.

## Git evidence

Branch `reconcile/foundation-first`; start `cf19d9b` (clean) → end `1330e7d` + this record; tree clean at close. `main` (`07977504…`) and tag `remote-snapshot-99e024c829db` (tree `83621817…`) untouched; 0 remotes. Main merge **NO**; Remote-snapshot change **NO**; push **NO**; merge **NO**; deployment **NO**.
