# Phase D — D4 Service-Level Trade Concurrency (Real PostgreSQL)

**Status: GREEN — GHA run 34764562392 @ 185c02e — D4 battery 14/14, 0 fail, 0 skipped, on real PostgreSQL 16.15 (postgres:16-alpine service container).** Production code, schema, and dependencies are UNCHANGED by D4 (verification-only package, per authorization). D5/D6 and Phases E–P are not started. No pass is claimed for anything that did not execute.

Owner authorization (2026-09-13): D4 implementation, strictly limited to **service-level trade-concurrency verification on real PostgreSQL**, canonical evidence environment GitHub Actions. The D4 preflight (same date, read-only) derived the scope from the repository: D2's boundary record defines D4 as "full trade-concurrency verification beyond the store-level races" (`docs/evidence/PHASE-D-D2-PG-ADAPTERS.md`), with the D2-built primitives (version CAS, `FOR UPDATE`, `velora_apply_exit`, tombstones, `event_uid` uniqueness) to be exercised, not redesigned.

## Implementation (commits `90f341a` + `185c02e`, branch `reconcile/foundation-first`)

| File | Change | Class |
|---|---|---|
| `db/tests/pgTradeConcurrency.pg.test.ts` | NEW — 14 env-gated real-PG tests (the D4 matrix A–N) | VERIFIED (code + execution) |
| `.github/workflows/postgres-evidence.yml` | NEW clearly-named D4 step with in-step anti-SKIP assertions (`# pass 14` / `# fail 0` / `# skipped 0` from the raw log, `set -o pipefail`) + header/scope-note updates | VERIFIED (execution) |
| `docs/evidence/PHASE-D-D4-TRADE-CONCURRENCY.md` | this record | — |
| `AGENTS.md` | artifact-table row | — |

**No migration. No schema change. No dependency. No production-code change. No new event types, actors, or producers** (Phase E/F/H/K boundaries respected; webhook/sync replay convergence remains Phase H; the D4 idempotency check is constraint honesty only).

## Test architecture (authorization §5, D3 pattern)

Two independent `TradeService` instances over ONE shared pg pool (correctness from the database, never process-local state; the trade service has no process mutex by design). Every pool connection sets **explicit `statement_timeout` (20 s) and `lock_timeout` (10 s)** — no PostgreSQL server defaults relied upon (D1-spike R8). Deterministic clocks and event-UID generators injected; races fired via `Promise.all` (no sleep-based tests). `pool.on("error")` neutralized for idle-client socket noise (D3 lesson).

## What the 14 tests prove (verbatim `ok` lines from the run log)

```
ok 1  - A1  MIXED RACE createExit vs updateTrade → winner-set invariants, exact contracts, no lost event
ok 2  - A2  MIXED RACE createExit vs deleteTrade (tombstone) → winner-set invariants
ok 3  - A3  MIXED RACE updateTrade vs deleteTrade → winner-set invariants
ok 4  - B   different-trade concurrency: simultaneous edit/exit/tombstone all succeed; foreign user non-disclosing 404
ok 5  - C   service-level stale CAS → exact 409 CONFLICT, no event written
ok 6  - D1  concurrent FULL-volume exits (8 racers, two services) → exactly ONE success; losers exact 409/422; allocation exactly 1.0
ok 7  - D2  concurrent PARTIAL exits (8 × 0.2) → every failure exact 409/422; allocation == 0.2 × successes exactly; never over-allocated
ok 8  - E   createExit vs deleteExit race → allocation increment/decrement exactly consistent
ok 9  - F/N tombstone finality: every mutation path non-disclosing 404; no resurrection; version frozen; no new events
ok 10 - G   over-allocation → 422 with FULL rollback (serial + concurrent); no partial exit row/event
ok 11 - H   lock release after failure: subsequent mutations complete within explicit timeouts
ok 12 - I/J duplicate event_uid → honest constraint failure + FULL rollback (idempotency boundary)
ok 13 - K   NUMERIC exactness after races — ADR-001 scales as exact strings
ok 14 - L/M no lost events + bounded replay: projection == fold(trade_events) for every raced sequence
```

### Concurrency guarantees proven (closure requirements → evidence)

- **Deterministic outcomes**: mixed races admit exactly two legitimate interleavings — overlapping (one winner + exact 409/404 loser) or serialized (both succeed, second re-reads the fresh version) — and every run's outcome satisfies the invariants: version == committed mutations, one event per committed mutation, allocation exact, no lost update, no double-apply.
- **CAS conflicts map correctly**: stale/lost CAS → exactly `409 CONFLICT "Version conflict."` through the real service (test C; losers in every race).
- **Allocation correct**: 8-way full-volume race → exactly 1 exit, `allocated_volume = 1.00000000`; 8×0.2 partial race → `allocated_volume = 0.2 × k` exactly (scale-8), never over `volume`; create-vs-cancel race → increment/decrement exact and order-independent (0.3+0.5−0.3 = 0.50000000 either order).
- **Rollback proven**: over-allocation (serial + concurrent) leaves zero partial exit rows and zero partial events; duplicate `event_uid` rolls back the entire transaction including the projection insert (constraint honesty).
- **Locks release after failure**: after a burst of failing mutations, subsequent edit + exit-cancel on the same trade complete promptly within the explicit timeouts.
- **No lost events / tombstones cannot resurrect**: post-tombstone every path (edit, exit, delete-again, exit-cancel, read) is a non-disclosing 404 byte-identical to a never-existent id; version frozen; zero post-tombstone events; physical row preserved.
- **Replay invariant (ADR-002)**: for every raced trade (≥10 sequences incl. a 7-event deterministic mixed sequence), folding `trade_events.payload.event` through the domain `applyEvent` reproduces the projection exactly (version, allocation scale-normalized, journaling, tombstone state).
- **NUMERIC preservation**: all `NUMERIC(20,8)`/`(20,2)` values are exact strings at the driver boundary after races, matching ADR-001 scale regexes; allocation arithmetic runs inside PostgreSQL (trigger), never floats.

## Real-PG execution: GREEN — run 34764562392 (VERIFIED — real PostgreSQL)

| Field | Value |
|---|---|
| Workflow run | `34764562392` (workflow_dispatch) — success; all 14 steps success |
| Commit under test | `185c02eeab2e6adb85fdefd2a24ada9f46db18b3` |
| Database | disposable `postgres:16-alpine` service container — **PostgreSQL 16.15** (`PASS S1a server_version = PostgreSQL 16.15 (real server, not PGlite)`), destroyed with the job |
| D1 smoke | re-confirmed: S1–S9 ALL PASS (incl. S5 trigger, S7 cross-session `FOR UPDATE` + 57014) |
| D2/D3 batteries | re-confirmed: 6+3+11+6+4 = **30/30, 0 skipped** (unchanged) |
| **D4 battery** | **14/14 pass — 0 fail — 0 skipped** (`# tests 14 / # pass 14 / # fail 0 / # skipped 0` verbatim); in-step anti-SKIP assertions executed and passed |

## First run and root-cause classification (honest ledger)

Run `34764232409` @ `90f341a` (first dispatch) failed **5 of 14** — classified before any fix, per authorization §7:

1. **A1/A2/A3/E — "expected 1, actual 2"**: the battery wrongly asserted "exactly one winner" for service-level races. The service pre-read is advisory and unlocked; a fully-serialized interleaving lets the second racer re-read the fresh version and legitimately succeed too. **NOT a production race** — in every failing case the production invariants held (no lost update, no double-apply, events/versions consistent). Fix: winner-set invariants (k ∈ {1,2} with exact per-outcome loser contracts).
2. **L/M — `'0'` vs `'0.00000000'`**: the domain fold's initial allocation is the string `"0"` while PostgreSQL renders `NUMERIC(20,8)` as `"0.00000000"` — equal values, different string forms. Fix: scale-8 normalization in the comparison (integer math only).

Both defects were in the NEW battery's expectations. **Production code: no race demonstrated, no change made** (authorization §7: "If all races pass: DO NOT modify production code unnecessarily"). Commit `185c02e` (battery-only fix) → re-dispatch → GREEN above. This mirrors the D2 precedent of honest intermediate failures with root-cause records.

## Local verification (this workspace — separate evidence class, NOT real-PG evidence)

typecheck 0 errors · full local battery **ALL TEST FILES PASSED** (PGlite/memory class) · migrations test pass · `secret-scan` **PASS (0 findings)** · D4 battery SKIP-path **14/14 skipped, 0 fail** with `DATABASE_URL` unset (SKIP-safe; a local SKIP is NOT D4 evidence).

## Railway

**Not used for D4.** Railway remains a supplementary integration environment; no D4 deployment, no Railway access, no variable/infra change occurred in this phase (canonical closure required GHA alone, per authorization §14). Optional supplementary deployed-app race probes could be proposed separately but were not performed and are not claimed.

## Scope boundaries honored

No Phase E ledger enforcement, no pg-boss/queue, no MetaAPI/sync/webhook producers, no `FINANCIAL_CORRECTED`/`ADMIN_CORRECTION` producers, no ON CONFLICT import behavior, no email/OCR/admin/i18n/trusted-proxy work, no production or canonical-staging access, no DNS/cutover. `db/roles.sql` remains D5 scope; consolidated evidence remains D6 scope.

## Not proven here (do not silently cross)

- Webhook/sync replay convergence (no producers exist — Phase H).
- The full application battery on real PG and the `roles.sql` privilege layer (D5).
- Randomized property-based replay beyond the exercised sequences (bounded replay proven; a broader property suite would be a separate, explicitly-sized decision).
- Anything about production readiness — no production environment exists.
