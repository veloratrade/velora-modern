# Phase C Increment 8 — PnL Risk-Semantics & Fixture Resolution Inventory (read-only)

Date: 2026-09-13. Base: `a8950b937874e4c8fc094ec8d66088497e7ea372` (increment-7
terminal; Step 0 baseline verified: tsc 0, **296/296**, migrations 5/5, parity
6/6, scan PASS; branch `reconcile/foundation-first`, tree clean, main
`07977504…` and snapshot tag untouched, 0 remotes).

Evidence sources: PHP `api/src/Trades/PnlCalculator.php` (read in full,
line-by-line) + callers `TradeService.php:136`, `TradeRepository.php:340`,
`TradeExitRepository.php:74`; Remote `src/modules/trades/pnlCalculator.ts`
(read in full) + `trades.repository.ts` response mapping; Local
`packages/domain/src/pnl.ts`, `pnl.test.ts`, `pnlGoldenVectors.test.ts`,
`apps/api/src/trades/tradeService.ts` (create line 294, exits line 513),
migrations `0001_core.sql:86` (`r_multiple NUMERIC(20,8)` — nullable);
registry CAP-TRADE-01; matrix rows 11–12; ADR-001; inc-2/inc-3 records.

## 0. Candidate scan (remaining after increment 7)

| Capability | Owner-approved? | Remote | PHP | Local | Phase | Eligible now? | Classification |
|---|---|---|---|---|---|---|---|
| Support system (6 routes) | **NO — no registry row** (rule 1: agent may not create) | placeholder only | implemented (1371 lines) | none | — | NO | NOT IMPLEMENTED (owner decision required) |
| Dashboard metrics (row 13 / CAP-DASH-01) | yes | implemented | implemented | anchors only | C-later | NO — **stop-listed inc 8** | deferred |
| Auth resend/forgot/reset (row 3 / CAP-AUTH-03) | yes | implemented | implemented | contracts only | Phase I | NO — blocked on email dispatch (Phase I gate) | deferred |
| MetaAPI sync/webhooks (rows 15/24, CAP-ACCT-02/03) | yes | schema only | implemented | contracts only | H | NO — stop-listed | deferred |
| Screenshot/OCR (row 16, CAP-TRADE-02), AI (row 18, CAP-AI-*), Admin (row 19, CAP-PLAT-03) | yes | stubs/schema | implemented | none | J/K | NO — stop-listed future phases | deferred |
| Email (row 17, CAP-MAIL-01) | yes | not implemented | implemented | link contracts only | I | NO — Phase I | deferred |
| i18n catalogs (row 21, CAP-I18N-01), SEO (CAP-SEO-01), CMS (CAP-CMS-01) | yes | starter/superseded | implemented | kernel only | L | NO — Phase L (web) | deferred |
| Error-object exact fields (§B) | C-10 envelope frozen | errorHandler | `Response.php` (fields known) | frozen C-10 shape | — | NO — changing the frozen envelope is an owner decision (documented divergence D2) | deferred (owner) |
| **PnL risk semantics + fixture tail (rows 11/12, CAP-TRADE-01)** | **YES — CAP-TRADE-01 PORT row** ("golden vectors + concurrency" verification; matrix rows 11/12 = C-later) | implemented — `pnlCalculator.riskAmount`: no-SL/zero-SL → null; **directional** delta; wrong side → null; r serialized `toFixed(4)` | implemented — `PnlCalculator.php`: identical semantics (`bccomp === 0` → null; `delta <= 0` → null "wrong side"; `bcdiv(net8, risk8, 8)`, serialized `bcadd(...,4)`; net serialized `bcadd(...,2)` truncate) | engine diverges: **abs()** risk + no-SL **fallback** to \|exit−entry\| (pnl.ts:69-71); 3 fixture-pending classifications in `pnlGoldenVectors.test.ts` | **C** | **YES** — see §1 | **KEEP (Local engine) + PORT (PHP/Remote risk semantics)** |

**NEXT ELIGIBLE CAPABILITY = CAP-TRADE-01 tail — PnL risk-semantics parity +
fixture resolution.** Everything else remaining is stop-listed, blocked on a
later phase, or requires an owner decision. No capability was manufactured.

## 1. Why eligible (selection rules)

1. Owner-approved: registry CAP-TRADE-01 (PORT); matrix rows 11/12 are
   C-scope ("C-later"); the vector merge itself was delivered inc 2
   (`pnlGoldenVectors.test.ts`, commit `0c1ca88`) — what remains is the
   explicitly deferred tail: three FIXTURE-PENDING / UNKNOWN classifications
   and the risk-semantics divergence.
2. Phase C scope: rows 11/12.
3. Evidence: PHP source + Remote source read line-by-line, **agreeing with
   each other** against Local's divergence (details §2).
4. No later-phase dependency: pure domain + service logic; no email, no
   MetaApi, no DB work (column already nullable since 0001).
5. No product decision required: the changed semantics are doubly evidenced
   (both lineages identical); Local's divergence traces to a misread PHP
   **docblock** (see §3 conflict), not to an owner decision. The parts that
   WOULD need an owner decision (arithmetic order, external serialization
   precision, ADR-001 scale matrix) are **preserved untouched** and documented
   as divergences/open items (§4).
6–8. No production/staging/external infra, no real PostgreSQL, no stop-listed
area (PnL is not Dashboard/Backtest — it is the trades-domain calculator
already owned by CAP-TRADE-01).

## 2. Verified evidence (lineage sources, read this inventory)

**PHP `PnlCalculator.php` (source of record):**
- `riskAmount`: `$reference === null || bccomp($reference, '0', 8) === 0 →
  return null` (no SL **or SL = "0"** → null risk);
  `delta = buy ? entry − SL : SL − entry` (**directional, not abs**);
  `if (bccomp($delta, '0', 8) <= 0) return null; // SL on wrong side —
  undefined risk`; risk = delta × volume × contractSize at scale 8.
- `calculate`: gross/net computed **always** (net = gross − commission − swap
  at scale 8; volume 0 → net = −costs, no special case);
  `r_multiple = bcdiv(net8, risk8, 8)` only when risk non-null and > 0,
  else **null**; serialization `bcadd(net, '0', 2)` (truncate scale 2),
  `bcadd(r, '0', 4)` (truncate scale 4).
- Callers: `TradeService.php:136` passes the raw nullable `$stopLoss`
  (**no fallback reference anywhere**); exits (`TradeExitRepository.php:74`,
  `TradeRepository.php:340`) pass `null` SL and consume only `net_pnl`.
- DB write: `r_multiple => $calc['r_multiple']` — nullable string.

**Remote `pnlCalculator.ts`:** `riskAmount`: `if (!stopLoss ||
new Decimal(stopLoss).isZero()) return null`; directional delta
(`buy: entry−sl`, `sell: sl−entry`); `if (delta.lessThanOrEqualTo(0)) return
null; // SL on wrong side`. `rMultiple = scale8(net8 ÷ risk8)` only when risk
non-null and `greaterThan(0)`; serialized `toFixed(4)`; `netPnl: toFixed(2)`;
`grossPnl: toFixed(2)`.

**Lineage agreement:** no-SL → r null; SL "0" → r null; wrong-side SL → r
null; gross/net always computed; r from scale-8 intermediates; serialized
net scale 2 / r scale 4. **Local is the outlier** on the first three
(abs risk + no-SL fallback + always-defined r when |entry−SL| > 0).

## 3. Conflict with existing tests (documented BEFORE any change, per rules)

- `pnl.test.ts` **VECTOR-2** pins the no-SL fallback (`risk: "1000.00"`,
  `rMultiple: "0.99070000"`) as "verified PHP behavior". **Conflict:** the
  PHP *code* has no fallback — the fallback exists only in a misplaced PHP
  docblock ("fall back to the initial price delta — roadmap v0.5 rule",
  aspirational, not implemented); `pnl.ts`'s header comment cites a
  "read-verified 2026-08-29" docblock reading. The code, all three callers,
  the nullable DB column, and Remote's implementation agree: **no SL →
  r_multiple null**. Resolution: PHP code is the behavioral contract source
  (standing rule); VECTOR-2 is updated to pin the doubly-evidenced semantics.
- `pnl.test.ts` **VECTOR-5** (entry==exit, no SL) pins reason
  `"risk-is-zero"`; under PHP semantics the primary reason is no-SL
  (`"no-stop-loss"`). Outcome kind (undefined-risk) unchanged; reason updated.
- `pnl.test.ts` volume-zero test pins reason `"volume-is-zero"` with
  `netPnl: "0.00"`; PHP has no volume special case (volume 0 → gross 0,
  net = −costs, risk 0 → r null). The Local short-circuit also **drops
  commission/swap from net** at volume 0 — a latent divergence from PHP.
  Resolution: remove the special case (volume 0 flows to `risk-is-zero` with
  PHP-shaped net).
- `pnlGoldenVectors.test.ts` **NULL-RISK SEMANTICS** pins the fallback
  (`risk: "10.00"`) and the wrong-side current behavior — the test's own
  comment states "no Local golden value is frozen for this case until PHP
  evidence exists". The PHP evidence now exists (§2): both cases →
  undefined risk. Resolution: update, freeze.
- Tests NOT touched: VECTOR A/B/C/D/E/F value pins (A/D/E/F confirmed or
  intentionally divergent — see §4); all trades/journal/ledger tests (VECTOR_A
  has an SL; exits consume netPnl only — unchanged).

## 4. Divergences preserved (documented, intentionally NOT changed)

- **VECTOR B (sub-cent risk):** Local scale-2 currency doctrine → risk
  "0.00" → undefined-risk; lineages divide at scale 8 → defined. ADR-001
  (D-03 scale matrix) Local design; pinned inc 2. Preserved.
- **VECTOR C (r-multiple arithmetic inputs):** Local divides scale-2 money
  (net/risk) → "2.48691217"; lineages divide scale-8 intermediates →
  2.48687500 (PHP), serialized "2.4868" (scale 4). Local value pinned
  **by design** (ADR-001 currency scale 2) inc 2. Preserved; now recorded
  with the resolved PHP fixture values.
- **External serialization precision (OD-3):** lineages emit fixed-scale
  strings — net/profitLoss scale 2 (`bcadd(...,2)` / `toFixed(2)`), r-multiple
  scale 4 (`bcadd(...,4)` / `toFixed(4)`); Local trades API emits trimmed
  strings (`trimZeros`: "493.5", "1.645"). Inc 3 explicitly left this
  OD-3-fixture-pending. The source evidence is now recorded here, but the
  wire-format change touches every trades response + many pinned tests —
  **separate slice, owner-visible open item** (also entangled with ADR-001
  scale matrix semantics). NOT changed this increment.
- **New-computation rounding mode:** trades service uses `half-even` for NEW
  trades (ADR-001; PHP truncates — e.g. VECTOR D inputs → Local API 3.92 vs
  PHP 3.91). Owner ADR-001 decision, documented inc 3. Preserved.
- **Rounding at serialization:** Remote `toFixed` rounds (VECTOR D 3.92);
  PHP `bcadd` truncates (3.91). PHP wins as lineage source for the parity
  mode; already implemented; VECTOR D classification flips from
  FIXTURE-PENDING to RESOLVED (Local parity 3.91 = PHP; Remote 3.92 is the
  Remote-side divergence).

## 5. Contract for this increment (smallest slice)

| Element | Contract (evidence) |
|---|---|
| Risk definition | directional: buy `entry − SL`, sell `SL − entry` (PHP/Remote) |
| No SL (null/empty) | undefined risk → r-multiple null downstream (PHP `riskAmount` null) |
| SL = "0" | same as no SL (PHP `bccomp === 0`) |
| Wrong-side SL (delta ≤ 0) | undefined risk → r-multiple null (PHP `delta <= 0 → null`) |
| Valid SL, risk at currency scale = 0 | undefined risk (Local VECTOR B doctrine — preserved) |
| gross/net | always computed, net = gross − commission − swap (volume-0 special case removed — PHP shape) |
| ok-branch r-multiple | UNCHANGED: net(scale-2) ÷ risk(scale-2) at scale 8, mode rounding (VECTOR C by-design preserved) |
| Downstream API | create with no-SL / wrong-side SL → `rMultiple: null` in store + response (service mapping `pnl.kind === "ok" ? pnl.rMultiple : null` already correct; DB column nullable since 0001) |
| Journal exits | consume `netPnl` on the undefined-risk branch — exit PnL arithmetic UNCHANGED (pinned by the existing 145.00 proportional-allocation test, whose parent is a no-SL trade) |
| Ledger/events | no change — `TRADE_CREATED` carries financial inputs only; r-multiple is derived, never an event field (ADR-002 preserved) |
| Persistence | NO migration (r_multiple nullable since 0001) |
| UI | none (backend-only; field semantics null vs value consumed by existing rendering) |
| ADRs | ADR-001 (scales/modes — preserved, see §4), ADR-002 (immutable financials/events — untouched), ADR-010 (domain logic change lives in packages/domain) |

## 6. Stop-condition check

No checkpoint/baseline discrepancy; evidence is doubly verified and
non-contradictory (both lineages agree; the only conflicts are with Local
pins that trace to a docblock misread — documented in §3 before any change);
no product decision forced (decision-entangled parts preserved as documented
divergences); no invented behavior (every changed semantic cites §2 lines);
no ADR violation; no real PostgreSQL; no production/staging; no destructive
migration (no migration at all); no stop-listed scope. **Proceed.**
