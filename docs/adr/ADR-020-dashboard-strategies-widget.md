# ADR-020 — Dashboard strategies widget (W0 decision R9)

## Status

Accepted — owner decision (2026-11-18): **Option A — port the strategies widget as-is**.

## Context

The W0 gap analysis (audit §9.3 / gap register OD-AC-R9) flagged an open owner decision on how Modern should surface "strategies" on the dashboard: Legacy's dashboard renders strategy-related KPIs (win rate, ordering, untagged buckets), but Modern has no standalone strategy capability — phase-5 evidence (PHASE-C-INCREMENT-5) confirmed there is no strategy CRUD/entity/migration in either lineage, and the strategyTag journal contract is regression-tested only. The dashboard strategies work (wave W2, items A5 + B10) therefore needs a binding decision on semantics before implementation: invent Modern strategy determination (winRate/order/untagged computation), or port Legacy's existing widget read-only as-is.

## Decision

**Option A — port the strategies widget as-is.**

- Surface the dashboard strategies widget using Legacy's existing strategy tags / order buckets where that data already exists in Modern (the strategyTag journal contract), read-only.
- Do **not** invent a Modern strategy determination engine, winRate computation, ordering semantics, or "untagged" bucket logic. No new strategy entity, migration, or API is manufactured.
- Where the widget needs values Modern does not produce, it renders the honest absent/unknown state rather than fabricated figures (consistent with the intelligence page rule: never reproduce Legacy's fabricated demo copy).
- The decision is recorded here so W2 (A5 dashboard strategies + B10 strategies widget) implements against a fixed contract instead of re-litigating semantics.

## Alternatives considered

- Option B (invent Modern strategy semantics: compute winRate/order/untagged from trade data) — declined: no owner-approved definition of "win rate" or ordering exists; implementing it would fabricate a business rule.
- Option C (defer the widget until a strategy capability exists) — declined: the dashboard surface is a real Legacy capability users expect; porting it read-only against existing data carries no fabrication risk and unblocks W2.

## Consequences

### Positive
- W2 can proceed with a fixed contract: the widget reads existing strategyTag data and renders absent/unknown where data is missing.
- No fabricated business logic; no new migration, entity, or API surface.

### Negative
- The widget's strategy figures reflect only data already present (strategyTag), not a recomputed Modern win rate; any richer strategy determination remains a future owner decision.

## Migration impact

None — no schema change, no migration, no data transformation.

## Testing / verification requirements

- W2 dashboard strategies tests pin that the widget renders strategyTag-derived values read-only and never fabricates winRate/order/untagged figures.
- `registryConsistency.test.ts` counts unchanged (no new capability declared).

## Phase

Phase 2 wave W2 (dashboard strategies + strategies widget). Blocks MG-G02.
