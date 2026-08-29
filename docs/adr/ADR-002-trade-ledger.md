# ADR-002 — Trade Ledger & Mutation Semantics

## Status

Proposed — **contains a genuine business decision (Option A vs B) that only the owner may approve.**

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

**Recommendation: Option B — immutable ledger + correction events + tombstone deletion.**
This is NOT accepted until the owner approves.

| | Option A — mutable rows (status quo) | Option B — ledger + events + tombstones (recommended) |
|---|---|---|
| Audit trail | Best-effort (`trade_events` exists but rows change in place) | Every mutation is an event; state is derivable |
| Sync conflicts | Last-write-wins unless ad-hoc guarded | Conflict policy is explicit per field source |
| Corrections/reversals | Overwrite history | Append correction; history preserved |
| Delete | Row disappears | Tombstone + event; reporting stays consistent |
| Complexity | Lower | Moderate (event schema + projection) |

**Ownership matrix (proposed):**

| Actor | May do | Never does |
|---|---|---|
| User | create manual trades, edit journaling metadata, record exits | mutate sync-sourced financial fields silently |
| Sync (MetaApi) | upsert by `(account_id, external_deal_id)`, fill/close trades | overwrite user journaling metadata |
| Webhook | same as sync, idempotent by event id | independent writes bypassing the same rules |
| Admin | support corrections (audited) | silent edits |
| System | retention, aggregations, corrections from migrations | business edits |

**Conflict behavior:** explicit policy enum per field group
(e.g., `SYNC_WINS_FINANCIAL / USER_WINS_JOURNALING / QUARANTINE_FOR_REVIEW`) —
**unspecified last-write-wins is explicitly rejected.** Final field-group mapping:
Phase 2 spec extraction, owner-approved.

**Optimistic concurrency:** every mutable projection carries `version`
(or `updated_at` token); writes carry expected version; conflict → 409 + event.

**Idempotency:** unique `(account_id, external_deal_id)` enforced by constraint
(pending index verification above); webhook event ids deduped (ADR-008);
duplicate delivery converges instead of double-counting.

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

1. **Option A vs B — OWNER DECISION REQUIRED.**
2. Live `trades` index/uniqueness set (inspect staging DB) — NEEDS VERIFICATION.
3. Field-group conflict mapping (Phase 2).
4. Whether `trade_events` is currently populated by writes (inspect code/DB) — NEEDS VERIFICATION.

## Phase

Phase 0 decision; schema design in Phase 1 (db/), enforcement in Phase 2 wave ④.
