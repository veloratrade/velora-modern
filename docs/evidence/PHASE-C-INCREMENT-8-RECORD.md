# Phase C Increment 8 Record — PnL Risk Semantics & Fixture Resolution (2026-09-13)

**Scope:** PnL calculation tail only (registry CAP-TRADE-01; capability-matrix
rows 11–12). Start HEAD `a8950b937874e4c8fc094ec8d66088497e7ea372` (verified:
branch `reconcile/foundation-first`, clean tree, main `07977504…` and snapshot
tag untouched, 0 remotes; Step 0 baseline before any change: tsc 0, **296/296**,
migrations 5/5, parity 6/6, scan PASS). Inventory (read-only, committed first):
`docs/reconciliation/PHASE-C-INC8-PNL-RISK-SEMANTICS-INVENTORY.md`.

| # | Commit | Content |
|---|---|---|
| 1 | `86b8145` | PnL risk-semantics & fixture inventory + determination (read-only; conflicts documented BEFORE any test change) |
| 2 | `f870352` | engine risk-semantics port + fixture resolutions + test matrix |
| 3 | this commit | evidence record + matrix rows 11/12 + AGENTS.md row |

## 1. Capability determination

- **PHP (source of record, read line-by-line):** `PnlCalculator.php`
  `riskAmount` — no SL or SL "0" → null risk; DIRECTIONAL delta
  (buy: entry−SL, sell: SL−entry); `delta <= 0` → null ("SL on wrong side —
  undefined risk"). `calculate` — gross/net always computed (no volume special
  case); `r_multiple = bcdiv(net8, risk8, 8)` only when risk non-null and > 0;
  serialization `bcadd(net,'0',2)` truncates, `bcadd(r,'0',4)` scale 4.
  Callers pass the raw nullable SL (no fallback anywhere); exits pass null SL
  and consume only net; API validation rejects stopLoss ≤ 0 ("Stop loss must
  be positive.", MUST_BE_POSITIVE — Local is the exact port).
- **Remote:** `pnlCalculator.ts` `riskAmount` — IDENTICAL semantics
  (`!stopLoss || isZero() → null`; directional delta; `delta <= 0 → null`);
  r serialized `toFixed(4)`, net `toFixed(2)`.
- **Local before:** abs() risk + no-SL fallback to |exit−entry| (traced to a
  misread PHP docblock — the "initial price delta fallback" is a roadmap v0.5
  aspiration the PHP code never implemented); wrong-side SL produced a defined
  r-multiple; volume-0 short-circuit dropped costs from net; three
  fixture-pending classifications (VECTOR C r serialization, VECTOR D net
  output, wrong-side SL semantics).
- **Determination: KEEP (Local engine — ADR-001 scales/modes, arithmetic
  order, sub-cent risk doctrine all preserved) + PORT (the lineage risk
  semantics).** Both lineages agree against Local's divergence on every
  changed behavior; no product decision required.

## 2. Implemented (this increment)

| Behavior | Status | Evidence | Tests |
|---|---|---|---|
| No SL (null/empty) → undefined risk → `rMultiple: null` end-to-end | DONE (was: fallback risk = \|exit−entry\`) | PHP `riskAmount` null + Remote `riskAmount` null + nullable DB column (0001) + inc-8 inventory §3 conflict resolution | VECTOR-2 (rewritten), service no-SL, HTTP no-SL round-trip |
| SL = "0" string → treated as no SL at engine level | DONE (defensive parity) | PHP `bccomp($reference,'0',8) === 0 → null` | VECTOR-8c; API path separately pinned to reject (PHP MUST_BE_POSITIVE parity — service zero-SL rejection test) |
| Wrong-side SL (directional delta ≤ 0, incl. SL at entry) → undefined risk → null | DONE (was: abs() defined) | PHP `delta <= 0 → null // SL on wrong side` + Remote identical | VECTOR-8a/8b, VECTOR-5b, NULL-RISK (rewritten), service wrong-side |
| Risk is DIRECTIONAL (buy entry−SL, sell SL−entry) | DONE (was: abs) | PHP/Remote riskAmount | covered by 8a/8b + all ok-branch vectors |
| gross/net ALWAYS computed; volume-0 special case removed (net = gross − costs) | DONE (was: net forced "0.00") | PHP `calculate()` has no volume branch | VECTOR-6 (rewritten: gross 0.00, net −3.00, risk-is-zero) |
| VECTOR D net fixture RESOLVED: parity truncation 3.91 = PHP `bcadd(net,'0',2)`; Remote 3.92 = toFixed rounding (Remote-side divergence) | DONE (classification only; value pins unchanged) | PHP source | VECTOR D + new half-even pin 3.92 (ADR-001 new-mode divergence) |
| VECTOR C fixture RECORDED: lineages compute r from scale-8 intermediates (2.48687500) and serialize scale 4 ("2.4868"); Local by-design divergence PRESERVED | DOCUMENTED (no code change) | PHP `bcdiv(net8, risk8, 8)` + `bcadd(r,'0',4)`; Remote unit test + `toFixed(4)` | VECTOR C assertions unchanged, comments updated |
| Exits/journal path unaffected (consume `netPnl` on the undefined-risk branch) | VERIFIED unchanged | code path + existing 145.00 proportional-allocation test (its parent trade is a no-SL creation) | exits tests green (unchanged) |
| Ledger/events unaffected (r-multiple is derived, never an event field) | VERIFIED unchanged | TRADE_CREATED carries financial inputs only (ADR-002) | ledger/replay tests green |

Not changed (intentional, documented divergences — inventory §4): VECTOR B
sub-cent risk (Local scale-2 currency doctrine); VECTOR C r-multiple
arithmetic inputs (ADR-001); external serialization precision (trimZeros vs
lineages' fixed scales net 2 / r 4 — OD-3 open item, evidence now recorded);
half-even for new computations (ADR-001); SL ≤ 0 API rejection (PHP parity).

## 3. Conflict resolutions (documented in the inventory BEFORE changing tests)

1. VECTOR-2's no-SL fallback pin ("verified PHP behavior") vs PHP code: the
   fallback existed only in a misplaced/aspirational PHP docblock; the code,
   all callers, the nullable column, and Remote agree → PHP code wins; test
   rewritten to pin `undefined-risk / no-stop-loss` with gross/net still
   defined.
2. VECTOR-5's reason (`risk-is-zero` for entry==exit + no SL) → primary
   reason is `no-stop-loss` (PHP null-risk ordering); VECTOR-5b added for
   SL-at-entry (`stop-loss-wrong-side`, PHP `delta <= 0`).
3. VECTOR-6's `volume-is-zero` reason + net "0.00" → PHP has no volume
   special case; net now = −costs; reason `risk-is-zero`.
4. VECTOR-4's vector (SL 8.00 for a buy at entry 2.00) relied on the removed
   abs() semantics — rebuilt with a valid below-entry SL (entry 3.00, SL 1.50,
   r = 2/3 repeating; the mode-divergence assertion is preserved with the
   equivalent repeating quotient).
5. NULL-RISK SEMANTICS golden test: both cases frozen to the lineage
   semantics (the old test's own comment said the wrong-side value was NOT
   frozen pending PHP evidence — that evidence is now read).

No existing test was deleted; every changed assertion cites the inventory
section and the lineage source lines.

## 4. Verification (final battery, committed tree)

- `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web`:
  **0 errors**.
- `npm test`: **304/304** (296 baseline + 8 net new: pnl.test.ts +4
  (VECTOR-5b, 8a, 8b, 8c), tradeService.test.ts +3 (no-SL null, wrong-side
  null, zero-SL rejection), tradeRoutes.test.ts +1 (HTTP no-SL → null +
  read-back round-trip); VECTOR-2/4/5/6, NULL-RISK, VECTOR C/D rewrites are
  in-place). No test weakened or removed.
- `npm run test:migrations`: **5/5**. `tools/parity-smoke.ts`: **6/6**.
  `tools/secret-scan.sh`: **PASS (0 findings)**.

## 5. ADR / doctrine traceability

ADR-001 (scale matrix + dual rounding modes — preserved exactly; the fixture
resolutions CONFIRM the parity mode as PHP-faithful); ADR-002 (immutable
financials/events — no event carries r-multiple; no financial field made
mutable); ADR-010 (domain logic changed in `packages/domain`, not the app);
fail-closed doctrine untouched; no kernel/auth changes; no migration.

## 6. Open items (deferred, evidence-tagged)

- **External serialization precision (OD-3):** lineages emit fixed-scale
  strings (net/profitLoss scale 2, r-multiple scale 4 — `bcadd(...,2/4)` /
  `toFixed(2/4)`, now source-verified); Local emits `trimZeros` ("493.5",
  "1.645"). Changing the wire format touches every trades response and many
  pinned tests — separate slice, owner-visible (also interacts with the
  ADR-001 scale matrix semantics).
- **R-multiple arithmetic inputs:** lineages divide scale-8 intermediates;
  Local divides scale-2 money by design (ADR-001, VECTOR C pin). Owner may
  revisit when freezing the external contract.
- Phase D–K rows unchanged (stop-listed/blocked); Support system remains
  NOT IMPLEMENTED pending an owner registry decision.
