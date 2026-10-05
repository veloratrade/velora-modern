# Evidence: MetaAPI Position Assembly (MG-METAAPI-ASSEMBLY / AC-28)

Date: 2026-10-05
Branch: `integration/reconcile-lineages` @ `af782f4` + AC-28 working tree
Verification state: **RECORDED_RUNTIME** (all evidence from real PostgreSQL 17.11 + the repo's own batteries, recorded in this session). LIVE provider round trip: **NOT_VERIFIED** — no MetaAPI credentials exist in this environment.

## What was built (per `docs/reconciliation/METAAPI_POSITION_ASSEMBLY_BRIEF.md` §4)

| Layer | Artifact | Purpose |
|---|---|---|
| Domain | `packages/domain/src/metaApiPositionAssembly.ts` (+ `.test.ts`) | Pure port of Legacy `MetaApiDealAssembler`. One trade per POSITION (`pos-<positionId>`), VWAP entry/exit at scale 8, Σ-IN volume, IN+OUT financial sums, earliest-IN/latest-OUT boundaries. 19/19 golden vectors derived from the Legacy reference matrix. |
| Schema | `db/migrations/0029_metaapi_position_assembly.sql` | `sync_position_state` companion table restoring Legacy's received→aggregated / skipped state machine WITHOUT relaxing the `sync_fills` append-only control (brief decision D1). |
| Worker | `apps/worker/src/metaapi/positionReconciler.ts` | `reconcileAccount` port: dedupe by deterministic event uid `metaapi:<account>:pos-<positionId>`, occurred_at = position close, duplicate-trade convergence (finds tombstoned rows), re-open on later fills, terminal skips (`close_before_open`, `unknown_direction`) durable, repairable skips stay `received`. |
| Worker | `apps/worker/src/metaapi/syncRepository.ts` | `importBatch` reworked: fill-ledger inserts → state upsert ONLY on newly-inserted in/out fills with a valid positionGroupKey → reconcile INSIDE the same transaction → cursor advance. |
| Ops | `ops/metaapi/retirePerFillTrades.ts` | OD-M-PA-1(a) remediation tool. Dry-run default; `--execute` tombstones per-fill trades (`source='metaapi' AND external_deal_id NOT LIKE 'pos-%' AND deleted_at IS NULL`) via `TOMBSTONE_SET`; re-assembly of affected positions is automatic via the self-healing pending query (no backfill needed). |

## Verification evidence (all executed 2026-10-05, AFTER the pendingPositionIds/upsert rework)

| Battery | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npx tsx --test db/tests/metaapiAssembly.pg.test.ts` (real PG) | **8/8 PASS** — golden vectors, cross-batch assembly (net 100.00 / comm −3.00 / swap −0.50, VWAP entry 1.11000000 exit 1.13200000, volume 1.0, close = latest OUT), idempotent replay, terminal skips, self-heal (`pos-HEAL` net 66.25), concurrency race (parallel syncs → exactly 1 FULFILLED + 1 REJECTED `RESERVATION_HELD`, exactly 1 trade + 1 event), tombstone convergence. |
| `npx tsx --test db/tests/metaapiSync.pg.test.ts` (real PG) | **13/13 PASS** (E7/E8/E11 rewritten to per-position semantics) |
| `npx tsx --test db/tests/pgRoles.pg.test.ts` (real PG, superuser) | **23/23 PASS** incl. P19 (assembly projection contract) |
| `npm test` (full local) | **1282 pass / 0 fail / 0 skip** (1219 general + 63 PGlite) |
| Ops tool E2E (scratch DB `velora_assembly_test`, script deleted after use) | dry-run → 1 candidate / 0 writes; `--execute` → 1 tombstone; re-run → 0; empty-batch sync re-assembled `pos-OLD` as trade 9 with entry 1.10000 ≠ exit 1.10500, net 42.00 preserved (old per-fill trade 8 tombstoned). |

Full-battery context: the 32-battery / 64-run real-PG set passed on the pre-AC-28 tree (logs: `/tmp/pg-batteries-run.log` — session-local, not committed); AC-28 changes were then re-verified with the targeted batteries above plus the full local suite.

## Key design decisions (recorded for ratification)

- `pendingPositionIds` final query (self-healing — includes positions whose state row is missing OR still `received`):
  `SELECT DISTINCT f.position_id FROM sync_fills f LEFT JOIN sync_position_state s ON s.account_id=f.account_id AND s.position_id=f.position_id WHERE f.account_id=$1 AND f.position_id IS NOT NULL AND f.position_id ~ '^[A-Za-z0-9._:-]{1,64}$' AND f.entry_type IN ('in','out') AND (s.position_id IS NULL OR s.state='received') ORDER BY f.position_id ASC`
- State upsert fires ONLY for newly-inserted in/out fills; balance/keyless fills get no state row (nothing to aggregate).
- Trade identity: `pos-<positionId>`; event uid: `metaapi:<account>:pos-<positionId>`; occurred_at = close instant.
- Duplicate-trade convergence searches tombstoned rows too (a tombstoned per-fill trade converges onto the `pos-` identity without double-counting).

## Open items (owner-gated)

1. **OD-M-PA-1 / OD-M-PA-2 / OD-M-PA-3** — adopted per their recorded recommendations; ratification pending.
2. **LIVE provider round trip** — NOT_VERIFIED (needs MetaAPI credentials and a real account sync).
