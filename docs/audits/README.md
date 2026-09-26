# docs/audits/ — Immutable Historical Audit Records

**Governing ADR:** ADR-017 (Agent Context System).
**Established:** 2026-09-26.

## What lives here

Verbatim, complete snapshots of **authoritative audits** of the Velora
migration. Each file is historical evidence pinned to exact repository
baselines. The current record:

| File | Audit date | Modern baseline | Legacy baseline | Verdict |
|---|---|---|---|---|
| `2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md` | 2026-09-25 | `ffcb0e976147c753493532188a598ecb5de8d06d` | `edede313280f2f0e298f5ccbf5bbdd4d676c80bd` | **NOT CLOSED — PARTIAL MIGRATION WITH MATERIAL BEHAVIOURAL DIVERGENCE AND BLOCKING OPERATIONAL GAPS** (closure gates: 0 PASS / 1 PARTIAL / 14 FAIL per the audit's own score line) |

## Binding rules

1. **Immutable.** A stored audit file is never edited, summarized,
   reconstructed, reformatted, renamed, or deleted — not to fix errors, not to
   resolve contradictions, not to reflect later findings. If an audit contains
   an error or internal inconsistency, the discrepancy is **recorded in
   `docs/state/MIGRATION_GAP_REGISTER.md`** and resolved by a *newer* dated
   audit or an owner decision — never by rewriting history.
2. **Verbatim.** The stored bytes must equal the authoritative original. The
   SHA-256 of each audit is pinned in `docs/state/current-state.json` and
   re-verified by `tools/agent-context.mjs` at every session start.
3. **Supersession, not replacement.** A newer audit supersedes an older one for
   *decision-making* only by being added as a **new file**; the older file stays.
4. **Historical ≠ current.** Nothing in this directory describes the current
   project state. Current state lives in `docs/state/CURRENT_STATE.md`. Where
   the two conflict, the state file (backed by `tools/agent-context.mjs`
   verification) governs the present; this directory governs what was true at
   its baseline.
5. **Secret-safety.** Only secret-free audit text may be committed (standing
   pre-push `tools/secret-scan.sh` gate, AGENTS.md rule 1 / D-06).
