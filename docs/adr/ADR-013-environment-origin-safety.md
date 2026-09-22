# ADR-013 — Environment-Origin Safety Contract

## Status

**Accepted — owner decision D-17 (2026-09-12), via post-audit governance-alignment directive.**
Contract-level implementation included (typed validator in
`packages/contracts/src/environment.ts` + unit tests). Runtime wiring is future
work under this contract. One sub-decision remains open: **OD-1 — canonical
Modern staging origin (OWNER DECISION REQUIRED)**.

Adapted from the Reference guard `tools/check_frontend_url_guard.py` @
`a8eabac` (rules FU-000…FU-006) and `frontend-url-guard.yml` (read-only,
secret-never-echoed verification). Generalized from a single `FRONTEND_URL`
variable to an **environment-identity ↔ application-origin binding**; the PHP
mechanism is not copied.

## Context

The failure class this prevents is real and documented in the Reference: a
staging host whose env carries the production URL boots silently and emails
production verification links to staging users, burning staging tokens against
the production database (guard docstring, FU-004). The inverse (production
config pointing at staging) breaks link delivery and reputation. The audit
classified this RM-2/P0 (milestone-gated: required before Modern's first
staging deploy) and flagged the undecided staging origin as conflict CF-4.

Modern's existing origin guard (`apps/api/src/kernel/security.ts`,
`originAllowed()`) protects a different axis: per-request browser `Origin`
headers (CSRF-class, ADR-005). This contract protects **environment
configuration identity**. Both are required; neither substitutes the other.

## Verified Evidence

- Reference guard rules @ `a8eabac`: FU-000 (missing/empty), FU-001
  (malformed), FU-002 (scheme https), FU-003 (bare origin — no path/query/
  fragment/credentials), FU-004 (production domain outside production =
  BLOCK), FU-005 (must match architected staging origin), FU-006 (no
  non-default port). Secret safety: values never printed — rule codes only.
- Reference canonical origins: production `veloratrade.ir` / `www.veloratrade.ir`;
  staging `https://staging.veloratrade.ir` (deploy.yml base_url, guard default).
- Modern gap: PROVEN ABSENT @ `e75b575` — no environment-identity or
  origin-binding validation anywhere (audit §10 row 5).
- Modern `infra/env/` is names-only by design (D-06 public repo).

## Decision — the contract

1. **Environment identity is explicit.** `APP_ENV` ∈
   `development | staging | production`. Missing, empty, or unknown values are
   **invalid** — unknown environments are never trusted and there is **no
   implicit default**. *(Intentionally stricter than the Reference, whose
   config defaulted `APP_ENV` to `production`; Modern forbids implicit
   identity entirely.)*
2. **Every non-development environment has a canonical application-origin
   set** (owner-defined):
   - Production: `https://veloratrade.ir`, `https://www.veloratrade.ir`
     (carried from the PHP system — VERIFIED).
   - Staging: **CANDIDATE** `https://staging.veloratrade.ir` (matches the
     Reference architected origin) — **OD-1, OWNER DECISION REQUIRED**. Until
     decided, staging origins cannot be validated, and staging must not be
     operated (rule EO-008 fails closed).
3. **The application origin (`APP_ORIGIN`) must be:**
   - explicitly configured — missing → BLOCK, no implicit default;
   - an absolute `https` origin (`http` allowed only for loopback in
     development);
   - a bare origin — no path, no trailing slash, no query, no fragment, no
     embedded credentials;
   - free of non-default ports outside development loopback.
4. **The environment↔origin mapping is closed. All of these are BLOCKED:**

   ```text
   staging intent    → production origin
   production intent → staging origin
   unknown environment → any origin (even a trusted one)
   missing origin     → implicit default
   ```

   Additionally: any non-production environment pointing at a production
   origin is BLOCKED; production origins must match the canonical set exactly.
   Development allows loopback origins (http, ports); non-loopback development
   origins pass with a warning.
5. **Fail-closed everywhere.** Validation errors block; config absence
   blocks; parse failures block; an absent canonical map for the target
   environment blocks.
6. **Secret safety.** Findings carry rule codes and fixed messages only —
   origin values are never embedded in findings (same property as the
   Reference guard).
7. **Consumers (when wired):** environment config loading in staging/production
   runtimes; deploy targeting; external link generation (email links — C-06/C-07
   derive from the application origin); parity target selection.

## Rule codes (implemented)

| Code | Severity | Rule |
|---|---|---|
| EO-001 | BLOCK | APP_ENV missing/unknown — no implicit default, unknown never trusted |
| EO-002 | BLOCK | APP_ORIGIN missing/empty — no implicit default |
| EO-003 | BLOCK | APP_ORIGIN not parseable as an absolute URL |
| EO-004 | BLOCK | scheme not https (outside development loopback) |
| EO-005 | BLOCK | not a bare origin (path/trailing slash/query/fragment/credentials) |
| EO-006 | BLOCK | non-default port (outside development loopback) |
| EO-007 | BLOCK | cross-environment: non-production environment using a production origin |
| EO-008 | BLOCK | staging with no decided canonical origin (OD-1 open) — staging cannot be validated |
| EO-009 | BLOCK | origin not in the target environment's canonical set |
| EO-010 | WARN | development origin is not loopback |

## Implementation (this change — contract tier only)

- `packages/contracts/src/environment.ts` — pure, I/O-free:
  `parseEnvironment()` + `validateEnvironmentOrigin(rawEnv, rawOrigin, canonical)`.
  Canonical maps are **supplied by the caller**; no staging origin is
  hardcoded in code until OD-1 is decided.
- `packages/contracts/src/environment.test.ts` — the four forbidden cases from
  the directive plus happy paths and every rule code.
- `infra/env/.env.example` + `infra/env/README.md` — names-only additions
  (`APP_ENV`, `APP_ORIGIN`).

Runtime wiring (config loading, CI check, staging bring-up, deploy targeting)
is future work and MUST consume this contract rather than re-implement it.

## Open decisions

- **OD-1 (OWNER DECISION REQUIRED):** canonical Modern staging origin.
  Candidate: `https://staging.veloratrade.ir`. Blocks staging operation, not
  the contract itself.
- **OD-2:** freshness/re-validation policy for origin config — deferred to
  runtime wiring.

## Acceptance criteria

- [x] The four forbidden cases are encoded as tests and fail closed.
- [x] Full suite + typecheck + secret scan green with the new contract.
- [x] No staging origin value is hardcoded in runtime code or configuration;
      the only occurrence of a staging origin anywhere is one explicitly
      marked TEST FIXTURE in `environment.test.ts` (fixture-only comment),
      which asserts behavior, not the decision.
- [ ] Runtime consumers wire validation before staging exists (future).

## Audit trail

- Reference: `tools/check_frontend_url_guard.py`, `frontend-url-guard.yml`,
  canonical origins in `deploy.yml` @ `a8eabac`.
- Cross-repository audit 2026-09-12: RM-2 (P0), CF-4.
- Owner directive: governance-alignment task 2026-09-12 → decision D-17.
