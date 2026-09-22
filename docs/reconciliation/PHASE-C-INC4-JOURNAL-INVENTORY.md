# Phase C Increment 4 — Journal Inventory & Field Ownership (read-only, pre-implementation)

Date: 2026-09-13. Base: `caa8cc1c9e9a7aac2a83fd79014b919699cf205c` (increment-3
terminal). Evidence sources: Remote frozen snapshot `remote-snapshot-99e024c829db`
(`src/modules/trades/*`, `docs/VELORA_MODERN_PHASE_5_CORE_TRADING_JOURNAL_REPORT.md`),
PHP `/home/user/velora-sparse` (`api/src/Trades/*`, `api/index.php`), Local
ADR-001/002/004, `packages/domain/tradeLedger.ts`, `packages/contracts/trades.ts`,
increment-3 implementation. Remote = behavioral reference only.

## 0. Structural finding (verified)

**Neither lineage has a standalone Journal module.** Remote modules:
accounts, admin, ai, auth, dashboard, entitlements, metaapi, observability,
support, trades, users — no journal. PHP route table (`api/index.php`): no
journal-specific routes. Remote's own Phase-5 report calls the trades module
the "Core Trading & Journaling Engine": journaling = the metadata surface on
trades (`strategyTag`, `emotionalScore`, `notes`) exposed through the trade
resource and `PUT /trades/{id}`. The Local capability matrix row 9 ("Journal
(exits)") was delivered in increment 3. Conclusion: the Journal capability is
reconciled ON the trades resource — no parallel journaling model, no invented
journal endpoints (a `GET /trades/:id/journal`-style route exists in NO lineage
and is NOT IMPLEMENTED).

## 1. Capability matrix

| Area | Remote evidence | PHP evidence | Local status (inc 3) | Classification | Action |
|---|---|---|---|---|---|
| Journal metadata read | journal fields on the trade serialization (strategyTag, emotionalScore, notes) | same (serialize: strategy_tag, emotional_score, notes) | implemented on `GET /trades/:id` + search items | KEEP | none — verify with tests |
| Journal metadata update | `PUT /trades/:id` partial merge — journaling AND financial fields both mutable (`raw.x !== undefined ? raw.x : existing`) | `array_merge(existing, $raw)` + full `buildTrade` revalidation — both mutable | journaling-only `JOURNALING_EDITED` event; financial fields → 403 FORBIDDEN (ADR-002) | KEEP (ADR-002 redesign already in place) | none — document the event-choice (see §3) |
| Notes | ≤5000, optional, null/''→null, explicit null clears | same | implemented (`validateOptionalText` 5000) | KEEP | none |
| Strategy tag | ≤64, optional, null/''→null | same | implemented (maps to 0001 `strategy` column) | KEEP | none |
| Emotional score | int 1–5, optional, null clears | same | implemented (maps to 0001 `emotion` column, text) | KEEP | none |
| Manual/auto source | `source` 'manual'\|'metaapi'\|'import' default manual; update never changes source | same | 'manual' only (sync/import = Phase H) | KEEP | none |
| Ownership | userId-scoped queries; cross-user PUT/GET/DELETE → 404 (Phase-5 report §5) | same (prepared, owner-checked) | implemented + tested at 3 layers | KEEP | none |
| Validation | journal limits above; `details {field, messageKey}` | same shape | implemented | KEEP | none |
| Serialization | trimZeros numerics; journal fields verbatim | same | implemented | KEEP | none |
| Event representation | none (mutable rows — no events) | none | `JOURNALING_EDITED` (actor user\|admin; patch payload embeds the domain LedgerEvent) | KEEP (ADR-002) | verify replay for journal mutations |
| Search/filter (`q`) | **accepted, never applied** (repository-verified dead param) | **implemented**: `q` LIKE across `symbol OR strategy_tag OR notes` (user search includes private notes; admin global search deliberately excludes notes — documented privacy decision) | `q` accepted-not-applied (Remote dead-param port, inc 3) | **PORT (PHP)** | implement `q` — case-insensitive contains across symbol/strategy/notes; trim (PHP controller trims); empty-after-trim = no filter |
| Search/filter (`order`) | accepted, never applied; repository hardcodes openTime DESC | **implemented**: whitelist `open_time`\|`profit_loss`\|`close_time`, default `close_time DESC` | accepted-not-applied; openAtUtc DESC (Remote default) | **PORT (PHP, whitelist)** | implement whitelisted `order` → openAtUtc/closeAtUtc/netPnl DESC; default stays open_time (Remote lineage — documented difference from PHP's close_time default); deterministic id tiebreak |
| Search `symbol` | contains | exact | contains (settled inc 3, Remote modern wins) | KEEP | none |
| Error semantics | 400 VALIDATION_FAILED `{field, messageKey}`; 404 non-disclosing | same | implemented | KEEP | none |
| Tags / screenshots / features | no API surface (tables only, ADR-002 verified DDL) | no API surface | none | NOT IMPLEMENTED | documented — no endpoint invented |
| Session/Jalali, AI journaling | absent / out of scope | engine present (session display) | `session:'unconfigured'` placeholder | NOT IMPLEMENTED | Phase H/J |

## 2. Field ownership matrix (mandatory)

| Field | Classification | Evidence | Journal-editable? |
|---|---|---|---|
| entryPrice, exitPrice, volume, contractSize, commission, swap | **FINANCIAL_IMMUTABLE** | ADR-002 ownership matrix (user may never emit `FINANCIAL_CORRECTED`); Remote/PHP PUT mutability is the pre-ADR mutable-row model | NO → 403 |
| symbol, direction | **FINANCIAL_IMMUTABLE** | identity of the financial fact (PnL input) | NO → 403 |
| stopLoss, takeProfit | **FINANCIAL_IMMUTABLE** | risk/R-multiple inputs (ADR-001 engine) | NO → 403 |
| openTime, closeTime (occurred instants) | **FINANCIAL_IMMUTABLE** | ADR-004 canonical instants; chronology is part of the fact | NO → 403 |
| accountId | **FINANCIAL_IMMUTABLE** | ownership/sync linkage (`UNIQUE(account_id, external_deal_id)` idempotency key, Phase H) | NO → 403 |
| profitLoss, rMultiple | **SYSTEM_DERIVED** | computed by the Local PnL engine at create; never client-settable in any lineage | NO (not accepted on any path) |
| allocatedVolume, version, deletedAt, createdAt/updatedAt | **SYSTEM_DERIVED** | ledger machinery (ADR-002) | NO |
| status | **SYNC_OWNED** (Phase H) | MetaApi fill/close lifecycle; manual trades are CLOSED at create | NO |
| externalDealId, source, timeStatus, sourceTimezone, sourceTimezoneSource, sourceCalendar, rawOpenText, rawCloseText | **SYNC_OWNED** (provenance) | sync/import provenance fields (ADR-004; Phase H sources); manual create sets source='manual' | NO |
| notes | **JOURNAL_USER_EDITABLE** | both lineages ≤5000 optional; ADR-002 USER_WINS_JOURNALING | YES |
| strategyTag (→ `strategy`) | **JOURNAL_USER_EDITABLE** | both lineages ≤64 optional; USER_WINS_JOURNALING | YES |
| emotionalScore (→ `emotion`) | **JOURNAL_USER_EDITABLE** | both lineages int 1–5 optional; USER_WINS_JOURNALING | YES |
| setup (domain journaling field) | **JOURNAL_USER_EDITABLE** (domain) / **NOT EXPOSED** (API) | Phase-B `TradeJournaling` has `setup`; NO lineage API field exists | domain-only; no API surface invented |

UNKNOWN fields: none — every field above has lineage + ADR evidence. Ambiguous
fields were not implemented (tags/screenshots: tables without API surface).

## 3. Remote divergence decision (authorization Step 4)

Remote/PHP `PUT /trades/:id` mutates journal fields in place. Local
representation: the existing **`JOURNALING_EDITED`** ledger event (ADR-002
vocabulary; ownership matrix allows actor user|admin; patch payload). No more
specific event type is evidenced in either lineage, and inventing one (e.g.
`NOTES_EDITED`) would fragment the ADR-002 event vocabulary without evidence.
Choice: `JOURNALING_EDITED` — this IS the ADR-002-compatible mechanism. This
is an intentional ADR-backed redesign, NOT parity.

## 4. Scope of the code delta (smallest justified)

1. `q` search (PHP-evidenced) + whitelisted `order` (PHP-evidenced) through
   service + memory store + PGlite store — closes the inc-3 documented gap
   (Remote dead params vs PHP implemented). No new migration (LIKE '%…%'
   cannot use the existing btree indexes; no schema change is warranted).
2. Journal-focused tests: field-ownership enforcement (every FINANCIAL_IMMUTABLE
   field → 403), journal null/clear semantics, the authorization's 10-step
   trades-integration script, journal-mutation replay (projection == fold),
   HTTP envelope/ownership/non-disclosure, `q`/`order` at every layer.
3. Everything else: KEEP (already delivered on the ADR-002 foundation in
   increment 3) — verified, not rebuilt.
