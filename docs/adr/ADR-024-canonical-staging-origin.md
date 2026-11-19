# ADR-024 — Canonical staging origin (OD-1)

## Status

Proposed — owner decision required (OD-1). Recommended: adopt
`https://staging.veloratrade.ir` as the canonical staging origin.

## Context

ADR-013 (environment-origin safety) requires an explicit, owner-selected
canonical origin per environment. The boot gate (EO-008/EO-009) refuses to
start staging/production when:

* the environment's canonical origin set is empty, or
* `APP_ORIGIN` is not a member of that set.

The staging origin has been `OPEN` since the 2026-09-25 audit (OD-1 listed as
an open owner decision in CURRENT_STATE.md). `CANONICAL_STAGING_ORIGINS` and
`CANONICAL_PRODUCTION_ORIGINS` are declared as name-only in
`infra/env/.env.example`; they are declarations of an owner decision, not
defaults.

phase-0-exit-criteria OD-8 (2026-09-12) approved
`https://staging.veloratrade.ir` as a *candidate only*, not a production host.
ADR-013's reconciliation gate records OD-1 as `OWNER DECISION REQUIRED`.

## Decision (recommended)

Adopt `https://staging.veloratrade.ir` as the canonical staging origin (OD-1).

- Staging remains non-production; the origin is a declaration, not a prod
  claim.
- No application code change is required: `CANONICAL_STAGING_ORIGINS` is
  populated in the target environment's secret store (name-only in
  `infra/env/.env.example`); `APP_ORIGIN` must be a member of the set at boot
  or the gate fails closed.
- `APP_ENV` must be exactly `development` | `staging` | `production`
  (ADR-013); missing/unknown is invalid — no implicit default.

## Alternatives considered

- Leave OD-1 open — declined: W5 ops setup (staging topology) is gated on
  OD-1, and the boot gate already enforces it fail-closed, so an undecided
  origin blocks any staging deploy by design.
- Use a different origin — declined: `https://staging.veloratrade.ir` is the
  existing, owner-approved candidate (OD-8); no competing candidate exists.

## Consequences

### Positive

- W5 OD-1 unblocked; staging topology can proceed once the origin value is
  provisioned in the staging secret store.
- Boot gate remains fail-closed: no start with an empty or mismatched origin.

### Negative

- The origin value itself must be provisioned per environment (secret store,
  never committed). Until then, staging boot is blocked by design.

## Migration impact

None — environment configuration only, no schema or code change.

## Testing / verification requirements

- `packages/contracts/src/environment.test.ts` continues to pass (origin
  validation contract unchanged).
- Boot gate rejects `APP_ENV=staging` with empty `CANONICAL_STAGING_ORIGINS`
  (fail-closed), and accepts it when `https://staging.veloratrade.ir` is a
  member and `APP_ORIGIN` matches.

## Phase

Phase 2 wave W5 (ops setup). Unblocks `infra/docker-compose.yml` `web`
service staging topology and `railway.json` deploy targeting.
