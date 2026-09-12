# Phase C Increment 4 Record — Journal (2026-09-13)

**Scope:** Journal capability only, reconciled on the increment-3 trades ledger.
Start HEAD `caa8cc1c9e9a7aac2a83fd79014b919699cf205c` (verified: branch, clean
tree, main/snapshot untouched, baseline 236/236 before any change; `npm ci` +
dependency-order rebuild required after workspace restore — `dist`/`node_modules`
are snapshot-excluded, a known environment property, not a code regression).
Inventory + field ownership matrix:
`docs/reconciliation/PHASE-C-INC4-JOURNAL-INVENTORY.md`.

| # | Commit | Content |
|---|---|---|
| 1 | `ce26a16` | journal inventory + field ownership matrix (read-only) |
| 2 | `38d1a98` | application layer: PHP-evidenced `q` search + `order` whitelist; journal service tests (16 → 21) |
| 3 | `a3c4a22` | PGlite store `q`/sort + journal replay tests; **fixed real null-clear bug** in `editJournaling` (`??` treated explicit null as absent — a journal clear did not clear in the SQL store) |
| 4 | `eaad8d0` | HTTP: q/order live on the search route (kernel already forwarded them); tradeRoutes 8 → 9 |
| 5 | this commit | evidence record + AGENTS.md row |

## 1. Structural finding (verified fact)

Neither lineage has a standalone Journal module (Remote module list and PHP
route table verified — no journal routes). Remote's Phase-5 report names the
trades module the "Core Trading & Journaling Engine": journaling = the trade
metadata surface (`strategyTag`, `emotionalScore`, `notes`) + `PUT /trades/{id}`.
Local reconciles ON the trades resource: no parallel journaling model, no
invented endpoints (a `/trades/:id/journal` route exists in NO lineage →
NOT IMPLEMENTED).

## 2. Field ownership matrix (implementation-complete)

| Field | Classification | Editable via journal? |
|---|---|---|
| entryPrice, exitPrice, volume, contractSize, commission, swap, symbol, direction, stopLoss, takeProfit, openTime, closeTime, accountId | FINANCIAL_IMMUTABLE (ADR-002) | NO → 403 (all 13 test-verified) |
| profitLoss, rMultiple, allocatedVolume, version, deletedAt, timestamps | SYSTEM_DERIVED | NO (unwritable through the journal path — test-verified) |
| status, externalDealId, source, timeStatus, sourceTimezone*, sourceCalendar, raw*Text | SYNC_OWNED (Phase H) | NO |
| notes, strategyTag (→ `strategy`), emotionalScore (→ `emotion`) | JOURNAL_USER_EDITABLE (ADR-002 USER_WINS_JOURNALING) | YES — `JOURNALING_EDITED` event |
| setup (domain field) | JOURNAL_USER_EDITABLE (domain) / NOT EXPOSED (no lineage API field) | domain-only |

UNKNOWN: none. Tags/screenshots/features tables have no API surface in either
lineage → NOT IMPLEMENTED (no endpoint invented).

## 3. Capability matrix (Remote evidence | Local behavior | Classification)

- Journal read (fields on trade serialization): KEEP — already delivered (inc 3), verified by tests.
- Journal update (`PUT /trades/:id`): KEEP (ADR-002 redesign already in place) — `JOURNALING_EDITED` event chosen over a more specific event type (no evidence for one; inventing would fragment the ADR-002 vocabulary). Remote/PHP mutable-row behavior = documented divergence (403 on financial fields).
- Notes ≤5000 / strategyTag ≤64 / emotionalScore int 1–5, null & ''→null clear: KEEP — both lineages agree; tests cover set/clear/range.
- Manual/auto source: KEEP — `source` 'manual' only (sync/import Phase H).
- Search `q`: **PORT (PHP)** — Remote accepts-and-ignores (repository-verified); PHP implements LIKE across symbol|strategy_tag|notes (user search includes private notes — PHP-documented privacy decision). Local: case-insensitive contains across symbol|strategy|notes, trimmed, empty-after-trim = no filter; emotion deliberately NOT in scope.
- Search `order`: **PORT (PHP, whitelist)** — open_time|close_time|profit_loss with id tiebreak; absent/unknown → open_time (Remote-lineage default; PHP defaults close_time — DOCUMENTED DIFFERENCE).
- Ownership / non-disclosure / error semantics / serialization: KEEP — inc-3 behavior, re-verified at HTTP layer.

## 4. ADR-002 traceability

- Immutable financial facts: every FINANCIAL_IMMUTABLE field → 403 on the journal path (test matrix); financial facts unchanged through journal edits and through replay (test-verified at service + PGlite layers).
- Journal events: `JOURNALING_EDITED` (actor `user`) — the ADR-002 mechanism; version +1 per edit.
- Versioning: stale `expectedVersion` → 409 CONFLICT (service + PGlite CAS + HTTP).
- Ownership: user-scoped everywhere; cross-user q search returns nothing (test-verified).
- Tombstones: tombstoned trade journal data non-readable AND unsearchable (q returns 0 — test-verified).
- Replay: journal projections derivable from the event stream — `projection == fold(replay)` proven for a two-edit journal sequence including a null-clear (PGlite test).
- Auditability: one audit trail (trade_events); no second journaling event model introduced.

## 5. PnL integration

No PnL engine change. Journal edits never touch computed financials (test-verified: profitLoss/rMultiple unchanged after edits; derived fields unwritable). No new golden vectors (no new financial behavior).

## 6. Persistence boundary (never combined)

1. **Memory** (MemoryTradeStore): journal edits via `!== undefined` semantics (null clears) — correct by construction.
2. **PGlite in-wasm** (tradePersistence tests): journal q/order through real SQL; **bug found and fixed** — `editJournaling` used `patch.x ?? parent.x`, silently keeping old values on explicit null clears; now `!== undefined` semantics matching the memory adapter and the domain patch model.
3. **Real PostgreSQL: NOT IMPLEMENTED — Phase D.**

No new migration: journal data lives in the existing `trades` columns + `trade_events` (0001/0005); `q` is a `%…%` LIKE (cannot use the existing btree indexes — no schema change warranted).

## 7. Tests (exact, on committed tree)

| Command | Result |
|---|---|
| `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web` | 0 errors |
| `npm test` | **244/244** (tradeService 21, tradeRoutes 9, tradePersistence 6 PGlite, tradeLedger 12, + prior 196) |
| `npm run test:migrations` | 5/5 |
| `npx tsx tools/parity-smoke.ts` | 6 pass / 0 fail |
| `bash tools/secret-scan.sh` | PASS (0 findings) |
| lint | N/A — no lint script in repo |

## 8. Security — NO REGRESSION

Auth boundary unchanged (401 first); ownership on every route; cross-user q
isolation test-verified; non-disclosing 404s; body-size cap + JSON-object
validation unchanged; no client-controlled ownership fields (userId from the
verified token only); no secrets added (scan 0 findings).

## 9. Open items (evidence-backed only)

- **Phase H:** sync/import journal provenance (SYNC_OWNED fields), conflict field-group mapping (ADR-002 Q3), session/Jalali engines.
- **Phase D:** real-PG stores; real-ILIKE performance (trigram/GIN indexing decision deferred with evidence).
- **Phase J:** tags/screenshots/features API surface (no lineage evidence today), `raw_*_text` population.
- **Fixture-pending:** none new; OD-3 serialization precision unchanged.

## 10. Git evidence

Branch `reconcile/foundation-first`; start `caa8cc1` (clean) → end `eaad8d0` + this record; tree clean at close. `main` (`07977504…`) and tag `remote-snapshot-99e024c829db` (tree `83621817…`) untouched; 0 remotes. Push **NO**; merge **NO**; deployment **NO**.
