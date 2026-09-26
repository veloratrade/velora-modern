# METAPI POSITION ASSEMBLY — Implementation Brief (MG-METAAPI-ASSEMBLY)

**Status:** DESIGN ONLY — no implementation. Prepared for owner authorization.
**Recorded at HEAD:** `d85a589ed47f5321c36a8bbedf064929bc489e6b` (branch `governance/agent-context`).
**Date:** 2026-09-26 (Asia/Tehran).
**Gap:** `MG-METAAPI-ASSEMBLY` (P1) — audit §9.2: *"the largest behavioural divergence in the audit"*.
**Sources read this session (VERIFIED):** legacy `api/src/Trades/MetaApiDealAssembler.php` (complete), `api/src/Accounts/MetaApiService.php` (`runNextSyncJob` / `processWebhook` / `reconcileAccount`), `api/database/schema.sql:232`; modern `apps/worker/src/metaapi/syncRepository.ts` (complete), `apps/worker/src/metaapi/normalizeDeal.ts` (complete), `packages/contracts/src/metaapiSync.ts`.

---

## 1. Problem (audit §9.2, confirmed from source)

Modern `importBatch()` creates **one trade row per OUT fill** with
`entry_price = exit_price = fill.price`, `volume = fill.volume`,
`contract_size = 1` hardcoded, and one instant copied across `occurred_at` /
`occurred_open_at_utc` / `occurred_close_at_utc`; `ON CONFLICT … DO NOTHING`
never corrects a previously wrong row. Partial fills, scaled-in positions and
multi-exit positions produce materially wrong journals. Legacy assembles
**one closed-position trade per positionId** from a durable fill ledger.

**In-code contradiction (evidence):** `syncRepository.ts`'s own header claims
"one trade per provider position → UNIQUE (account_id, external_deal_id) on
trades" — the implementation below it does the opposite. The intended design
was already documented; it was never implemented.

## 2. Legacy semantics — the authoritative specification (VERIFIED)

**Reconciliation model (`MetaApiService::reconcileAccount`, VERIFIED):**
assemble from the **durable fill ledger**, not from an in-memory page:

1. `pendingPositionIds(account)` — only positions with unprocessed fills;
   already-aggregated positions are never re-assembled (a later fill flips the
   position back to `received` and reopens assessment).
2. `fillsForPosition(account, positionId)` → `MetaApiDealAssembler::assemble()`.
3. Trades emitted → `insertExternalTrade` **idempotent on
   (account, `pos-<positionId>`)** → fills `markAggregated(fillIds, tradeId)`.
4. No trade emitted → fill state depends on the skip reason:
   - **Terminal** (`close_before_open`, `unknown_direction`) → fills `skipped`
     (a future fill cannot repair these).
   - **Repairable** (everything else: missing open/close side, partial volume,
     unresolved instants) → fills stay `received`; a later webhook/sync fill
     completes the position. **Nothing is ever fabricated.**

**Assembly rules (`MetaApiDealAssembler`, VERIFIED):**

| Field | Rule |
|---|---|
| Grouping | `pos-<positionId>`; fills without a positionId are `unpaired_deal_no_position_id` (skip) |
| Fill filter | only `DEAL_ENTRY_IN`(0)/`DEAL_ENTRY_OUT`(1); balance/credit/INOUT/OUT_BY ignored |
| Dedup | repeated deal id collapsed within one assembly (fill-level idempotency) |
| Emit gate | requires ≥1 IN **and** ≥1 OUT **and** `Σvol(OUT) ≥ Σvol(IN)` (else `position_partially_open` — stays repairable) |
| `direction` | first buy/sell among IN fills |
| `entry_price` / `exit_price` | **volume-weighted average** over IN / OUT fill prices (scale 8) |
| `volume` | `Σ vol(IN)` — the opened position size |
| `profit`/`commission`/`swap` | sum across **all** the position's fills (IN+OUT) |
| Open instant | **earliest IN** `time_utc` (offset-explicit only) |
| Close instant | **latest OUT** `time_utc` — anchored by Velora's own invariant close_time ≥ MAX(trade_exits.exited_at) |
| Ordering | `close < open` → `close_before_open` (terminal skip) |
| `external_deal_id` | `pos-<positionId>` — **the trade's identity is the position, not a fill** |
| Naive `brokerTime` | never an instant (evidence only) |

**`contract_size` (source-verified nuance vs audit §9.2):** the assembler
output carries **no `contract_size`**, and `MetaApiService.php` contains zero
occurrences of "contract" (grep) — legacy assembled trades take the schema
default `contract_size = 1.00000000` (`schema.sql:232`). The audit's "contract
size from the deal" is therefore **not what this code path does**; modern's
hardcoded `1` is parity on this field. The real divergences are assembly,
volume, prices and timestamps. → recorded as observation `MG-OBS-5` (the
immutable audit text is unchanged).

## 3. Modern assets already in place (why this is a contained change)

- `sync_fills` **is already the durable fill ledger** the legacy model needs:
  `position_id`, `entry_type`, direction, symbol, volume, price, profit,
  commission, swap, `occurred_at_utc`, `raw_time_text`, `broker_time_text`,
  `time_status`, `processing_state` (`received|aggregated|skipped`),
  `skip_reason`, `processed_trade_id` — the reconciliation vocabulary exists
  **but is unwired to any assembler**.
- `normalizeDeal.ts` already applies the identical offset-explicit instant
  rule (D-5) and provider-profit authority (D-4) — no change needed there.
- DB idempotency anchors exist: `UNIQUE (account_id, external_deal_id)` on
  both `sync_fills` and `trades`; deterministic `trade_events.event_uid`
  (`metaapi:<account>:<deal>` → becomes `metaapi:<account>:pos-<positionId>`).
- Cursor advances inside the same transaction (retry-safe) — unchanged.

## 4. Proposed design (for authorization; not implemented)

1. **Pure assembler in `packages/domain`** (rule 3: framework-free, I/O-free):
   `assemblePositions(fills): { trades; skipped }` — a faithful port of §2
   using the domain decimal module (ADR-001; no float). No DB, no clock.
2. **Worker reconciliation** (new, mirrors `reconcileAccount`): after each
   batch's fills are ledgered, select pending positions
   (`processing_state = 'received' AND position_id IS NOT NULL`, grouped),
   load their fills, assemble, and for each emitted trade INSERT keyed by
   `pos-<positionId>` with `TRADE_IMPORTED` (actor `sync`, deterministic uid),
   then `markAggregated`. Repairable skips stay `received`; terminal skips
   (`close_before_open`, `unknown_direction`) become `skipped` with reason.
3. **`importBatch` slims down** to fill-ledger insert + cursor advance (trade
   creation moves to the reconciliation step). One transaction preserves the
   cursor-safety property.
4. **Schema:** expected **no migration** — all columns exist. Implementation
   must verify an index for the pending-positions lookup
   (`sync_fills(account_id, position_id) WHERE processing_state='received'`);
   if missing, that is the only DDL (additive, forward-only).
5. **Out-of-scope (tracked separately):** sync cadence and manual trigger
   (`MG-METAAPI-CADENCE`), webhook-time assembly (audit §4.3 REPLACED design),
   dashboard surfaces.

## 5. Owner decision points (OD-M-PA namespace)

| ID | Decision | Recommendation |
|---|---|---|
| **OD-M-PA-1** | **Repair strategy for already-imported per-fill rows.** No production/staging dataset is deployed (worker never ran; Gate 3B 0/20), so exposure is dev/local only. Options: (a) tombstone per-fill rows + re-import as positions (ADR-002-clean); (b) in-place correction event; (c) truncate-and-reimport dev data. | **(a)** — fits the append-only ledger; trivial while no deployed data exists |
| **OD-M-PA-2** | **Convergence on re-assembly:** legacy **upserted**; modern trades + `ON CONFLICT DO NOTHING` never corrects. Keep DO NOTHING and rely on full re-reconciliation from the immutable fill ledger when repair is needed? | Keep **DO NOTHING**; fills are the durable source of truth — repair = re-reconcile (consistent with ADR-002 and the append-only REVOKEs) |
| **OD-M-PA-3** | Confirm the `contract_size = 1` parity reading (§2) and close the audit §9.2 nuance as `MG-OBS-5`. | Accept the source-verified reading |

## 6. Test plan (acceptance criteria)

- **Golden vectors (domain):** single IN+OUT; scaled-in (2 IN, 1 OUT); partial
  close (1 IN, 2 OUT) → exit = VWAP of OUTs, volume = Σ IN; multi-exit sums;
  OUT < IN → repairable skip; no IN side → repairable skip; unresolved instant
  → repairable skip; `close_before_open` / `unknown_direction` → terminal;
  repeated deal id dedup; keyless fill skip; decimal exactness (no float).
- **PG battery (worker):** pos-key uniqueness under replay; cross-batch
  completion (IN in batch 1, OUT in batch 2 → one trade, fills aggregated
  once); concurrent reservation (existing 0012/0013 proofs must stay green);
  cursor rollback on failure.
- **Regression:** `node tools/run-tests.mjs` (804) + typecheck + secret-scan.

## 7. Estimated touch set (for scope review)

`packages/domain/src/metaApiPositionAssembly.ts` (+ test) ·
`apps/worker/src/metaapi/syncRepository.ts` (slim + reconcile) · possibly
`apps/worker/src/metaapi/positionReconciler.ts` (+ test) ·
`packages/contracts` type additions · (optional) one additive index migration.
No API route, no web, no schema rewrite.
