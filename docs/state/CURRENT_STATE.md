# VELORA-MODERN — Current Project State (Canonical)

**System:** Agent Context System (ADR-017) · **Schema version:** 1
**Last updated:** 2026-09-26 (Asia/Tehran) — entries AC-1 (system introduced), AC-2 (documentation-defect closure), AC-3 (verified baseline `59047b8`, fresh battery), AC-4 (push + PR #8), AC-5 (build evidence refresh + MetaAPI assembly brief)
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
| Modern repo HEAD (last verified) | `59047b856e4794c1436ed6abfc01ab9a11c60c35` — audit baseline `ffcb0e9` + `2ad49df` (ADR-017, governance-only, AC-1) + `59047b8` (documentation-defect closure, AC-2; the only `apps/**` change is a 6-line comment, curated by AC-3) | `STATIC` (git, 2026-09-26) |
| Legacy repo HEAD (last verified) | `edede313280f2f0e298f5ccbf5bbdd4d676c80bd` — unchanged since audit; zero drift | `STATIC` (git, 2026-09-26) |
| Migration closure | **NOT CLOSED** (audit 2026-09-25; no application changes since → verdict still stands) | `STATIC` |
| Open closure gates | 14 FAIL + 1 PARTIAL per audit score line (see gap register §A) | `STATIC` |
| Open owner decisions | 9 (R1, R2, R8, R9, OD-1, ADR-004 sampling, RPO/RTO, subscription mapping, worker service definition) | `OWNER_DECISION_REQUIRED` |
| Local test battery | **re-captured 2026-09-26 at `59047b8`/`d85a589`**: tsc 0 errors · 804/804 (0 fail/skip) · migrations 19/19 · secret-scan 0 findings (AC-3); **`next build` exit 0 at `d85a589`** (route table emitted; 34 app-side pages measured — prior closure report counted 35 ƒ incl. middleware) (AC-5) | `CURRENT_RUNTIME_VERIFIED` (decays per §3) |
| Worker runtime, backups, restore, HSTS-at-edge, Stripe prices, real-PG batteries | No evidence | `NOT_VERIFIED` |
| Session-start verdict | Run `node tools/agent-context.mjs` — its output supersedes this snapshot | — |

**Highest-priority open items** (full list: `MIGRATION_GAP_REGISTER.md`):
MetaAPI position/fill assembly correctness → worker deployment/runtime →
security regressions (S1 cookie, S2 CSP, S4 HSTS, S5 edge authorization) →
admin migration → AI/OCR → backup/restore proof → documentation drift.

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
