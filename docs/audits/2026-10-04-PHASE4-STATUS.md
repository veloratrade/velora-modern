# Phase 4 — Data integrity & migration · status report

**Date:** 2026-10-04 · **Branch:** `feat/telegram-journal-client` · **Phase start SHA:** `e2849ac`
**Scope (mission §9):** data integrity and migration — PLT-02, cutover rehearsal,
backup/restore, PnL guards, `r_multiple` scale, timezone semantics. Never
destructive without a rehearsal.

**Headline:** the phase's two P1 gaps are no longer "nothing was ever done". A real
`r_multiple` parity rule exists, the financial invariants are enforced by the
database, **a real backup was restored and verified**, and **the load rehearsal
runs — and refuses**. What is still open is open for a named reason, not for lack of
work.

---

## 1. What changed (four commits)

| Commit | Change | Capability |
|---|---|---|
| `492e3f5` | `packages/domain/src/legacyParity.ts` + 8 tests | **MG-RMULTIPLE-SCALE closed** |
| `ec2f94a` | `db/migrations/0025_trade_financial_guards.sql` + 9 real-PG tests + 10 fixture alignments | **PLT-02**: the DB now enforces Legacy's `v0.3` financial invariants |
| `1c847b8` | `tools/lib/testRunnerVerdict.mjs` + 9 tests; runner rewritten | **defect**: a RED suite could be reported GREEN |
| `a02a38d` | `ops/backup/restore_drill.mjs` + core + 13 tests + evidence | **MG-BACKUP-RESTORE**: real backup, **restored**, verified |
| `b301596` | `tools/load_rehearsal.ts` + `tools/lib/legacyLoadGates.ts` + 12 tests + fixture + evidence | **MG-DATA-MIGRATION**: the gates became executable and refusing |

### 1.1 `r_multiple` scale (MG-RMULTIPLE-SCALE → CLOSED)

Legacy stores `r_multiple` at scale 4 (bcmath, which **truncates toward zero**);
Modern at scale 8 (ADR-001 §3: "storing at higher precision than display never
loses parity"). ADR-001 decided storage and never said how the two are **compared** —
which is what the migration and the parity gate both need. The rule now lives in one
place:

* an imported value is preserved **by value** ("1.6450" → 1.64500000, nothing
  rounds it again — rounding again is how a migration invents data);
* a historical recomputation is compared at the **legacy scale with the legacy mode**;
* the mode is **load-bearing**: `1.000099999` truncates to `1.0000` but half-even
  rounds to `1.0001`, so a recomputation using the modern default would fail roughly
  1 in 10 000 non-terminating quotients — a flaky parity gate is how a real
  divergence gets ignored;
* truncation is toward zero and idempotent (the migration's own property).

Evidence: 8 unit tests, plus the rehearsal's gate 6 recomputing 5 migrated trades to
their stored `net_pnl` **and** `r_multiple`.

### 1.2 Financial guards in the database (PLT-02)

Legacy shipped `v0.3_trade_financial_consistency.sql`, which refuses to deploy while
a trade is unresolved — "never invent an exit price". Modern validated the same list
in `TradeService` **and nowhere else**, so any other writer could store a zero price,
a close instant before its open instant, or a CLOSED trade with no exit price and no
PnL. `0025_trade_financial_guards.sql` is that list, translated to the modern column
set (Modern's one addition, OPEN, is expressed as "when a value exists it must be
valid" + "a CLOSED trade is financially complete").

**Fail-loud is proven, not asserted:** a real-PG test builds a scratch database at the
pre-0025 chain, loads exactly the row Legacy refused to deploy with, runs the real
chain, and checks that the migration **aborts**, is not recorded as applied, and
leaves no half-guard behind.

Runtime probe (live API + guarded database): **8/8** — the ordinary CLOSED create
still succeeds and stores a complete row; a half-recorded trade is refused at the API
(400) exactly as Legacy's NOT NULL columns refused it; raw SQL with `exit_price = 0`
is refused by the database; analytics still reads the stored numbers.

### 1.3 A defect in the test runner: a RED suite could be reported GREEN

Found while running the suite after 0025. The run ended `# fail 7` +
`ALL TEST FILES PASSED (after re-running OS-killed files individually)` + **exit 0**.
The OOM-retry logic treated "batch failed, **zero** OS kills" — the one shape that
means real failures — as "retried successfully", because `retrySigkilled([])` returns
`true`. Seven genuine failures were masked by the very change that was supposed to
make the suite honest.

The verdict now lives in `tools/lib/testRunnerVerdict.mjs` (9 unit tests), fail-closed:
a failed batch is excusable **only** when every failure is accounted for by a killed
file; more failures than kills → FAIL, no retry; an unparseable summary → FAIL; a kill
that cannot be mapped to a source file → FAIL. Replaying the captured real output of
the affected run through the new logic reports: *7 failure(s), none of them an OS kill
— assertion failures are never retried*.

### 1.4 A real backup, restored and verified (MG-BACKUP-RESTORE → PARTIAL)

| Step | Result |
|---|---|
| artifact | `db-backup-staging-20261004095454-bb023e0cab03` · 32 926 bytes · sha256 `b289558f…` (project's own producer) |
| restore | `pg_restore` into a disposable database · 343 ms |
| parity | **PASS** — 44 tables, 49 numeric columns, exact decimal SUMs, `schema_migrations` head `0025` |
| smoke | **PASS** — 11/11 (`PG_SMOKE_SCHEMA=restored`) against the RESTORED copy |
| verdict | `RESTORE_VERIFIED` · `storage_status: NONE` · ADR-012 gate **REJECT** (no `release_tag`, storage not verified) |

The first run **failed** and is kept as evidence: the smoke was asserting a fresh
migration apply, the wrong claim about a restored copy. Two defects were fixed rather
than the drill being relaxed. Honest limits: the sandbox's disposable PostgreSQL, not
staging/production; nothing was uploaded (no credential), so the gate keeps rejecting
the record — as it should.

### 1.5 The load rehearsal (MG-DATA-MIGRATION → PARTIAL)

`tools/load_rehearsal.ts` runs `docs/migration-strategy.md` §6 / `load_gates.sql` as
one command: A-gates on the export, an id-preserving load, B-gates, evidence. The
A-gates encode the gates' own rule — **every distinct out-of-vocabulary value needs an
explicit mapping, or the load does not happen** — and a value whose validity cannot be
established is **quarantined, never invented**.

Executed against the synthetic fixture (labelled `synthetic: true` in the manifest,
the decisions file and the evidence):

```
A1  MAPPED      source auto_sync → metaapi                     A7  QUARANTINE  1 unresolved timeline → excluded, reason written
A6  MAPPED      XAU/USD → XAUUSD (contract size never inferred) A12 MAPPED      2 columns with no target, both recorded with reasons
load            4 users · 3 accounts · 5 trades (6 − 1 quarantined) · 2 exits, ids preserved (OVERRIDING SYSTEM VALUE + setval)
B1/B2 PASS      row-count parity and EXACT money parity (commission 16.50 · swap −1.00 · net 1484.50)
B3/B5/B7/B8     PASS — vocabulary, no cross-owner rows, no money beyond 2 dp, derived tables empty
gate 6 PASS     PnL golden recomputation: 5/5, R compared at legacy scale 4
```

**A12 is the new gate** and closes the "unmapped tables = data loss risk" half of
MG-SCHEMA-MAPPING: every exported column must be declared with a target **or** with
`target: null` + a reason; an undeclared column is a hard FAIL.

**A real finding came out of writing the mapping down:** Modern's `subscriptions`
table is the **Stripe** object (`provider CHECK (provider = 'stripe')`, `plan CHECK
pro|enterprise`, partial unique index on active rows). It is **not** a target for
Legacy's provider-less lifecycle (`none|active|past_due|grace|expired|cancelled` +
`plan_started_at/plan_expires_at/plan_updated_at`). Loading those columns there would
fabricate a billing subscription for a user Legacy never billed, in a vocabulary that
does not accept them. They are recorded as unmapped with that reason; the
user-visible fact survives in `users.plan`. The mapping is an owner decision
(`OD-AC-SUBMAP`).

---

## 2. Gate results

| Gate | Command | Result |
|---|---|---|
| Full suite | `npm test` | **999 general + 63 PGlite, 0 fail, EXIT=0** (after the fixture alignment; the pre-fix run is the evidence for the runner defect) |
| Real-PG batteries | `tools/run-pg-batteries.sh` | **28 files / 56 runs (forward + reversed) / 0 failures** |
| Typecheck | `npm run typecheck` | clean |
| Secret scan | `tools/secret-scan.sh` | **PASS (0 findings)** — the drill's fixture connection strings are assembled at runtime |
| New batteries | `tradeFinancialGuards` 9/9 · `legacyParity` 8/8 · `restoreDrill` 13/13 · `legacyLoadGates` 12/12 · `runTestsVerdict` 9/9 | 51 new assertions |
| Restore drill | `node ops/backup/restore_drill.mjs` | **PASSED** — evidence committed |
| Load rehearsal | `npx tsx tools/load_rehearsal.ts` | **REHEARSAL_PASSED** (synthetic fixture) — evidence committed |
| Smoke | `tools/pg-smoke.ts` | 11/11 in **both** modes (fresh apply on a virgin DB, `restored` on the restored copy) |

---

## 3. Status changes

| Item | Before | After | Why |
|---|---|---|---|
| MG-RMULTIPLE-SCALE | OPEN (P2) | **CLOSED** | parity rule + tests + rehearsal gate 6 |
| MG-BACKUP-RESTORE | OPEN (P1) | **PARTIAL** | drill executed and verified; offsite storage + production drill + RPO/RTO remain |
| MG-DATA-MIGRATION | OPEN (P1) | **PARTIAL** | rehearsal executable and executed; ADR-004 decision + real export remain |
| MG-SCHEMA-MAPPING | PARTIAL (P2) | PARTIAL (enforced) | A12 + the written per-column record; the subscription decision remains |
| MG-G13 | OPEN | **PARTIAL** (`CURRENT_RUNTIME_VERIFIED`) | the restore half is proven |
| PLT-02 | MISSING | **IMPLEMENTED** | guards enforced + rehearsal executed (real export pending) |
| PLT-04 | MISSING | **IMPLEMENTED** | real backup + verified restore drill (offsite upload pending) |

No existing user capability was removed. No legacy table, column or row was dropped,
rewritten or archived.

---

## 4. Not claimed (deliberately)

* **Not** a production migration: no production data was exported, read or copied;
  the rehearsal ran on a synthetic fixture and says so in its evidence.
* **Not** deployed or live-verified: nothing was pushed to a server, no upload to
  `veloratrade/velora-backups` happened, and `storage_status` stays `NONE`.
* **Not** the ADR-004 decision: the naive-datetime interpretation is still the
  owner's; unresolved rows were quarantined, never interpreted.
* **Not** full schema coverage: the deferred tables remain deferred, each with the
  phase that owns it written down.

## 5. Remaining gaps in phase scope, with reason and next step

| Gap | Status | Reason it is not closed | Next step |
|---|---|---|---|
| MG-BACKUP-RESTORE | PARTIAL | needs a storage credential (owner) + a deployed environment | offsite upload + re-hash; then a scheduled drill on staging |
| MG-DATA-MIGRATION | PARTIAL | ADR-004 sampling decision + read-only access to a real export (owner) | run the rehearsal on the real export the moment both exist |
| MG-SCHEMA-MAPPING | PARTIAL | the legacy subscription lifecycle has no target; later-phase tables are owned by their phases | owner decision `OD-AC-SUBMAP`; each phase closes its own rows |
| RPO/RTO | OPEN | owner decision (`OD-AC-RPORTO`) | decide targets, then WAL archiving for PITR |

## 6. Next phase

Phase 5 — **support**: make the ticket surface a real capability (not a shell),
reusing the existing shell's route/design, with authorization, persistence and
lifecycle tests. The `support_tickets`/`support_messages` legacy tables remain
unmapped until that phase gives them a target — which is exactly what the register
now requires.
