# VELORA-MODERN — Current Project State (Canonical)

**System:** Agent Context System (ADR-017) · **Schema version:** 1
**Last updated:** 2026-10-05 (Asia/Tehran) — entries AC-1…AC-18 (… AC-14: phase 5 — support; AC-15: the phase-3…5 pushes verified from the remote; AC-16: phase 6 — the admin console (seven permission-driven tabs, 62/62 browser QA, RBAC map 6 → 12 of 24 ENFORCED, ADM-01/ADM-04/SUP-02 → VERIFIED); AC-17: the phase-6 push verified from the remote; **AC-18: phase 7 API slice — the AI capability: migration 0028 (chains, flags with deterministic rollout, atomic per-provider budgets, credential metadata with no secret column, admin-managed secrets in the existing crypto envelope), the chain walker whose order IS the security property, the n8n Gemini relay on Legacy's exact contract, the local Tesseract OCR fallback proved against the real binary, three user routes with Legacy's prompts/whitelists/rate limits, 21 admin routes on aiManage + aiRouteManage, and the three support assists phase 5 deferred** — see §2a)
**Machine-readable twin:** `docs/state/current-state.json` (read by `tools/agent-context.mjs`; the two must be updated in the same change)
**Mode:** GOVERNANCE STATE RECORD — this file records *what is verified*, never what is hoped.

---

## 1. Purpose and precedence

This is the **single canonical current-state entry point** for any agent session
on this repository. It exists to answer, in one read: *where are we, what
changed since the last verified state, what is still open, and what evidence
may be trusted right now.*

| Layer | Artifact | Mutability | Role |
|---|---|---|---|
| Historical evidence | `docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md` | **Immutable** | What was true at the pinned baselines |
| Current state | **this file** + `docs/state/current-state.json` | Updated with every state-affecting change | What is true now, and how verified |
| Gap register | `docs/state/MIGRATION_GAP_REGISTER.md` (+ `.json`) | Updated as gaps close/open | Every open gap, every closed gap with evidence |
| Change history | `docs/state/CHANGE_LOG.md` | Append-only | Curated commit→impact→evidence ledger since the audit baseline |

**Precedence rule:** for *current* decisions, this file (backed by
`tools/agent-context.mjs` verification) is authoritative. The historical audit
is never edited to match the present; the present is recorded here. Where this
file and the audit intentionally diverge (progress since 2026-09-25), the
divergence must be traceable through `CHANGE_LOG.md` entries.

## 2. Historical baseline (immutable anchor)

| Field | Value |
|---|---|
| Audit | `docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md` (audit date 2026-09-25, stored verbatim 2026-09-26) |
| Audit SHA-256 | `643fa1b554753d4dc584699261bfe996e668e6dcd2876abde53dc77b090aea2f` (88,405 bytes) |
| Verdict | **NOT CLOSED — PARTIAL MIGRATION WITH MATERIAL BEHAVIOURAL DIVERGENCE AND BLOCKING OPERATIONAL GAPS** |
| Closure gates (audit score line) | **0 PASS · 1 PARTIAL · 14 FAIL** — note: the audit's §19.1 table itself marks gates 8 *and* 11 as PARTIAL (2 rows) while its score line reads "1 PARTIAL, 14 FAIL"; recorded as-is, see gap register `MG-OBS-1` |
| Modern baseline | `ffcb0e976147c753493532188a598ecb5de8d06d` (`main`, 2026-09-24) |
| Legacy baseline | `edede313280f2f0e298f5ccbf5bbdd4d676c80bd` (`main`, 2026-09-14) — read-only reference; never modified by modernization work |
| Product capability reference | `veloratrade/docs/pdf/Roadmap.pdf` @ `edede31` |
| Architecture authority | `MASTER_ROADMAP.md` (root) — see §6 contradictions before trusting any single status label in it |

## 2a. Branch work in flight (not on `main`) — AC-9

| Field | Value |
|---|---|
| Branch | `integration/reconcile-lineages` (from `main` @ `0e9c4d7`) — merges BOTH prior lineages: `feat/telegram-journal-client` (AC-9…AC-18) and `feat/mg-domain-legacy-only-achievements` (renumbered AC-19…AC-26) |
| Branch HEAD | advances with each AC entry. **At AC-38 (2026-10-06) the verified tip is `7c6e246`** (AC-36 ops:verify + AC-37 worker least-privilege runtime/real-PG sweep + AC-38 restore-drill refresh + Persian final report; before it AC-31..AC-35 schema-map/web/emails/RBAC/cadence). `git log --oneline ab0eed7..HEAD` lists the full branch |
| State | **PUSHED AND PROMOTED 2026-10-06 (owner instruction): remote `main` fast-forwarded `0e9c4d7` → `be4732d`** — main now carries the ENTIRE integration lineage (AC-1..AC-40: PR #8 governance campaign + both source lineages + assembly/security/web/emails/RBAC/cadence/ops-verify/worker-runtime/backup-drill + remote-sync records). Fast-forward only (no force, no history rewrite); pre-push secret-scan PASS 0 findings; verified via `git ls-remote` (main = be4732d = integration/reconcile-lineages). Branch `integration/reconcile-lineages` also remains on the remote at the same SHA. `current_verified.modern_sha` advances to `be4732d` (it records what is verified on `main`) |
| Capability | Telegram journal client (ADR-018) + phases 1–6 of the Legacy→Modern migration (account surface, auth/security/RBAC, core trading, data integrity, support tickets, **the admin console**) — same users, same PostgreSQL schema, same journal domain (`TradeService` / ADR-002 ledger), same AI boundary (`AiProvider` + `ai_coaching_logs`), one audit trail and one RBAC vocabulary |
| Evidence (AC-13) | `npm test` **999 + 63**, 0 fail / 0 skip · `npm run typecheck` clean · `secret-scan` PASS · real-PG batteries **28 files × 2 orders (56 runs), 0 fail** · restore drill **PASSED** (`RESTORE_VERIFIED`: 44 tables/49 numeric columns parity + smoke 11/11 on the restored copy) · load rehearsal **REHEARSAL_PASSED** on a labelled synthetic fixture (exact row+money parity, gate 6 5/5) · 26 migrations |
| Evidence (AC-14, latest) | `npm test` **1064 + 63 = 1127**, 0 fail / 0 skip, EXIT=0 · `npm run typecheck` clean · `secret-scan` PASS · real-PG batteries **29 files × 2 orders (58 runs), 0 fail** incl. `supportTickets` 14/14 · support service 15/15 · support routes 10/10 (real HTTP + real kernel) · throttle guard 18/18 · web build 38 routes with `/support` + `/en/support` real · **browser QA 29/29** (`docs/audits/phase5-ui/`, harness `tools/visual-qa/phase5-support.mjs`) — `docs/audits/2026-10-04-PHASE5-STATUS.md` |
| Evidence (AC-16, latest) | `npm test` **1106 + 63 = 1169**, 0 fail / 0 skip, EXIT=0 · `npm run typecheck` clean · `secret-scan` PASS (0 findings) · real-PG batteries **30 files × 2 orders (60 runs), 0 failures** — `REAL-PG EVIDENCE: PASS` on PostgreSQL 17.11 at migration head `0027_admin_console.sql` · phase-6 units: `adminConsoleRoutes` 17/17, `adminConsoleService` 16/16, `adminConsole.pg` 14/14, `i18n/adminSurface` 8/8, `i18n/supportSurface` 7/7, `extendedCapabilities.pg` 15/15, `rbacCapabilityMap` 5/5 · `next build` ✓ 38 routes with `/admin` + `/en/admin` real · **browser QA 62/62** in Chromium 153 against the production build + live API (`docs/audits/phase6-ui/`, 20 screenshots, harness `tools/visual-qa/phase6-admin.mjs`) — `docs/audits/2026-10-04-PHASE6-STATUS.md` + `…-PHASE6-ADMIN-CAPABILITY-MAP.md` |
| Gaps opened | `MG-TG-1` (no live Telegram/Gemini round trip), `MG-TG-2` (n8n relay not implemented), `MG-TG-3` (no worker path), `MG-WORKER-DEPLOY` strengthened with runtime evidence |
| Gaps annotated (AC-14) | `MG-FRONTEND-SURFACES`: `/support` is no longer a shell (implemented + verified); admin console moves to phase 6. Ticket `/translate` + `/copilot` remain OPEN with the AI phase by design (a stub would fabricate output). |
| Gaps annotated (AC-16) | `MG-ADMIN` moved **OPEN → PARTIAL** with a reproducible inventory (75 Legacy `/api/v1/admin/*` routes across 19 segments, superseding the audit's "59/62 endpoints, 38 modules") and every unmigrated block named with its owner: AI (14) → phase 7, integrations (12) + worker/e-mail + A2 logs → phase 8, settings (3) / feature flags (2) / log viewer (1) / billing (2) / the ai-operations-revenue analytics blocks → phase 9 or until a reader exists, user creation + invitations (2) → **owner decision**, per-user login history (1) → phase-6 follow-up. `MG-FRONTEND-SURFACES`: `/admin` is no longer a shell. `SEC-01`: 12 of 24 Legacy permissions now ENFORCED. `ADM-01`, `ADM-04`, `SUP-02` → **VERIFIED** (re-proved against real PostgreSQL and a live browser in this session). Nothing was closed by renaming; no capability was removed |
| Evidence (AC-18) | `npm test` **1148 + 63 = 1211**, 0 fail / 0 skip, `ALL TEST FILES PASSED`, EXIT=0 · `npm run typecheck` clean · `secret-scan` PASS (0 findings) · real-PG batteries **31 files × 2 orders = 62 runs, 0 failures** — `REAL-PG EVIDENCE: PASS` on PostgreSQL 17.11, the whole chain **0001→0028 applied from scratch** after a sandbox restore wiped the toolchain · phase-7 units: `aiCapability` 23/23 (incl. real tesseract 5.5.0 OCR on a real screenshot), `aiRoutes` 19/19 through the real kernel, `aiCapability.pg` 12/12 (closed vocabularies, 20 racers against a budget of 5, nonce reuse refused), `rbacCapabilityMap` 5/5, `rateLimitRoutes` 18/18 · `docs/audits/2026-10-05-PHASE7-{AI-CAPABILITY-MAP,STATUS}.md` |
| Evidence (AC-27, integrated tree) | `npm test` **1281** (0 fail / 0 skip) on the merged tree before AC-28's last fix · `npm run typecheck` clean · `secret-scan` PASS · real-PG batteries **32 files × 2 orders = 64 runs, 0 failures** on PostgreSQL 17.11 (0001→0029 from scratch); `pgRoles` **23/23 under its documented superuser prerequisite** (plain CREATEROLE fails on `ALTER DEFAULT PRIVILEGES FOR ROLE velora_owner` — environment, not tree) |
| Evidence (AC-28, latest — re-captured AFTER the pendingPositionIds/upsert rework) | `npm test` **1219 + 63 = 1282**, 0 fail / 0 skip, EXIT=0 · `npm run typecheck` clean · `secret-scan` PASS (0 findings) · real-PG 17.11 @ migration head `0029`: `metaapiAssembly` **8/8** (golden vectors, cross-batch VWAP 1.11000000/1.13200000 net 100.00 comm −3.00 swap −0.50, idempotent replay, terminal skips, self-heal `pos-HEAL` net 66.25, concurrency → exactly 1 trade + 1 event with the loser rejected `RESERVATION_HELD`, tombstone convergence) · `metaapiSync` **13/13** (E7/E8/E11 rewritten to per-position semantics) · `pgRoles` **23/23** incl. P19 · `ops/metaapi/retirePerFillTrades.ts` E2E on a scratch DB (dry-run no-op → execute tombstones 1 → re-run 0 → empty-batch sync re-assembles `pos-OLD` entry 1.10000 ≠ exit 1.10500, net 42.00 preserved) · `next build` exit 0 (all routes incl. `/admin`, `/support`, fa/en pairs) · `tools/pg-smoke.ts` **ALL 11 CHECKS PASSED** (0001→0029, 29 files, fresh apply + no-op re-run) · evidence doc `docs/evidence/METAAPI-ASSEMBLY-2026-10-05.md` |
| Gaps annotated (AC-27/28) | `MG-METAAPI-ASSEMBLY` OPEN → **PARTIAL** (RECORDED_RUNTIME; LIVE provider round trip NOT_VERIFIED — no MetaAPI credentials; OD-M-PA-1/2/3 adopted per recorded recommendations, **ratification pending**) · `MG-SEC-COOKIE` → **CLOSED** (S1: cookie-only refresh, body fallback removed, 128-char cap; authRoutes 12/12 incl. the S1 proof; human review flagged per AGENTS.md rule 7) · `MG-SEC-CSP` → **PARTIAL** (S2: `Math.random` nonce fallback removed, fail-closed 503; release pinning model owner-gated) · stale rows re-audited on the integrated tree → `MG-SEC-EDGE-AUTHZ` **PARTIAL**, `MG-AUTH-EVENTS` **PARTIAL** (code + batteries exist; register had drifted) · `MG-RANGE-GUARD` CLOSED (AC-23) · `MG-OBS-6` CLOSED (both lineages). Register: **17 OPEN / 27 PARTIAL / 12 CLOSED**. Nothing closed by renaming; no capability removed |
| Gaps annotated (AC-18) | `MG-AI-OCR` OPEN → **PARTIAL** (the API slice is done; the web surfaces and a live provider round trip are not) · `MG-TG-2` OPEN → **PARTIAL** (the n8n relay now exists on Legacy's contract; a live relay round trip stays NOT_VERIFIED) · **`MG-AI-ANONYMIZE` opened**: no image library exists here, so the anonymizer reports "cannot guarantee" and images never leave the machine — the security property holds and Gemini vision is the capability lost; adding a dependency is an owner decision · `AI-01/02/03` MISSING → **BACKEND_ONLY** · `ADM-03` and `SUP-02` annotated. Nothing was closed by renaming; no capability was removed |
| Tool verdict | `tools/agent-context.mjs` reports `DRIFTED` **while this branch is checked out** — expected: the tool compares HEAD against the verified `main` SHA, and this work is deliberately not on `main` |

**Nothing in this row may be cited as a property of `main`, of production, or of a
deployed environment.** A live Telegram delivery, a live Gemini call, a delivered
webhook and real-PostgreSQL concurrency are all `NOT_VERIFIED`
(`docs/telegram/DEPLOYMENT.md` §7).

## 3. Verification-state vocabulary (binding)

Exactly five states describe **how a claim is verified**. They are orthogonal
to delivery statuses (`COMPLETED`/`PLANNED`/… in `MASTER_ROADMAP.md`) and to
decision classes (`PORT`/`SKIP`/`DEFER`/`SYNCED` in
`docs/capability-registry.md`).

| State | Meaning | Evidence required | Relation to legacy vocabularies |
|---|---|---|---|
| `STATIC` | Proved by reading source/schema/config at a recorded commit | File path + commit | AGENTS.md `VERIFIED` (source-verified); audit tag `STATIC` |
| `RECORDED_RUNTIME` | Runtime evidence captured at a point in time (test run, build, GHA run, Playwright audit, deploy log) — valid **for the exact commit it was captured on** | Dated record + commit + run artifact | Audit tag `RUNTIME (as recorded)`; `docs/evidence/*` records |
| `CURRENT_RUNTIME_VERIFIED` | Runtime evidence re-captured **against the current tree** in a verified-current session | Fresh dated record + commit == current verified SHA | Strongest form of `VERIFIED`; **may never be asserted without new captured evidence** (AGENTS.md rule 15) |
| `NOT_VERIFIED` | No evidence either way — including anything requiring credentials, external services, or a deployed environment | — | AGENTS.md `ASSUMPTION`; audit `NOT VERIFIED`; registry "NEEDS VERIFICATION" |
| `OWNER_DECISION_REQUIRED` | Blocked on an owner choice; never guessed away | — | AGENTS.md `OPEN QUESTION`/`OWNER DECISION REQUIRED` (identical semantics) |

**Decay rule (binding):** `RECORDED_RUNTIME` evidence decays to *stale* (treated
as `NOT_VERIFIED` for decision-making) when the tree advances past the commit
the evidence was captured on **via an application-path change** (see §4). It
does **not** decay on governance-only changes. `CURRENT_RUNTIME_VERIFIED` is
valid only for the session and tree it was captured on; the next session starts
from `RECORDED_RUNTIME` at best.

## 4. Drift policy — what counts as "changed"

`tools/agent-context.mjs` classifies every commit since the last verified SHA:

- **Governance-only** (does **not** invalidate evidence): changes confined to
  `docs/**`, `AGENTS.md`, `README.md`, `MASTER_ROADMAP.md`,
  `tools/agent-context.mjs`.
- **Application/evidence-affecting** (marks state **DRIFTED** until
  re-verified): anything else — `apps/**`, `packages/**`, `db/**`, `infra/**`,
  `parity/**`, `ops/**`, `.github/**`, `railway.json`, `package.json`, other
  `tools/**` files, container/config changes. This list is deliberately
  conservative: over-triggering drift is safe; under-triggering it is not.

On **DRIFTED**: gaps whose evidence cites pre-drift commits are stale; update
this file, the gap register, and `CHANGE_LOG.md` (impact + evidence) before
acting on them. A full two-repository re-audit is required **only** when the
audit's own evidence has become stale *and* the delta cannot be curated through
`CHANGE_LOG.md` — or when the owner explicitly orders one.

## 5. Current verified snapshot

| Item | Value | Verification |
|---|---|---|
| Modern repo HEAD (last verified) | `ab0eed790fa8ffc160bc53e34264a61b02ffaedb` — **PR #8 merged to `main`** (merge commit, parents `ffcb0e9` + `75ddf5c`; AC-8). Chain since the audit baseline: ADR-017 system (AC-1) → documentation closure incl. the only `apps/**` change, a 6-line comment (AC-2/AC-3) → push/PR (AC-4) → brief + build evidence (AC-5) → real-PG battery evidence (AC-6) → MD/JSON sync (AC-7) — all governance-only, no application behavior change | `STATIC` (git, 2026-09-26) |
| Legacy repo HEAD (last verified) | `edede313280f2f0e298f5ccbf5bbdd4d676c80bd` — unchanged since audit; zero drift | `STATIC` (git, 2026-09-26) |
| Migration closure | **NOT CLOSED** (audit 2026-09-25 verdict stands; the 2026-10-05 register is 17 OPEN / 27 PARTIAL / 12 CLOSED — assembly, S1, and several domain gaps have since landed on the integration branch, but worker runtime, scheduled sync, data migration and live-provider verification remain open) | `STATIC` + register |
| Open closure gates | 14 FAIL + 1 PARTIAL per audit score line (see gap register §A) — several gates now have branch-local implementations awaiting merge/live verification | `STATIC` |
| Open owner decisions | 12 (R1, R2, R8, R9, OD-1, ADR-004 sampling, RPO/RTO, subscription mapping, worker service definition, MG-AI-ANONYMIZE image dependency, OD-M-PA-1/2/3 ratification, CSP pinning model) | `OWNER_DECISION_REQUIRED` |
| Local test battery | **re-captured 2026-10-06 at `7c6e246` (integration branch)**: tsc 0 errors (5 projects) · **1344/1344** (0 fail/skip) · secret-scan 0 findings · **real-PG 17.11 full sweep @ head `0030`: 33 batteries × forward+reverse = 66 runs, 642 tests, 0 fail, 0 skipped → REAL-PG EVIDENCE: PASS** (logs `docs/state/evidence/pg-batteries-20261006T0444Z/`) · load rehearsal REHEARSAL_PASSED at HEAD (real PG) · restore drill data-loaded: parity 56 tables / 49 numeric columns, smoke 11/11, ADR-012 gate REJECT recorded · worker least-privilege runtime (`velora_worker` role): 7/7 `metaapi.sync-tick` fires completed (first execution anywhere) | `RECORDED_RUNTIME` (valid for `7c6e246`; decays per §3) |
| Worker runtime, HSTS-at-edge, Stripe prices, LIVE providers (MetaAPI/Telegram/AI relay) | No evidence | `NOT_VERIFIED` |
| Backups/restore | Local disposable drill PASSED 2026-10-03 (AC-21: 44 tables/49 numeric columns parity, `RESTORE_VERIFIED`, restore drill battery) — scheduled/offsite production posture NOT_VERIFIED (owner-gated credential) | `RECORDED_RUNTIME` (local only) |
| Session-start verdict | Run `node tools/agent-context.mjs` — its output supersedes this snapshot | — |

**Highest-priority open items** (full list: `MIGRATION_GAP_REGISTER.md`):
scheduled MetaAPI sync cadence + LIVE provider round trip (incl. OD-M-PA
ratification) → worker deployment/runtime → remaining security regressions
(S4 HSTS, S2 pinning remainder, S5 R8 decision) → route/API-surface coverage
(MG-API-MISSING-ROUTES, MG-SCHEMA-MAPPING) → web/i18n/email/RBAC-vocab
coverage → data migration → backup offsite/scheduling → admin remaining
blocks → documentation drift.

## 6. Recorded contradictions with other status documents (do not silently trust either side)

These are recorded, not resolved (owner rule; AGENTS.md rule 12). See gap
register §E for the full list, including `MG-DOC-1`…`MG-DOC-5`:

- `MASTER_ROADMAP.md` marks ACCT-02/AI-01/ADMIN-01/BILL-01 as `COMPLETED
  (backend)`; the 2026-09-25 audit rules MetaAPI assembly a correctness
  blocker (§9.2), the AI layer a seam only (§12.5), and admin 93% absent
  (§4.2). The audit is newer and baseline-equal; reconciliation of the roadmap
  is an open documentation gap (`MG-DOC-3`), **not** a reason to edit either
  document silently.
- **Closed 2026-09-26 (CHANGE_LOG AC-2):** README defects D1/D2, `ScreenshotController` citation D4, report supersession D5, ADR-015 gap documentation.
- **Still open:** `MG-DOC-3` — MASTER_ROADMAP row-level reconciliation (banner added; rows unedited per owner instruction; owner-reviewed change required).

## 7. Update obligations (who writes here, when)

1. Any change that alters migration state (gap opened/closed, evidence
   captured, runtime verified, owner decision recorded) must update this file
   + `current-state.json` + the gap register + `CHANGE_LOG.md` **in the same
   change** (extends AGENTS.md rule 11).
2. `CURRENT_RUNTIME_VERIFIED` may only be set by the session that actually
   captured the runtime evidence, citing commit + date + artifact.
3. This file never claims implementation or runtime verification without
   evidence — missing evidence is recorded as `NOT_VERIFIED`.
4. When a newer authoritative audit is stored under `docs/audits/`, this file
   is re-baselined against it in the same change.
