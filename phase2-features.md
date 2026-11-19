# Phase 2 feature decisions — W5 ops setup recommendations

This document records the Phase 2 (Modern) feature-level decisions the agent
recommends for the remaining owner-gated items, so each can be ratified as an
ADR and then implemented. It is the reference the user pointed to for OD-1 and
R3.

## OD-1 — canonical staging origin

**Context.** ADR-013 (environment-origin safety) requires an explicit,
owner-selected canonical origin per environment; the boot gate (EO-008/EO-009)
refuses to start staging/production when the canonical origin set is empty or
APP_ORIGIN is not a member of it. The staging origin has been `OPEN` since the
audit.

**Candidate (from phase-0-exit-criteria OD-8, 2026-09-12):**
`https://staging.veloratrade.ir` — approved as a *candidate only*, not a
production host.

**Recommendation.** Adopt `https://staging.veloratrade.ir` as the canonical
staging origin (OD-1). Record in ADR-024. Staging remains non-production; the
origin is a declaration, not a prod claim. No code change is required beyond
populating `CANONICAL_STAGING_ORIGINS` in the target environment's secret store
(via `infra/env/.env.example` name); `APP_ORIGIN` must be a member of the set
at boot or the gate fails closed.

## R3 — numeric[] array parsing

**Context.** MASTER_ROADMAP W5 lists R3 as a gate. R3 is defined in
`docs/reconciliation/PHASE-D-D1-ORM-SPIKE.md` (§5-R3): `numeric[]` columns
parse to FLOAT through the default `pg` type parsers (`register(1231,
parseFloatArray)`), so no `numeric[]` column may be selected through `pg`
defaults.

**Status.** VERIFIED (code-level): no `numeric[]` column exists today, and no
`setTypeParser` overrides exist in repo source. R3 requires no change — keep
it that way. No ADR needed; it is a standing constraint, not an open decision.

## W5 scope summary (all code-side items complete)

| Item | Status |
|------|--------|
| `infra/Dockerfile.web` | EXISTS — multi-stage, non-root, healthchecked (W5 frontend delivery) |
| `infra/Dockerfile.api` / `infra/Dockerfile.worker` | EXISTS |
| `infra/docker-compose.yml` | EXISTS — web + api + worker + migrate + postgres |
| `railway.json` | EXISTS — RAILPACK build, migrate+start deploy command |
| R2 `trustedProxyCidrs` wiring | CODE DONE (AC-42): `boot.trustedProxyCidrs` → server-main.ts, `TRUSTED_PROXY_CIDRS` env, empty = fail-closed |
| OD-1 staging origin | OPEN → ADR-024 (`https://staging.veloratrade.ir`) |
| R3 | VERIFIED, no change |

Live secrets (MetaAPI, Resend, Stripe, JWT, credential master key) are NOT
available; all are name-only in `infra/env/.env.example`, provisioned per
environment through the secret store, fail-closed when absent.
