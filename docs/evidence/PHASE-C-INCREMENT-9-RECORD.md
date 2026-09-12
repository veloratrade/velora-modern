# Phase C Increment 9 Record — Remaining-Scope Re-evaluation (2026-09-13)

**Scope:** Read-only re-evaluation of the entire remaining Phase C scope after
increment 8; determination + documentation corrections only.
**Verdict: PASS — NO ELIGIBLE CAPABILITY** (no implementation this
increment — the correct outcome per the authorization; nothing manufactured).

Start HEAD `4579652c55464dbe94127db424ffb8355b8c11ce` (verified: branch
`reconcile/foundation-first`, clean tree, main `07977504…` and snapshot tag
untouched, 0 remotes; Step 0 baseline: tsc 0, **304/304**, migrations 5/5,
parity 6/6, scan PASS). Determination document (committed first):
`docs/reconciliation/PHASE-C-INC9-REMAINING-SCOPE-DETERMINATION.md`.

| # | Commit | Content |
|---|---|---|
| 1 | `443c3fd` | remaining-scope determination (read-only; candidate table; §2 serialization resolution) |
| 2 | this commit | evidence record + stale matrix-label corrections (rows 2/5/6/7/9/20, §B route contracts) + open-item closures (rows 11/12) + AGENTS.md row |

## 1. What was re-evaluated (full candidate set — see determination §3)

Every remaining C-scope item plus every open/deferred marker in the matrix,
registry, and prior increment records. Key findings:

1. **Inc-8 open item "external serialization precision (OD-3)" — RESOLVED,
   no code change.** Source layers separated: PHP's *calculator* returns
   fixed-scale strings (`bcadd(net,'0',2)`, `bcadd(r,'0',4)`), but the
   *API layer* (`TradeService::serialize()`, lines 299–336) applies
   `trimZeros` (`rtrim(rtrim($v,'0'),'.')`) to every decimal field —
   entryPrice, exitPrice, volume, contractSize, commission, swap,
   profitLoss, rMultiple, stopLoss, takeProfit. Local's API layer applies
   the identical `trimZeros` to the same fields (whole-number collapse
   pinned: "145.00"→"145"). **Local's decimal wire serialization is
   PHP-faithful — VERIFIED; the inc-8 concern was a layer conflation.**
2. **Time-field wire format — OWNER DECISION REQUIRED.** Both lineages emit
   `"Y-m-d H:i:s"` (PHP `gmdate('Y-m-d H:i:s')` raw passthrough; Remote
   `toISOString().replace('T',' ').substring(0,19)`); Local emits ISO-8601 Z
   per **ADR-004 Decision §1 (owner decision D-11, accepted 2026-08-29)**,
   which explicitly freezes "API serialization ISO-8601 with explicit offset
   (Z)". Aligning to the lineage format would amend an accepted ADR →
   documented, not changed.
3. **Search semantics — documented Remote/PHP conflicts, prior resolutions
   stand.** PHP: symbol EXACT, `from`/`to` both on close_time, default order
   close_time DESC, q/order applied. Remote: symbol CONTAINS, `from` on
   openTime, openTime DESC fixed, q/order dead. Local is the documented
   hybrid (Remote filters + PHP q/order whitelist/clamp; default open_time —
   self-documented difference). Re-opening = product decision.
4. **Session classification — product-gated on the PHP side too.** PHP
   `MarketSessionSpec::approvedWindows()` returns `[]` ("Deliberately empty:
   no approved product windows exist yet"); windows are PROPOSED, "NOT
   active anywhere in production". Local's constant `'unconfigured'` matches
   PHP's actual current behavior.
5. **Error-object exact fields — source known, envelope frozen.** PHP
   `Response::error` = `{code, message, messageKey, params, details}` (read
   inc 7); Local C-10 envelope frozen — top-level messageKey/params = owner
   decision (divergence D2, documented inc 6/7).
6. **Stale matrix labels corrected** (delivered increments 1–4, labels never
   updated): rows 2, 5, 6, 7, 9, 20 + §B "Trades/accounts/dashboard route
   contracts".
7. Everything else: stop-listed (Dashboard), later-phase-blocked (email
   Phase I; MetaAPI/OCR/AI/admin H–K; jobs/webhooks D/F/H; i18n L), not
   owner-approved (Support — no registry row), or registry verification debt
   (`tools/tests/*` inventory — a Phase 0 maintenance task, not a Phase C
   capability).

## 2. Verification (final battery, committed tree — docs-only change)

- `npx tsc -b packages/contracts packages/domain apps/api apps/worker apps/web`:
  **0 errors**.
- `npm test`: **304/304** (unchanged — no code touched). `test:migrations`:
  **5/5**. parity-smoke: **6/6**. secret-scan: **PASS (0 findings)**.
- Git: branch `reconcile/foundation-first`; commits `443c3fd` → this record;
  tree clean; main/snapshot untouched; 0 remotes; no push/merge/deploy.

## 3. Status vocabulary (precise)

- IMPLEMENTED (prior increments, verified by tests): matrix rows 1, 2, 4, 5,
  6, 7 (read model + ADR-002 write redesign), 9, 10, 11, 12, 14, 20, 22,
  §B rate limits — plus inc-9 §2 VERIFIED (decimal serialization PHP-faithful).
- INTENTIONALLY NOT IMPLEMENTED / DEFERRED: search-semantics divergences
  (documented Remote/PHP conflict resolutions), session engine (product-gated).
- OWNER DECISION REQUIRED: time-field wire format (ADR-004 D-11 amendment),
  error envelope top-level messageKey/params (C-10/D2), Support registry row.
- DEFERRED (later phases): row 3 (I), rows 15–19 (H–K), row 21 (L), rows
  23–27 (D/F/H/E), rate-limit Phase H/I/J route limits + Phase N boot CIDR
  plumbing, `tools/tests/*` registry inventory.
- STOP-LISTED: Dashboard (row 13).

## 4. Open items (carried forward)

All §3 OWNER DECISION REQUIRED and DEFERRED items above; no new open items
introduced. Phase C implementation scope is now exhausted to the boundary of
its authorizations: the next implementation work requires either an owner
decision (the three items above) or a later-phase authorization (D–L).
