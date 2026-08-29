# ADR-010 — Delivery Model & Repository Posture

## Status

Accepted — owner decision D-15 (2026-08-29): monorepo/thin-apps/`packages/domain`, immutable-image delivery, DB role separation, backup + restore-drill gate, StoragePort, stateless applications, environment separation approved. **Repository posture: PUBLIC — owner decision D-06 (revised 2026-08-29)**; PRIVATE was originally proposed, the owner explicitly chose to keep the repository public. Public visibility does **not** relax secret-safety requirements (see Decision).

## Context

The modern system needs a delivery model that is reproducible, rollback-safe, and
operable by a small team — and a repository posture deliberately chosen by the
owner with secret-safety rules that hold under either visibility.

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
- **`velora-modern` = PUBLIC — owner decision D-06 (revised 2026-08-29).**
  PRIVATE was originally proposed; the owner explicitly revised the decision to
  keep the repository public. This is an intentional, approved posture — not a
  pending action. **Boundary that survives the revision:** visibility policy and
  secret safety are separate concerns. Public visibility changes nothing about the
  absolute rules — no secrets, no credentials, no operational infrastructure
  identifiers, no user data in the repository, ever — and the pre-push
  secret-safety scan (performed 2026-08-29: zero findings) remains a standing
  gate before every push. The agent never changes visibility in either direction
  without explicit owner instruction.
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
- Public repo: **chosen by owner** (D-06 revised 2026-08-29) — transparency accepted after review; conditioned on the standing secret-safety scan and no-operational-data rules above.
- Single mixed image: rejected (independent scaling/rollback of worker vs api).

## Consequences

### Positive
- Reproducible environments; mechanical rollback; env-isolated secrets; parity between staging and production by construction.

### Negative
- Image pipeline + registry dependency (region reachability = hosting-validation checklist item).
- More moving parts than FTP (accepted cost of leaving shared hosting).

## Security Impact

Env separation + role separation directly retire two verified PHP-era risks
(shared FTP account, shared mail key). Public posture is accepted by owner
decision with secret-safety scanning as the compensating control — it does not
make security concerns irrelevant; it makes the no-secrets rule absolute.

## Migration Impact

None directly; delivery model must exist before Phase 3 scale tests.

## Testing / Verification Requirements

- Restore drill (Phase 1 gate, then scheduled); image scan in CI; compose config parity check staging↔prod.

## Open Questions

1. Repository visibility — **RESOLVED**: KEEP PUBLIC (owner decision D-06, revised 2026-08-29).
2. Registry choice + mirror strategy (hosting-validation).

## Phase

Phase 0 decision; infra implementation = Phase 1.
