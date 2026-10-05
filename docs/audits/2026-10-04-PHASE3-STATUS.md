# Phase 3 status — core trading (2026-10-04, Asia/Tehran)

**Branch `feat/telegram-journal-client` · HEAD `1f095c8` · tree clean · NOT pushed**
(nothing has been pushed since `a3bd138`; a push needs a fresh single-use PAT —
tell me when you have one and I will push every pending commit in order).

Working-tree state: all gates green, API on `:8080` and the production web build
on `:3200` are running against the real PostgreSQL cluster.

---

## 1. What this round added

| # | Capability | Status now | Where |
|---|---|---|---|
| TRD-04 | Trade-list contract aligned with Legacy (page/limit/filters/ordering) | **IMPLEMENTED** | `apps/api/src/trades/*`, commit `24733fa` |
| TRD-05/07 | Dashboard + trade journal on the **real** analytics API (no invented fields) | **IMPLEMENTED** (web) | `/trades`, `/dashboard`, commit `050d881` |
| TRD-02 | Live P&L / R preview computed by the **server's own** engine | **IMPLEMENTED** | `features/trades/pnlPreview.ts` + `@velora/domain` |
| **TRD-06** | **User-triggered sync** `POST /accounts/{id}/sync` + a sync control on `/accounts` | **IMPLEMENTED** | commits `73cc8b6`, `9a34a9f`, `e0bfc2a` |
| TRD-03 | Screenshot OCR — Legacy pipeline read end to end; result recorded | **MISSING** (recon done, design decided) | matrix row + gap `MG-AI-OCR` |

### The defect the round uncovered (and fixed)

The webhook ingress asked the provider for a **24-hour** window while the hourly
tick asked for **12 months**, for the same account, under the same idempotency key
`sync:{accountId}:{from}` — a key that can only deduplicate jobs that agree on
their window. "How much history do we import?" therefore depended on which trigger
fired. The window rule now lives once in `@velora/contracts` (`syncWindow`) and all
three producers use it; the pg-boss trigger is built once and injected; the
durable `CONNECTING` marker exists once instead of twice.

### Defects found by visual/QA inspection, fixed immediately (never deferred)

1. The dashboard and journal were fed by an **invented analytics contract** hidden
   behind `??` fallbacks — a wrong field produced zeros and a flat equity line
   instead of an error. Rewritten against the endpoints that exist.
2. `fmtDateLong` merged caller options onto `dateStyle:"long"`, which Intl forbids:
   it threw **inside a React render** and took `/trades` down to "This page
   couldn't load". No type-check or build step could see it — the visual battery did.
3. `/accounts` rendered **Persian digits** (`۱۴۰۵/۷/۱۲`) beside a Latin "ID 7",
   against the product's Latin-digit rule. Now uses the shared formatter.
4. The trade form's controls had **no `name`**, so nothing — autofill, password
   manager, a test — could address them except by their visible Persian label.
5. The test runner could report a **red suite** for an OS-killed (OOM) PGlite file.
   It now re-runs exactly that file once, alone, and never retries an assertion.

## 2. Gates (all re-run after the final change)

| Gate | Result |
|---|---|
| `npm test` (two-batch runner) | **991 + 63 = 1054 tests, 0 failed, 0 skipped** |
| `npm run typecheck` | clean |
| `npm run secret-scan` | **PASS (0 findings)** |
| `npx next build --webpack` | exit 0, **37 routes** (every page + `/en` variant) |
| Real-PostgreSQL batteries (`tools/run-pg-batteries.sh`) | **27 files × 2 orders = 54 runs, 0 failures** |
| TRD-06 runtime battery (real PG + real queue) | **16/16** — 202 queued · 200 up-to-date · 422 `METAAPI_REQUIRED` · 401 · 404 foreign = 404 missing · `CONNECTING` marker · a CONNECTED account not dragged backwards · pg-boss row present with identifiers only · 21st request 429 |
| Phase-3 web regression battery | **33/33** — fa RTL `/trades` (KPI 2 · 50% · +241.00 · 1.95, live preview 493.50 / R 1.65) · en LTR dashboard (Total Trades 2 · +241.00 · 1.95 · Avg R 1.65, curve not flat) · mobile 390 overflow 0 · 0 page errors |
| TRD-06 UI battery (fa + en) | **10/10** — button click → 202, row then reflects `CONNECTING` |

## 3. What is NOT claimed

- **Not pushed, not merged, not deployed.** `main` is untouched (`ab0eed7`).
- **No live MetaAPI call** — the platform token is absent; the provider link in the
  batteries was set with SQL (documented test shortcut).
- **No OCR engine on this host** (no `tesseract` binary) — TRD-03 stays MISSING.
- **The worker is not deployed**, so in production a queued sync job has no
  consumer until `MG-WORKER-DEPLOY` closes; locally the job lifecycle was observed
  (enqueued → claimed when a worker starts).

## 4. Next, in the fixed order

1. **TRD-03 ingest half** (phase 3): image validation (type-by-content, size,
   dimensions), the per-user 8/300 bucket, consent gate, feature flag, sha256 dedup,
   audit rows, and a **fail-closed 501 `OCR_UNAVAILABLE`** when no engine is wired —
   the OCR engine itself is the external dependency (`MG-AI-OCR`, phase 7 owns the
   provider half; n8n/Gemini relay preserved).
2. **Phase 4 — data integrity/migration:** cutover rehearsal, backup/restore proof,
   PnL guards, `r_multiple` scale (Legacy 4 vs Modern 8), timezone semantics.
3. Phases 5–9 as ordered (support → admin → AI → integrations/worker → secondary).
4. **Push** all pending commits at the next fresh PAT.

**No existing user capability was removed.**
