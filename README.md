# velora-modern

Modern TypeScript implementation of Velora (trading journal platform).

**Monorepo:** `apps/api` (Node API) · `apps/web` (Next.js) · `apps/worker`
(pg-boss) · `packages/{contracts,domain}` · PostgreSQL 16 via direct `pg`
(no ORM — ADR-010 / OD-6) · forward-only migrations `db/migrations/0001…0022`.

**Status: MIGRATION NOT CLOSED** — 2026-09-25 two-repository audit verdict:
*NOT CLOSED — PARTIAL MIGRATION WITH MATERIAL BEHAVIOURAL DIVERGENCE AND
BLOCKING OPERATIONAL GAPS* (closure gates 0 PASS / 1 PARTIAL / 14 FAIL).

- Canonical current project state: `docs/state/CURRENT_STATE.md` (machine
  twin `docs/state/current-state.json`), validated at session start by
  `node tools/agent-context.mjs` (ADR-017).
- Immutable historical baseline:
  `docs/audits/2026-09-25-FINAL-MIGRATION-RECONCILIATION-AUDIT.md`.
- The production system remains the PHP repository
  (`veloratrade/veloratrade`) during modernization; sync is one-way
  PHP → Modern (capability registry model).
- Entry points: `AGENTS.md` (governance + session protocol) →
  `docs/state/CURRENT_STATE.md` (current state) → `docs/adr/`
  (ADR-001…014, 016, 017 — ADR-015 intentionally unassigned, see
  `docs/adr/README.md`).
