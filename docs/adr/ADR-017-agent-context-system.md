# ADR-017 — Agent Context System (Persistent Project State)

## Status

**Accepted — owner instruction 2026-09-26 (Agent Context / Current Project State
system; verbatim audit storage + persistent state mechanism).** Governance-only:
this ADR introduces no application code, no schema, no migration, no contract
change, and no deployment.

## Context

The 2026-09-25 *Final Two-Repository Migration Reconciliation Audit*
established the authoritative migration baseline (modern `ffcb0e9`, legacy
`edede31`; verdict **NOT CLOSED**, closure gates 0 PASS / 1 PARTIAL / 14 FAIL),
but existed only as a session artifact outside both repositories — the same
fate that already befell the 2026-09-12 Reconciliation Gate Report and the
2026-09-15 MetaAPI Readiness Audit. Concurrently, project status was scattered
across ≥6 documents with four coexisting vocabularies and freshness levels
ranging from 2026-09-12 to 2026-09-24, and the designated agent entry point
(`AGENTS.md`) reflected a 2026-09-15 worldview whose artifact map omitted the
architecture authority (`MASTER_ROADMAP.md`) and the newest evidence. There was
no mechanism to determine, at session start: what changed since the last
verified state, which evidence is stale, and which gaps remain open.

Inspection (2026-09-26) also confirmed the repo already contains the right
reusable patterns: a lean governance-only `AGENTS.md`, an ADR series, an
evidence-record discipline (`docs/evidence/`), a capability registry with
evidence-gated `SYNCED`, owner-decision ledgers, and a machine-readable
resume-state precedent (`docs/frontend-migration-progress.md`). The correct
move is to **generalize those patterns**, not to add a competing agent system
(no `CLAUDE.md`, no `.claude/`).

## Decision

1. **Immutable historical audits** live in `docs/audits/` — verbatim,
   byte-locked (SHA-256 pinned in `docs/state/current-state.json` and
   re-verified at every session start), superseded only by newer dated audits,
   never edited. The 2026-09-25 audit is stored as
   `docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md`.
2. **Canonical current state** lives in `docs/state/CURRENT_STATE.md` +
   `docs/state/current-state.json`. For current decisions the state file is
   authoritative; the audit is never edited to match the present.
3. **Gap tracking** lives in `docs/state/MIGRATION_GAP_REGISTER.md` +
   `docs/state/migration-gap-register.json` — every open gap, every closed gap
   with evidence, stable `MG-*` IDs, and recorded (never silently resolved)
   contradictions between status documents.
4. **Change history** lives in `docs/state/CHANGE_LOG.md` — append-only
   commit → impact → evidence entries since the audit baseline.
5. **Five verification states** (`STATIC`, `RECORDED_RUNTIME`,
   `CURRENT_RUNTIME_VERIFIED`, `NOT_VERIFIED`, `OWNER_DECISION_REQUIRED`) are
   the binding vocabulary for evidence claims, orthogonal to delivery statuses
   and decision classes. Decay rule: `RECORDED_RUNTIME` evidence goes stale
   when an application-path change advances the tree past the commit the
   evidence was captured on; governance-only commits do not invalidate.
6. **Drift classification** (governance-only vs application-affecting paths)
   and state validation are automated by `tools/agent-context.mjs`
   (dependency-free, session-run only — no CI workflow, per the owner's
   GitHub Actions cost policy). Session protocol step 1 requires running it
   and obeying the verdict.
7. **State discipline** extends AGENTS.md rule 11: any change that alters
   migration state updates the state files in the same change; a commit cannot
   contain its own hash, so the introducing commit self-records via
   `CHANGE_LOG.md` (AC-1) and the tool's classification.

## Alternatives rejected

- **A new `CLAUDE.md` / `.claude/` agent system** — explicitly rejected by the
  owner (2026-09-26); it would duplicate `AGENTS.md` and fragment governance.
- **Encoding current state in `MASTER_ROADMAP.md`** — rejected: the roadmap is
  an architecture/planning authority with its own delivery vocabulary and a
  known staleness conflict with the audit (tracked as `MG-DOC-3`); mixing
  current-state bookkeeping into it would make both harder to trust.
- **CI-enforced state checks** — rejected: GitHub Actions is disabled at the
  repository level per the owner cost policy; the mechanism must be
  agent-executed and owner-auditable.
- **Editing the 2026-09-25 audit to fix its internal gate-score discrepancy**
  (§19.1 table shows 2 PARTIAL rows; its score line says 1 PARTIAL / 14 FAIL) —
  rejected: audits are immutable; the discrepancy is recorded as `MG-OBS-1`.

## Consequences

- A fresh agent session reads `AGENTS.md` → runs
  `node tools/agent-context.mjs` → reads `docs/state/CURRENT_STATE.md` and the
  gap register, and knows within minutes what is verified, what is stale, and
  what is open — without re-auditing two repositories.
- A full re-audit is needed only when evidence is stale beyond what
  `CHANGE_LOG.md` can curate, or when the owner explicitly orders one.
- The system adds update obligations: state files must move with every
  state-affecting change, and the tool's failure blocks sensible session
  progress until state is curated (this is deliberate — fail-closed, like
  ADR-012/013).
- `CURRENT_RUNTIME_VERIFIED` can never be asserted without fresh captured
  evidence (AGENTS.md rule 15); the tool does not grant it, sessions earn it.
- Historical truths remain queryable forever: the audit's own §-references are
  the citation currency for every gap row.
