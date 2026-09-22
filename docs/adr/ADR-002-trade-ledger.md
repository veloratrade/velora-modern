# ADR-002 — Trade Ledger & Mutation Semantics

## Status

Accepted — owner decision D-01 (2026-08-29): **Option B approved** — immutable trade ledger, correction events, tombstone deletion, explicit mutation ownership (user/sync/webhook/admin), append-only trade events, optimistic concurrency/versioning, idempotent external trade identifiers. Implementation not started (Phase 1 schema design / Phase 2 wave ④).

**Amendment — 2026-09-15 (owner ratification, A-1, MetaAPI imported trades; APPLIED 2026-09-16): `TRADE_IMPORTED` permits actor `sync` in addition to `system`.** See also **Amendment A-5** (2026-09-16): provider-reported P/L is authoritative on the canonical `trades.net_pnl`, with no second P/L column. The authoritative actor set becomes **`TRADE_IMPORTED → ["system", "sync"]`**. This amends the *Ownership matrix* row for imported trades only; every other part of D-01 — the immutable ledger, correction events, tombstone deletion, conflict policy, optimistic concurrency and idempotency — is **unchanged**. No other event's actor set is broadened. See *Ownership matrix* below and *Amendment A-1* for the reasoning and its limits.

## Context

Trades are the core financial record. Today the API exposes mutable trade rows
(`PUT /trades/{id}`, `DELETE /trades/{id}`) while also ingesting external state
(MetaApi sync + webhooks) and supporting partial exits. Under concurrency and at
scale, unspecified mutation semantics are the largest correctness risk in the system.

## Verified Evidence

- Routes (VERIFIED, baseline §4): `GET/POST /api/v1/trades`, `GET/PUT/DELETE /api/v1/trades/{id}`,
  `GET/POST /api/v1/trades/{id}/exits`, `DELETE /api/v1/trades/exits/{exitId}`, `GET /api/v1/trades/symbols`.
- Tables (VERIFIED DDL): `trades` (mutable row model, `status enum('OPEN','CLOSED')`),
  `trade_events` (append table exists), `trade_exits`, `trade_features`, `trade_tags`, `tags`,
  `trade_screenshots`; `external_deal_id` + `ticket_id` columns exist (MetaApi linkage).
- `metaapi_sync_worker.php` (VERIFIED): fenced MySQL queue with atomic lease acquisition.
- `MetaApiWebhookController` (VERIFIED): HMAC verified in service; test route is dev-only (prod 404).
- **Gap (VERIFIED absence):** no `PRIMARY/UNIQUE/KEY` lines found inside the `trades` CREATE block
  of `database_corrected.sql` — the live index set and any uniqueness on `external_deal_id`
  are UNVERIFIED and must be inspected on staging before Phase 2.

## Decision

**Option B — immutable ledger + correction events + tombstone deletion.**
Accepted by owner decision D-01 (2026-08-29).

| | Option A — mutable rows (status quo) | Option B — ledger + events + tombstones (recommended) |
|---|---|---|
| Audit trail | Best-effort (`trade_events` exists but rows change in place) | Every mutation is an event; state is derivable |
| Sync conflicts | Last-write-wins unless ad-hoc guarded | Conflict policy is explicit per field source |
| Corrections/reversals | Overwrite history | Append correction; history preserved |
| Delete | Row disappears | Tombstone + event; reporting stays consistent |
| Complexity | Lower | Moderate (event schema + projection) |

**Ownership matrix** (rows marked **(ratified)** are no longer proposed):

| Actor | May do | Never does |
|---|---|---|
| User | create manual trades, edit journaling metadata, record exits | mutate sync-sourced financial fields silently |
| Sync (MetaApi) | **(ratified 2026-09-15, A-1)** emit `TRADE_IMPORTED` for broker/provider-originated trades; upsert by `(account_id, external_deal_id)`, fill/close trades | overwrite user journaling metadata; emit `TRADE_IMPORTED` for a trade outside the account/user context of the sync operation |
| Webhook | same as sync, idempotent by event id | independent writes bypassing the same rules |
| Admin | support corrections (audited) | silent edits |
| System | retention, aggregations, corrections from migrations, **`TRADE_IMPORTED` for migration-origin imports (retained)** | business edits |

**Conflict behavior:** explicit policy enum per field group
(e.g., `SYNC_WINS_FINANCIAL / USER_WINS_JOURNALING / QUARANTINE_FOR_REVIEW`) —
**unspecified last-write-wins is explicitly rejected.** Final field-group mapping:
Phase 2 spec extraction, owner-approved.

**Optimistic concurrency:** every mutable projection carries `version`
(or `updated_at` token); writes carry expected version; conflict → 409 + event.

**Idempotency:** unique `(account_id, external_deal_id)` enforced by constraint
(pending index verification above); webhook event ids deduped (ADR-008);
duplicate delivery converges instead of double-counting.

### Amendment A-1 — `TRADE_IMPORTED` actor set (2026-09-15)

**Authoritative rule:** `TRADE_IMPORTED → ["system", "sync"]`.

**Why both actors, and what each means:**

- **`system`** remains valid, unchanged, for the system-driven import mechanisms already
  covered by this ADR — notably the *Migration Impact* path, where existing trades import
  into the ledger as `IMPORT`-origin events. Nothing that relies on `system` is affected.
- **`sync`** denotes the **controlled background synchronization worker** performing MetaAPI
  imports. Per OD-M2 that worker owns long-running historical and incremental sync, so it is
  the process that legitimately originates an imported trade.

**Why not `TRADE_CREATED`:** a MetaAPI-originated trade is an **import**, not a manual
creation. Reusing `TRADE_CREATED` to avoid touching the actor matrix would make the ledger
misreport provenance — precisely the auditability this ADR exists to protect. The event
semantics stay explicit: **`TRADE_IMPORTED` = a broker/provider-originated trade imported by
sync.** `FINANCIAL_CORRECTED` remains the path for later provider-driven corrections under
`SYNC_WINS_FINANCIAL`.

**Limits of this amendment — binding.** It authorizes exactly one thing: the already-defined
actor `sync` for the already-defined event `TRADE_IMPORTED`. It does **not**:

- grant the worker arbitrary user-ownership authority, or any right to impersonate a user;
- permit `sync` to emit `TRADE_CREATED`, or broaden any other event's actor set;
- weaken ownership checks anywhere. **Imported-trade ownership must still be derived from the
  authenticated account/user context of the sync operation** — the `(account_id,
  external_deal_id)` linkage — never from a value the provider supplies;
- relax the immutable-ledger, idempotency, expected-version, or transactional-event
  requirements, all of which apply to `TRADE_IMPORTED` exactly as before;
- grant the worker access to `user_credentials`, `CREDENTIAL_MASTER_KEY`, or any broker
  credential. Under **D-2 (Boundary-Scoped Option B)** synchronization is credential-free and
  authenticates with the platform-level `METAAPI_PLATFORM_TOKEN`; `sync` is an **internal
  actor identity for ledger attribution, not an authorization grant**.

**`sync` is never user-supplied.** It is asserted by trusted server-side code that has already
established the account context; it must never be accepted from a request body, header or
job payload.

**Implementation status: APPLIED (2026-09-16).** The domain now encodes
`ALLOWED_ACTORS.TRADE_IMPORTED = ["system", "sync"]`
(`packages/domain/src/tradeLedger.ts`), landed in the same change as the MetaAPI
trade-import implementation per AGENTS.md rule 11. The database event/actor CHECK
constraints already permitted this combination, so **no migration was required**.
Verified on real PostgreSQL 17.10: an imported trade carries
`trade_events.type='TRADE_IMPORTED'` with `actor='sync'`
(`db/tests/metaapiSync.pg.test.ts`). The actor is written as a server-side
constant by the importer and is never read from a job payload, a provider
response, or a request — so it remains non-client-selectable.

### Amendment A-5 — provider-reported P/L is authoritative on `net_pnl` (2026-09-16, implemented)

**Status: IMPLEMENTED** with the MetaAPI import path.

**Decision.** For a trade imported from MetaAPI, the **provider's reported
profit is authoritative** and is persisted to the existing canonical
`trades.net_pnl`. Velora does not recompute, adjust, or second-guess it.

**No second P/L column exists.** There is deliberately no `provider_profit`,
no `calculated_profit`, and no `broker_profit`. Two P/L columns would create an
unanswerable question at read time — which one is the truth? — and would leak
that ambiguity into the API and analytics. One canonical column keeps
`profitLoss` in the API contract unambiguous.

**Why the provider wins.** The broker is the system of record for realized
money: its figure already incorporates the exact fill prices, partial closes,
swap accrual, commission schedule and currency conversion the broker actually
applied. A locally recomputed figure would silently disagree with the user's
broker statement, and the broker's number is the one the user can verify.

**Local computation remains available as diagnostic evidence only.** A derived
figure may be used to detect drift or flag a suspicious import; it must never
overwrite `net_pnl`. The provider's own `profit`, `commission` and `swap` are
additionally preserved verbatim on the originating `sync_fills` row, so the
imported value stays auditable against its source.

**Scope.** Manual trades are unchanged: they keep the existing calculated-P/L
behaviour. This amendment governs the import path only.

**Evidence.** `db/tests/metaapiSync.pg.test.ts` asserts that a provider deal
reporting `profit = "125.50"` produces `trades.net_pnl = 125.50` with
`source='metaapi'`, executed against real PostgreSQL 17.10.

## Alternatives Considered

- Event-sourcing the entire aggregate (full rebuild from events): rejected now —
  operational complexity before it is needed; ledger+projection is the middle ground.
- Status quo (Option A): rejected as recommendation — audit and conflict risks
  grow with users and sync volume.

## Consequences

### Positive
- Auditable financial history; replayable projections; clean sync/user coexistence.
- Dashboard/reporting can read projections without locking trade rows.

### Negative
- More schema and code than mutable rows; queries need projection maintenance.
- Slightly different external behavior for `PUT/DELETE` semantics (internal tier — allowed to change, must be spec'd).

## Security Impact

Tamper-evident history (append-only events) protects the product's core promise
(trustworthy journaling). Admin corrections become auditable. Requires audit-log
integration (security-policy) and row-level ownership checks (authorization).

## Migration Impact

Existing trades import into the ledger as `IMPORT` origin events; existing
`trade_events` (if populated — UNVERIFIED) map to events. Deletion history does
not exist for past deletes — accepted gap (documented, not fabricated).

## Testing / Verification Requirements

- Concurrency tests: parallel user edit + sync upsert on same trade → deterministic outcome per policy.
- Idempotency tests: duplicate webhook/sync replay converges (no double PnL).
- Golden tests: exit allocation inside one transaction; over-allocation rejected by constraint.
- Property: projection state == event replay for randomized sequences.

## Open Questions

1. Ledger model — **RESOLVED**: Option B (owner decision D-01, 2026-08-29).
2. Live `trades` index/uniqueness set (inspect staging DB) — NEEDS VERIFICATION.
3. Field-group conflict mapping (Phase 2).
4. Whether `trade_events` is currently populated by writes (inspect code/DB) — NEEDS VERIFICATION.

## Phase

Phase 0 decision; schema design in Phase 1 (db/), enforcement in Phase 2 wave ④.
