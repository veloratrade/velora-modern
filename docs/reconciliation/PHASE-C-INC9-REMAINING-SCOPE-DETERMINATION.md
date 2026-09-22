# Phase C Increment 9 — Remaining-Scope Re-evaluation & Determination (read-only)

Date: 2026-09-13. Base: `4579652c55464dbe94127db424ffb8355b8c11ce` (increment-8
terminal; Step 0 baseline verified: tsc 0, **304/304**, migrations 5/5, parity
6/6, scan PASS; branch `reconcile/foundation-first`, tree clean, main
`07977504…` and snapshot tag untouched, 0 remotes).

Mandate: independently re-evaluate the remaining Phase C scope after
increment 8 (stale classifications and overturned assumptions are proven
possible), then implement only the smallest justified slice — or report
PASS — NO ELIGIBLE CAPABILITY.

## 1. Complete remaining Phase C inventory (matrix reconciled against the inc-8 terminal state)

| Matrix row / item | Matrix label (pre-inc-9) | Actual state (verified) | Evidence |
|---|---|---|---|
| 1 Auth core flows | C (delivered inc 1) | DELIVERED | inc-1 record; kernel routes; 296+ tests |
| 2 change-password / preferences / email-preferences | "Not implemented — C-later" | **STALE — DELIVERED** | kernel `POST /auth/change-password` (throttled inc 7), `PATCH /auth/me/preferences`, `GET/PUT /auth/email-preferences`; authRoutes.test.ts journeys (change-password, PREFERENCES); migration 0003 |
| 3 resend/forgot/reset | Phase I gate | DEFERRED (email dispatch) — unchanged | matrix row 3; registry CAP-AUTH-03 dependency "mail" |
| 4 Users/profile | C (delivered) | DELIVERED | 0002 columns; inc-1/2 records |
| 5 Authorization/ownership | "C-later" | **STALE — DELIVERED** (verifyAccountOwnership enforced at trade create; non-disclosing 404s; origin guard) | tradeService.ts:39,255; inc-2/3 records |
| 6 Trading accounts | "C-later" | **STALE — DELIVERED** (inc 2) | accountService/routes/tests; 0004 |
| 7 Trades CRUD/read | "C-later → Phase E" | **STALE — read model DELIVERED (inc 3/4); write path ADR-002 redesign delivered; Phase E = enforcement staging** | inc-3/4 records |
| 8 Trade events/ledger | Phase E | DEFERRED — unchanged | OD-9 staging |
| 9 Journal/exits | "C-later" | **STALE — DELIVERED** (inc 3 exits + inc 4 journaling) | inc-3/4 records |
| 10 Strategies | C-inc5 VERIFIED | CLOSED (no entity — verified) | inc-5 record |
| 11 PnL | DONE inc 8 + open item "external serialization precision (OD-3)" | **OPEN ITEM RESOLVED THIS INVENTORY — see §2** | this document |
| 12 R-multiple | DONE inc 8 + same open item | same | this document |
| 13 Dashboard | C-later | STOP-LISTED inc 9 (authorization) | — |
| 14 Entitlements | DONE inc 6 | CLOSED | inc-6 record |
| 15–19 MetaAPI/OCR/Email/AI/Admin | Phase H–K | DEFERRED — unchanged (stop-listed) | — |
| 20 Configuration/settings | "C-later (app-level with #2)" | **STALE — app-level user settings DELIVERED with row 2** (locale + ai_consent preferences; boot = Phase B KEEP+HARDEN) | kernel preferences routes; 0002/0003 |
| 21 i18n catalogs | Phase L | DEFERRED — unchanged | — |
| 22 API contracts | C (delivered) | DELIVERED (C-10 envelope, /health OD-3) | inc-1 record; parity 6/6 |
| 23–27 jobs/webhooks/idempotency/concurrency/audit | D/F/H/E | DEFERRED — unchanged | — |
| §B rate limits | DONE inc 7 | CLOSED | inc-7 record |
| §B error-object exact fields | "NEEDS FIXTURE EVIDENCE" | source fully read (inc 7: PHP `Response::error` = `{code, message, messageKey, params, details}`); changing frozen C-10 envelope = owner decision | documented divergence D2 (inc 6/7) |
| §B trades/accounts/dashboard route contracts | "NOT YET IMPLEMENTED" | **STALE — trades + accounts delivered; dashboard stop-listed** | inc-2/3 records |

## 2. Inc-8 open item "external serialization precision (OD-3)" — RESOLVED from source (no code change)

The inc-8 record left open: "lineages emit fixed-scale strings (net scale 2,
r-multiple scale 4 — now source-verified); Local emits trimZeros". Source
re-read this increment separates the layers:

- **Calculator layer (internal):** PHP `PnlCalculator::calculate` returns
  `bcadd(net,'0',2)` / `bcadd(r,'0',4)` fixed-scale strings; Remote
  `pnlCalculator` returns `toFixed(2)` / `toFixed(4)`. (True — but internal.)
- **API layer (the wire):** PHP `TradeService::serialize()` (lines 299–336)
  applies `trimZeros` (`rtrim(rtrim($v,'0'),'.')`) to **every** decimal field:
  entryPrice, exitPrice, volume, contractSize, commission, swap,
  **profitLoss**, **rMultiple**, stopLoss, takeProfit. "493.50"→"493.5",
  "1.6450"→"1.645", "500.00"→"500", "0.00"→"0".
- **Local API layer:** `tradeService.serialize()` applies `trimZeros` with
  IDENTICAL semantics to the same fields (incl. whole-number collapse
  "145.00"→"145", pinned by the exits test).

**Conclusion: Local's decimal wire serialization is PHP-faithful — VERIFIED;
the inc-8 "divergence" was a layer conflation (calculator scales vs API
serialization). No wire change is needed.** The r-multiple VALUE differences
on VECTOR-C-class inputs remain the preserved ADR-001 arithmetic divergence
(owner open item, unchanged). The remaining true wire divergence is the
**time format**: PHP passes `open_time`/`close_time` raw (`gmdate('Y-m-d
H:i:s')` — "2026-09-10 10:00:00"), Remote emits the same shape
(`toISOString().replace('T',' ')`), but Local emits ISO-8601 Z
("2026-09-10T10:00:00.000Z") — and that is an **owner decision: ADR-004
Decision §1 (D-11, accepted 2026-08-29) explicitly freezes "API
serialization ISO-8601 with explicit offset (Z)"**. Changing it would amend
an accepted ADR → OWNER DECISION REQUIRED → not eligible.

## 3. Candidate table (every plausible remaining candidate)

| Candidate | Owner-approved? | Phase | Remote evidence | PHP evidence | Local state | Dependency | Eligible? | Classification |
|---|---|---|---|---|---|---|---|---|
| Trades decimal wire serialization fix | yes (CAP-TRADE-01) | C | `toFixed(2/4)` calculator; API layer mapping | API `serialize()` **trimZeros on all decimals** | already `trimZeros` — **PHP-faithful** | none | **NO — no divergence exists at the API layer (§2); nothing to implement** | VERIFIED (closed) |
| Time-field wire format → lineage "Y-m-d H:i:s" | ADR-004 §1 freezes ISO-Z | C | "Y-m-d H:i:s" | `gmdate('Y-m-d H:i:s')` raw passthrough | ISO-8601 Z | **owner ADR amendment** | **NO — OWNER DECISION REQUIRED** | INTENTIONAL DIVERGENCE (ADR-004 D-11) |
| Search semantics (symbol exact vs contains; `from` field; default order) | yes (row 7) | C | symbol CONTAINS; from→openTime≥; openTime DESC default; q/order dead | symbol EXACT; from/to on close_time; default close_time DESC; q + order whitelist applied | hybrid: Remote filters + PHP q/order/clamp; **every divergence documented** (inc-3/4) | Remote-vs-PHP conflict; prior documented resolutions | **NO — re-opening documented Remote/PHP conflict resolutions = product decision** | DOCUMENTED DIVERGENCES (kept) |
| Error-object exact fields (messageKey/params top-level) | C-10 frozen | C | errorHandler `{code,message,messageKey,params,details}` | `Response::error` same shape | frozen C-10 `{code,message,requestId?,details?}` | **owner envelope decision (D2)** | **NO — OWNER DECISION REQUIRED** | DEFERRED (owner) |
| Session classification engine | row 7 tail | C/H | `'unconfigured'` placeholder | `MarketSessionSpec`: engine exists but `approvedWindows()` **deliberately empty** ("no approved product windows exist yet"); windows PROPOSED, not active | constant `'unconfigured'` — matches PHP current behavior | **product approval of IANA windows (pending on the PHP side too)** | **NO — product decision** | NOT IMPLEMENTED (product-gated, parity in current state) |
| Support system | **no registry row** | — | placeholder only | implemented (1371 lines) | none | owner registry decision | **NO — not owner-approved** | NOT IMPLEMENTED (owner decision) |
| Auth resend/forgot/reset (row 3) | yes (CAP-AUTH-03) | **I** | implemented | implemented | contracts only | email dispatch (Phase I) | **NO — blocked later phase** | DEFERRED |
| Rate-limit tail (Phase H/I/J limits; TRUSTED_PROXY_CIDRS boot plumbing) | yes (CAP-PLAT-02) | H/I/J + N | — | dispatch values captured | C-14 defaults ready; kernel accepts CIDR list | routes don't exist yet / inc-7 documented Phase N deferral (boot-gate security surface, proxy review) | **NO — blocked later phases / documented deferral** | DEFERRED |
| `tools/tests/*` porting-scope inventory | registry Open Item (verification debt) | Phase 0 maintenance | — | sparse checkout HAS `tools/tests/` (fixtures, e2e, …) | — | not a Phase C capability; registry-maintenance task | **NO — not a Phase C capability** | DEFERRED (registry debt) |
| Dashboard (row 13) | yes | C-later | implemented | implemented | anchors | **stop-listed inc 9** | **NO — stop-listed** | DEFERRED |
| Rows 15–19, 21, 23–27 (MetaAPI/OCR/email/AI/admin/i18n/jobs/webhooks/idempotency/concurrency/audit) | yes | H–L/D/E/F | mixed (stubs/schema) | mixed (implemented) | contracts only | later phases | **NO — future phases / stop-listed** | DEFERRED |
| Matrix stale-label corrections (rows 2/5/6/7/9/20, §B route-contracts) | n/a (documentation) | C | — | — | delivered inc 1–4; labels stale | none | documentation only (this increment) | matrix hygiene (evidence-backed) |

## 4. Determination

**PASS — NO ELIGIBLE CAPABILITY.** Every remaining candidate fails at least
one eligibility condition: owner decision required (time format — ADR-004
D-11; error envelope — C-10/D2; session windows — product-gated), product
decision required (re-opening documented Remote/PHP search-semantics
resolutions), blocked later phase (email, MetaAPI/OCR/AI/admin routes,
Phase D/E/F), stop-listed (Dashboard), not owner-approved (Support), or
already correct (decimal serialization — the inc-8 open item was a layer
conflation, resolved in §2 with source evidence). No capability was
manufactured.

This increment therefore delivers **documentation only** (justified,
traceable — not filler): this determination record, the §2 resolution of the
inc-8 open item, and corrections of the stale matrix labels flagged by the
"do not assume the matrix is current" mandate.

## 5. Stop-condition check

Checkpoint exact; baseline green (§ header). No implementation attempted, so
no ADR/PG/production conditions arise. The two owner-decision items (time
wire format, error envelope) are documented, not worked around. No behavior
invented; no parity claims beyond pinned tests.
