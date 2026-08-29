# ADR-007 — Job & Queue Semantics

## Status

Proposed

## Context

The PHP system already runs production workers on a DB-lease queue without Redis
(VERIFIED: `metaapi_sync_worker.php` — fenced queue, atomic lease, cron-concurrency-safe;
`ai_job_worker.php` — "MySQL lease pattern … for PHP-FPM (no Redis)"). The modern
system formalizes the same model on PostgreSQL.

## Verified Evidence

- Fenced-queue worker pattern with atomic lease acquisition (VERIFIED source headers).
- Job domains (VERIFIED): MetaApi sync ticks, AI jobs, AI retention cleanup
  (`--dry-run`/`--execute` discipline), async content translation.
- GitHub Actions worker incident history (VERIFIED docs): a stuck-job/cost incident
  (1,353 runner-minutes cancelled) — motivation for timeouts and bounded retries.

## Decision

**Queue: pg-boss initially; Redis deferred.** Pin the pg-boss major version
(breaking changes between majors); queue-table retention/archival configured at
setup; queue-depth and job-age alerts are day-one (observability-contract).

**Standard job contract (every job class):**

| Property | Requirement |
|---|---|
| Idempotency key | business key, e.g. `sync:{accountId}:{cursor}`, `extract:{screenshotId}:{promptVersion}`, `outbox:{notificationId}` |
| Lease/visibility timeout | > worst-case runtime; renewed by long jobs |
| Retry | exponential backoff **with jitter**; max attempts bounded |
| Dead-letter | after max attempts → DLQ + alert; replay tooling required |
| Timeout | hard timeout per class; kills runaways |
| Priority | per class (webhook projection > reports) |
| Retention | completed job rows expire; archive before purge |
| Monitoring | depth, oldest-job age, retry rate, DLQ count |

**Redis introduction triggers (any one, documented evidence required):**

1. multi-node deployment needing shared rate-limit/cache state;
2. sustained queue throughput around **500–1,000 jobs/sec** (Postgres queue write amplification becomes the bottleneck);
3. measured cache-hit win with a hot dataset that does not fit per-node memory;
4. genuine pub/sub fanout requirement.

Redis is **not** introduced because it is fashionable; the trigger evidence is
recorded in an ADR addendum when it fires.

## Alternatives Considered

- BullMQ now (Redis-backed): rejected — adds a service with no current need.
- Managed queues (SQS-class): rejected — hosting/cost/region complexity; no operational fit yet.
- Kafka-class streaming: rejected — absurd for this workload.
- In-process timers (cron-per-app): rejected — recreates the cPanel fragility being escaped.

## Consequences

### Positive
- One fewer service to operate; transactional job+data writes (job enqueued in the same TX as state change — a correctness win Redis queues cannot offer natively).
- Same operational model the team already understands.

### Negative
- Queue load shares Postgres capacity (mitigated by retention + monitoring; escape hatch documented).

## Security Impact

Jobs carry user data → payloads must not contain secrets; worker DB role is
separate and least-privilege (security-policy); DLQ contents are redacted.

## Migration Impact

Ephemeral worker/queue state is NOT migrated (migration-strategy).

## Testing / Verification Requirements

- Failure-injection tests: kill worker mid-job (lease reclaim), duplicate enqueue
  (idempotent convergence), poison payload (DLQ), storm (backoff+jitter verifies no thundering herd).

## Open Questions

1. Final pg-boss version pin (Phase 1).
2. Priority classes list (Phase 1, per capability wave).

## Phase

Phase 0 decision; queue skeleton + alarms = Phase 1.
