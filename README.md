# velora-modern

Modern TypeScript implementation of Velora (trading journal platform).
**Status: PHASE 1 — ARCHITECTURE FOUNDATION (in progress, D-10 authorized
2026-08-31, dev/staging only).**

- No application code exists in this repository yet, by design.
- The production system remains the PHP repository (`veloratrade/veloratrade`)
  during modernization; sync is one-way PHP → Modern (capability registry model).
- Entry points: `AGENTS.md` (governance) → `docs/phase-0-exit-criteria.md` (gates)
  → `docs/adr/` (decisions — all ten Accepted 2026-08-29; evidence-gated sub-items
  remain open inside ADR-004 [legacy-TZ sampling] and ADR-009 [hreflang verification]).

Phase 1 (Architecture Foundation — dev/staging only) awaits only the owner's
explicit authorization (D-10); production hosting validation (Gate 3B) is a
separate, later gate on the production track.
