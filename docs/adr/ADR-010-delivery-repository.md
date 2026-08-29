# ADR-010 — Delivery Model & Repository Posture

## Status

Accepted — owner decision D-15 (2026-08-29): monorepo/thin-apps/`packages/domain`, immutable-image delivery, DB role separation, backup + restore-drill gate, StoragePort, stateless applications, environment separation, and PRIVATE repository posture approved **as policy**. The actual visibility flip remains a manual owner action (D-06) — not yet performed; Gate 1 stays BLOCKED until flipped and confirmed.

## Context

The modern system needs a delivery model that is reproducible, rollback-safe, and
operable by a small team — and a repository posture that does not publish the
system's security architecture.

## Verified Evidence

- `velora-modern` verified via GitHub API (2026-08-29): **public, empty**, no branches.
- PHP delivery model (VERIFIED docs): allow-list FTP package, 11 guards, backup
  artifact, manual dispatch, Actions cost-guarded — an artifact-of-constraints
  pipeline (FTP-only host, OC-1/OC-2) that must NOT be reproduced.
- PHP incident history (VERIFIED): single FTP account spans staging+production
  (accepted risk, OC-10/11); shared Resend key across environments (open debt).

## Decision

**Repository**

- Monorepo (`apps/web`, `apps/api`, `apps/worker` thin; `packages/domain` holds
  business logic; `packages/contracts` the schema source).
- **`velora-modern` = PRIVATE** — *proposed*. REQUIRED DECISION (Gate 1): the
  repository must be switched to private **by the owner** before architectural/
  security material (threat model, ADRs, contracts) is pushed. Agent must not
  change visibility automatically. Current verified state: **public**.
- TypeScript, Next.js (public/SEO + app route groups), NestJS (API), PostgreSQL,
  dedicated workers, pg-boss (ADR-007), stateless applications.

**Delivery**

- Docker images per app; **immutable tags** (git SHA); no `latest` in any environment.
- Single host initially: Docker Compose + reverse proxy (TLS, HTTP→HTTPS, HSTS).
- Rollback = redeploy previous image tag + documented data-compatibility policy
  (migrations are forward-only; rollback restores from backup — restore drill is a gate).
- **Environment separation:** staging and production = separate hosts/credentials/
  secret stores (deliberately not repeating the shared-FTP-account risk).
- **DB role separation:** `app_readwrite` (api), `worker` (jobs/sync), `migrator`
  (schema), `readonly` (analytics/reports) — least privilege by construction.
- **Backups:** PITR (WAL archiving) + nightly dumps → encrypted, offsite object
  storage; **restore drill is a release gate, not a hope**.
- **Object storage behind a port** (`StoragePort`): local-volume implementation
  first, S3-compatible provider later (screenshots are migration scope — rows + bytes).
- **Observability:** OTel-compatible metrics/logs/traces + Sentry-compatible error
  tracking from Phase 1 (observability-contract).

## Alternatives Considered

- Kubernetes now: rejected (no ops team; Compose is sufficient to 5k+ users on 2–3 nodes).
- Public repo (transparency): rejected for the modernization period (security-sensitive docs); can be revisited post-cutover.
- Single mixed image: rejected (independent scaling/rollback of worker vs api).

## Consequences

### Positive
- Reproducible environments; mechanical rollback; env-isolated secrets; parity between staging and production by construction.

### Negative
- Image pipeline + registry dependency (region reachability = hosting-validation checklist item).
- More moving parts than FTP (accepted cost of leaving shared hosting).

## Security Impact

Env separation + role separation + private posture directly retire three verified
PHP-era risks (shared FTP account, shared mail key, public security docs).

## Migration Impact

None directly; delivery model must exist before Phase 3 scale tests.

## Testing / Verification Requirements

- Restore drill (Phase 1 gate, then scheduled); image scan in CI; compose config parity check staging↔prod.

## Open Questions

1. **Owner: flip `velora-modern` to private (Gate 1) — REQUIRED DECISION.**
2. Registry choice + mirror strategy (hosting-validation).

## Phase

Phase 0 decision; infra implementation = Phase 1.
