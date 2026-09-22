# Phase C Increment 3 — Trades Inventory (read-only, pre-implementation)

Date: 2026-09-12. Base: `cf19d9b3b52af604ad44819228ac49660cfb41f4` (increment 2
terminal). Evidence sources: Remote frozen snapshot
`remote-snapshot-99e024c829db` (`src/modules/trades/*`,
`tests/integration/trades.test.ts`, `prisma/schema.prisma`), PHP reference
`/home/user/velora-sparse` (`api/src/Trades/*`, `api/index.php` routes), Local
ADRs 001/002/004, `db/migrations/0001_core.sql`, `packages/domain/tradeLedger.ts`,
`packages/contracts/trades.ts`. Remote = behavioral reference only.

## 1. Capability matrix

| Area | Remote evidence | PHP evidence | Local status | Classification | Action |
|---|---|---|---|---|---|
| Trade creation `POST /trades` | validation matrix (symbol trim/upper + `^[A-Z0-9#][A-Z0-9._:/#+-]{0,31}$`; direction buy\|sell; accountId `^[1-9]\d*$` + ownership → 400 VALIDATION_FAILED `errors.trades.accountNotOwned`; decimals (10,8); positivity; chronology; strategyTag ≤64; notes ≤5000; emotionalScore int 1–5); PnL server-computed; source `manual` | same matrix (store Validation::assert); commission/swap/contractSize validated (10,8) | no API capability; 0001 ledger schema + domain fold exist | PORT | port matrix onto ledger `TRADE_CREATED`; commission/swap validated at scale 2 (ADR-001 matrix — stricter, documented) |
| Retrieval `GET /trades/:id` | `requireOwned` → 404 `NOT_FOUND` "Trade not found."; flat trade in `data` | `{trade: …}` wrapper | — | PORT | Remote flat shape (modern lineage); PHP wrapper = documented difference |
| Search `GET /trades` | symbol CONTAINS, direction exact, `from` → openTime ≥, `to` → closeTime ≤; page/limit; orderBy openTime DESC; `{items, pagination{page,limit,total,totalPages}}`; `q` and `order` accepted but never applied (repository-verified dead params) | symbol EXACT; `from`/`to` on close_time; order param, default close_time; limit clamp 1..200 | — | PORT | Remote filter semantics; PHP clamp 1..200 ported (safety); dead `q`/`order` accepted-not-applied exactly as Remote (documented, not parity-claimed) |
| Update `PUT /trades/:id` | mutable row: partial merge + full revalidation + PnL recompute; no concurrency control | same (mutable) | ADR-002: `FINANCIAL_CORRECTED` actors = sync/webhook/admin — user NEVER rewrites financials; `JOURNALING_EDITED` actors = user/admin | **REDESIGN (ADR-002)** | journaling-only edit as `JOURNALING_EDITED` event + version+1; financial fields in body → 403 FORBIDDEN (documented divergence; remedy: tombstone + recreate); optimistic `version` accepted, mismatch → 409 CONFLICT |
| Delete `DELETE /trades/:id` | physical `deleteMany` + exits purged; `{deleted:true}`; repeat → 404 | physical DELETE; `{deleted:true}` | ADR-002: tombstone + `TOMBSTONE_SET` event | **REDESIGN (ADR-002)** | tombstone (`deleted_at`) + event; 404 after; response `{deleted:true}` ported |
| Partial exits `GET/POST /:id/exits` | cumulative volume ≤ parent else 422 VALIDATION_FAILED `{volume:'EXIT_VOLUME_EXCEEDED'}`; exitedAt within [open,close] else 422; pnl server-computed with proportional commission/swap (ratio scale 8); list exitTime ASC; no input validation in TS layer | exitType validated (tp/sl/manual/partial, INVALID_CHOICE); decimals (10,8) + positive; notes ≤255; PnL server-computed (client PnL ignored); `FOR UPDATE` + transaction | 0001 `trade_exits` + allocation trigger exist; domain `EXIT_RECORDED` fold | PORT + PHP hardening | port endpoints; PHP input validation (fuller lineage evidence); allocation via domain fold + DB trigger; exit PnL via Local engine (half-even), allocation rounded to currency scale 2 (ADR-001 — divergence from lineage scale 8, documented) |
| Exit delete `DELETE /trades/exits/:exitId` | physical deleteMany; 404 "Trade exit not found." | physical DELETE; 404 | ADR-002: every mutation is an event; no exit-cancellation type exists | **REDESIGN (ADR-002)** | tombstone exit (`deleted_at`) + new `EXIT_CANCELLED` event (forward-only constraint widening in 0005) + allocated-volume decrement; response/404 ported |
| Symbols `GET /trades/symbols` | absent | `{symbols}` DISTINCT ORDER BY symbol; route ordered before `/{id}` | — | PORT (PHP) | port; Remote absence = documented difference |
| Ownership | userId on every query; cross-user get/put/delete → 404 (integration-test verified) | same (prepared + owner-checked) | accounts pattern established | PORT | ownership-scoped store queries; non-disclosing 404 (missing ≡ foreign ≡ tombstoned) |
| Idempotency (manual) | none — no key, `externalDealId` null, duplicates create duplicates | none | 0001 `UNIQUE(account_id, external_deal_id)` (sync upserts — Phase H); `trade_events.event_uid` UNIQUE (replay dedupe) | KEEP | no manual-create idempotency invented; documented absent contract |
| Concurrency | createExit: prisma `$transaction` / process-local promise lock (memory); PUT/DELETE: none | transaction + `FOR UPDATE` (MySQL) | ADR-002 optimistic version; fold `VersionConflictError`; DB trigger | KEEP+HARDEN | `expectedVersion` on every mutation → 409; allocation enforced by fold AND DB trigger; real DB transactions = Phase D (documented, not pretended) |
| PnL linkage | PnlCalculator at create + exits | same formulas (bcmath) | Local engine = authority (ADR-001; golden vectors, increment 2) | KEEP | `computePnl(…, "half-even")` (ADR-001 new-computation mode); no engine change; increment-2 divergences preserved |
| Serialization | `trimZeros`; `session:'unconfigured'`; time placeholders; accountId number | bcadd-normalized strings | — | PORT + REDESIGN | `trimZeros` ported; times ISO-8601 Z (ADR-004 §1 — divergence from Remote UTC-naive strings); accountId string (Local id model); `version` exposed (ADR-002 addition) |
| Error semantics | 400 VALIDATION_FAILED `{field, messageKey, params?}`; 404 NOT_FOUND; 401; exits 422 VALIDATION_FAILED | same codes; exit 404 `TRADE_EXIT_NOT_FOUND` | envelope + taxonomy established (`CONFLICT`, `FORBIDDEN` exist) | PORT | per-capability details shape `{field, messageKey}` ported; exit 404 code `NOT_FOUND` (Remote; PHP `TRADE_EXIT_NOT_FOUND` documented); Local 401 `UNAUTHENTICATED` (established increment 1) |
| Persistence | Prisma mutable rows + in-memory fallback (test env) | MySQL mutable | 0001: `trades` projection + `trade_events` append-only + `trade_exits` + `velora_apply_exit` trigger + CHECKs | KEEP + PORT | extend via forward-only 0005 (API columns: canonical time columns, exit fields, `EXIT_CANCELLED`); memory adapter + PGlite store behind `TradeStore` port; real PG = Phase D |
| Time model | manual input parsed via `new Date()` (server-local) → UTC-naive string; `timeStatus:'unresolved'`, `sourceTimezone:null`, `sourceCalendar:'unknown'`, `session:'unconfigured'` | naive kept verbatim; canonical from account TZ evidence (`trading_accounts.timezone`); `users.timezone` intentionally never consulted (display-only); `time_status` resolved\|unresolved only | **ADR-004 (D-11): manual trades converted via the USER's profile TZ; timestamptz UTC-only; API ISO-8601 Z** | **REDESIGN (ADR-004)** | user profile TZ (`users.timezone`, 0002, default 'UTC') → canonical instants; `timeStatus:'resolved'`, `sourceTimezone`, `sourceTimezoneSource:'user_profile'`; raw input preserved (`source_time_naive` + event payload); PHP account-TZ policy = documented difference (Phase H revisit when broker-timezone evidence lands) |
| Session/Jalali canonicalization | placeholders only | TradingSessionEngine, JalaliCalendar, TimezoneResolver subsystems | — | NOT IMPLEMENTED | `session:'unconfigured'` placeholder ported; engines = Phase H+ (MetaApi/AI evidence paths) |
| `POST /trades/extract-screenshot` | absent | OCR/AI route | — | NOT IMPLEMENTED | Phase J |
| MetaApi sync routes | absent (module has none) | connect/sync elsewhere | — | NOT IMPLEMENTED | Phase H |

## 2. ADR-002 traceability (per operation)

| Requirement | Create | Read/Search | Update (PUT) | Delete | Exits |
|---|---|---|---|---|---|
| Immutable facts | `TRADE_CREATED` append; projection row never rewritten in place | read-only | `JOURNALING_EDITED` append; financial fields never user-mutable; history preserved in events | `TOMBSTONE_SET` append; row retained | `EXIT_RECORDED` append |
| Corrections | — | — | journaling correction = event (user actor per ownership matrix); financial correction reserved to sync/webhook/admin (Phase H policy, owner-approved mapping per ADR open Q3) | tombstone = the deletion representation | `EXIT_CANCELLED` (new) = the exit-deletion representation |
| Tombstones | — | tombstoned ≡ missing (non-disclosing 404) | tombstoned → 404 (fold `TombstoneError`) | `deleted_at` set, never DELETE | exit `deleted_at`, allocation decremented |
| Ownership | accountId ownership verified pre-create (400 `accountNotOwned` — lineages agree) | user-scoped queries | user-scoped CAS update | user-scoped | parent-trade scoped; exit lookup joins owner |
| Idempotency | none for manual (evidenced absence, documented); `event_uid` UNIQUE for replay | — | none (single-writer user) | repeat → 404 (evidenced) | none (evidenced) |
| Concurrency | single INSERT | — | `expectedVersion` → 409 `CONFLICT`; DB CAS `WHERE version=$expected` | `expectedVersion` → 409 | fold over-allocation guard + DB trigger; real transactions Phase D |
| Auditability | event with actor `user`, expectedVersion 0, full payload | — | event with patch | event with reason | events with exit payload |

## 3. Pre-implementation findings

1. `0001_core.sql` already contains the complete ADR-002 ledger (projection +
   events + exits + trigger). The API-contract columns it lacks (canonical open/
   close instants, time-status metadata, exit_type/pnl/notes/exited_at) are
   added by forward-only `0005` — no 0001 modification.
2. `trade_events.type` CHECK has no exit-cancellation value; ADR-002 requires
   exit deletion to be an event. `0005` widens the constraint
   (drop + re-add with `EXIT_CANCELLED`) — non-destructive, forward-only.
3. Phase-B domain `tradeLedger.ts` implements the full fold + ownership matrix;
   the service runs every mutation through `applyEvent` so both adapters inherit
   the invariants; PGlite re-enforces via CAS + trigger.
4. Remote `q`/`order` search params are accepted and silently ignored
   (repository-verified). Local ports that exact behavior and documents it —
   no parity claim.
5. ADR-004 vs PHP conflict on manual-time timezone (user profile TZ vs account
   TZ): ADR wins (standing rule). Documented difference.
